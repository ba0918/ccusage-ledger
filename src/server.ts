import { readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, sep } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";

import { messageOf } from "./errors";
import { fetchUsage, DEFAULT_COMMAND, readCache } from "./fetch-usage";
import { PACKAGE_DIR, defaultCachePath, isUnderBase } from "./paths";
import { browserUrl, displayHostname, openBrowser, shouldAutoOpen } from "./open-browser";
import { projectUsageData } from "./usage-data";

// 静的配信 allowlist（STATIC_ALLOWLIST）が配信するファイルの拡張子だけを持つ。
// allowlist 外の拡張子（.json / .svg / .png / .ico / .mjs 等）を宣言すると死んだ設定になるため、
// 実際に配信される .html / .js / .css に限定する
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const COMMON_HEADERS: Record<string, string> = {
  // base-uri 'none': HTML 注入時に <base> で相対 URL 解決を乗っ取られないようにする
  // form-action 'none': フォーム送信先の強制を防ぐ（このアプリはフォーム送信を行わない）
  // style-src-attr 'unsafe-inline': モデル別バーの幅（style="width:N%"）をインライン style 属性で設定しているため。
  //   style-src-elem（<style> 要素・<link>）には 'unsafe-inline' を与えないことで、注入された <style> ブロック
  //   （属性セレクタ経由のデータ抽出・@import・UI リドレス）を CSP で遮断する。style 属性はセレクタを書けないため
  //   CSS インジェクションの実行面が <style> 要素に限られる。アプリの CSS は public/app.css（外部）に分離済み
  "content-security-policy": "default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  // frame-ancestors を無視する古いブラウザ向けの defense-in-depth（CSP だけに依存しない）
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  // CORS ヘッダは意図的に一切出力しない（セキュリティ境界）。LAN モード + DNS rebinding で
  // /api/usage に到達できた場合でも、Access-Control-Allow-Origin が無ければブラウザは
  // クロスオリジン読み取りを遮断し、CORP: same-origin が no-cors 埋め込みを防ぐ。
  // 将来 CORS を追加する場合は allowlist + Credentials 無しに限定すること（attack-review F4 / F13）
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

// LAN 公開時・/api/usage 拒否時に案内する推奨トンネルコマンド。ポートは実際の bind ポート
// （PORT 環境変数）を反映する。起動時警告・LAN 案内ページ・拒否メッセージが同一文言を使う
function sshTunnelHint(port: number): string {
  return `ssh -L ${port}:127.0.0.1:${port}`;
}

function withCommonHeaders(headers: Record<string, string>): Headers {
  return new Headers({ ...COMMON_HEADERS, ...headers });
}

function notFoundResponse(): Response {
  return new Response("Not Found", { status: 404, headers: withCommonHeaders({}) });
}

// ループバック判定はリテラル集合ではなく IP アドレスとして行う
// （127.0.0.0/8 の別名や ::1 はすべてループバック。HOST=127.0.0.2 等でも検証を有効にする）
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // trailing-dot（127.0.0.1. / localhost.）はループバックとして扱わない。
  // node:net の isIP は現状拒否するが、実装変化に依存せず仕様として明示的に拒否する
  // （URL パーサーが "127.0.0.1." を正規化して通すことがあるため、契約として固定する）
  if (host === "" || host.endsWith(".")) { return false; }
  if (host === "localhost") { return true; }
  const version = isIP(host);
  if (version === 4) { return host.startsWith("127."); }
  if (version === 6) {
    // IPv4-mapped IPv6（::ffff:127.0.0.1 とその canonical 形式 ::ffff:7f00:1）の末尾 32bit が 127.0.0.0/8 かで判定する
    const mapped = mappedIPv4(host);
    if (mapped !== null) { return mapped.startsWith("127."); }
    return host === "::1";
  }
  return false;
}

// ::ffff:x.x.x.x または ::ffff:hhhh:hhhh（末尾 32bit が IPv4）から IPv4 文字列を復元する。
// IPv4-mapped IPv6 の canonical 形式のみを対象とし、:ffff: の前に非ゼロのグループがある
// アドレス（1::ffff:127.0.0.1 や fe80::ffff:7f00:1 等）はマッチさせない
// （非ループバック IPv6 をループバックと誤判定して /api/usage のゲートを迂回させない）
function mappedIPv4(host: string): string | null {
  const m = host.match(/^(?:(?:0:){5}ffff:|::ffff:)([0-9a-f.:]+)$/);
  if (!m) { return null; }
  const tail = m[1]!;
  if (tail.includes(".")) { return tail; }
  const groups = tail.split(":");
  if (groups.length === 1) {
    const value = Number.parseInt(groups[0]!, 16);
    if (!Number.isFinite(value) || value > 0xffff) { return null; }
    return `0.0.${(value >> 8) & 0xff}.${value & 0xff}`;
  }
  if (groups.length === 2) {
    const high = Number.parseInt(groups[0]!, 16);
    const low = Number.parseInt(groups[1]!, 16);
    if (!Number.isFinite(high) || !Number.isFinite(low) || high > 0xffff || low > 0xffff) { return null; }
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return null;
}

export function lanBindWarning(bindHostname: string, port: number): string | null {
  if (isLoopbackHost(bindHostname)) { return null; }
  // 平文 HTTP は同一セグメントの攻撃者が応答を改ざん・盗聴でき、CSP も意味を失うことを明記する
  return `WARN: binding to HOST=${bindHostname} exposes the dashboard and /api/usage data to anyone on the network (no authentication, plaintext HTTP: traffic can be eavesdropped and tampered with). To view from another device, use an SSH tunnel: ${sshTunnelHint(port)}`;
}

export type LanStartPolicy = "ok" | "warn" | "prompt" | "refuse";

export function lanStartPolicy(bindHostname: string, isTTY: boolean, allowLan: boolean): LanStartPolicy {
  if (isLoopbackHost(bindHostname)) { return "ok"; }
  if (allowLan) { return "warn"; }
  // 非 TTY（ヘルプなし起動）では確認プロンプトが効かないため、明示オプトインが無ければ拒否する
  return isTTY ? "prompt" : "refuse";
}

export function isLanAllowed(env: Record<string, string | undefined>): boolean {
  return env.CCUSAGE_LEDGER_ALLOW_LAN === "1" || env.CCUSAGE_LEDGER_ALLOW_LAN === "true";
}

export function hostAllowed(urlHostname: string, bindHostname: string): boolean {
  // 非ループバック bind（HOST 指定による LAN 公開の明示オプトイン）では Host 検証を適用しない
  if (!isLoopbackHost(bindHostname)) { return true; }
  return isLoopbackHost(urlHostname);
}

export function parseUrl(requestUrl: string): URL | null {
  try {
    return new URL(requestUrl);
  } catch {
    return null;
  }
}

export interface RateLimiter {
  (key: string, now?: number): boolean;
  size(): number;
}

export function createRateLimiter(limit: number, windowMs: number, maxKeys: number = 4096): RateLimiter {
  // Map は挿入順を保持する。ヒット時に delete してから set し直すことでアクセス時刻順
  // （LRU 順）に保ち、上限超過時の回収で頻繁にヒットするキーを残す
  const hits = new Map<string, number[]>();
  const limiter = (key: string, now: number = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.delete(key);
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.delete(key);
    hits.set(key, recent);
    // 大量の source IP で Map が無制限に育たないよう、最古（最も使われていない）キーから回収する
    while (hits.size > maxKeys) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) { break; }
      hits.delete(oldest);
    }
    return true;
  };
  return Object.assign(limiter, { size: () => hits.size });
}

export interface AppWithUsage {
  (request: Request, server?: unknown): Promise<Response>;
  setUsageBody(body: string | null): void;
}

// 非ループバック接続（LAN 公開時）にのみ配信する案内ページ。bundle.js 等のクライアント資産を
// ネットワークに配信しないことで、平文 HTTP 上で on-path 攻撃者が改ざん・注入できる JS の
// 攻撃面をなくす（/api/usage も非ループバック接続では配信しないため、LAN からはデータに触れない）
function lanOnlyPage(port: number): string {
  const hint = sshTunnelHint(port);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ccusage Ledger</title>
    <style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#e8eaf0;padding:48px 24px;max-width:640px;margin:0 auto}code{background:#141824;padding:2px 6px;border-radius:6px}pre{background:#141824;padding:14px;border-radius:8px;overflow-x:auto}h1{font-size:20px}li{margin:8px 0}</style>
  </head>
  <body>
    <h1>ccusage Ledger</h1>
    <p>The dashboard is bound to the network. Usage data is only served over loopback connections, so viewing it requires an SSH tunnel:</p>
    <pre>${hint}</pre>
    <p>Then open <code>http://127.0.0.1:${port}</code>.</p>
    <ul>
      <li>An SSH tunnel terminates on loopback, so the connection source is treated as local.</li>
      <li>Plaintext HTTP over the network is intentionally not used for the dashboard.</li>
    </ul>
  </body>
</html>
`;
}

export function createApp(options: {
  rootDir: string;
  cachePath: string;
  hostname?: string;
  port?: number;
  rateLimit?: (key: string) => boolean;
}): AppWithUsage {
  const { rootDir, cachePath, hostname = "127.0.0.1", port = 3000 } = options;

  // /api/usage は起動時にキャッシュを読み込んでメモリから配信する（リクエスト毎のファイル読込で DoS 面を作らない）。
  // 読み込みは fetchUsage の readCache を共用する（所有権・0700・サイズ検証 + スキーマ検証 + 白リスト投影が
  // 1 箇所に集約され、起動時読み込みと fetch フォールバックの安全条件がずれない。fail-closed: 検証失敗は空データ）
  let usageBody: string | null = null;
  const cached = readCache(cachePath);
  if (cached !== null) {
    usageBody = JSON.stringify(cached.data);
  }

  // rate limit は常に適用する。loopback は寛大な上限（static 600/分・/api 300/分）、
  // LAN 公開時はより厳しい上限（static 120/分・/api 60/分）
  // 注意: ループバック bind では全ローカルプロセスが同一 source IP に集約されるため、
  // rate limit は同一マシンの別プロセスによる /api/usage の大量リクエストを止められない
  // （ループバック共有は AGENTS.md で許容した脅威モデル内の残余リスク）
  const lanMode = !isLoopbackHost(hostname);
  // /api/* と静的資産で別々のバケットを使う。静的リソースへの安価なリクエスト洪水で
  // /api/usage の予算が枯渇しないようにする（ドライブバイ DoS の影響低減）
  const defaultApiLimit = lanMode ? 60 : 300;
  const defaultStaticLimit = lanMode ? 120 : 600;
  const apiLimiter = createRateLimiter(defaultApiLimit, 60_000);
  const staticLimiter = createRateLimiter(defaultStaticLimit, 60_000);
  const userLimiter = options.rateLimit;
  const limitRequest = (key: string, isApi: boolean): boolean => {
    if (userLimiter) { return userLimiter(key); }
    return isApi ? apiLimiter(key) : staticLimiter(key);
  };
  const staticCache = new Map<string, ArrayBuffer>();

  const app = new Hono();

  // ハンドラから例外が漏れた場合も共通セキュリティヘッダ付きの 500 を返す（CSP なしのエラーページを返さない）
  // Hono の ErrorHandler は (error, context) の順で呼ばれる。引数を取り違えると
  // Context を messageOf に渡すことになり、500 の原因がログから判らなくなる
  app.onError((error, _c) => {
    console.error(`ERROR: unhandled server error: ${messageOf(error)}`);
    return new Response("Internal Server Error", { status: 500, headers: withCommonHeaders({}) });
  });

  // rate limit と DNS rebinding 対策は全ルートに適用するミドルウェアで行う。
  // IP は Hono の fetch 第二引数（env）経由で渡される接続情報から解決する
  // （テストは { requestIP } を、Bun/Node の実サーバはサーバ固有の接続情報を env に渡す）
  app.use("*", async (c, next) => {
    const url = parseUrl(c.req.url);
    if (url === null) {
      return badRequest();
    }

    // 巨大なパスはデコード・分類の前に拒否する（decodeURIComponent と startsWith の
    // コストを一定に保つ。上限は実用上十分な長さ。attack-review F16）
    if (url.pathname.length > MAX_PATH_LENGTH) {
      return badRequest();
    }

    // どのエンドポイントもリクエストボディを読まないため、Content-Length が上限を
    // 超えるリクエストはハンドラ到達前に 413 で拒否する（巨大ボディのメモリ消費を防ぐ。
    // chunked など Content-Length 無しのボディはランタイムの上限に委ねる。attack-review F8）
    const contentLength = c.req.header("content-length");
    const parsedLength = contentLength === undefined ? NaN : Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_REQUEST_BODY_BYTES) {
      return payloadTooLarge();
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return badRequest();
    }

    // Hono はパスセグメントをデコードしてルーティングするため、/api 判定・rate limit の
    // バケット分類もデコード後のパスで行う（/%61pi/usage 等のパーセントエンコードで
    // /api/usage のゲートや API バケットを迂回できないようにする）
    const isApiPath = pathname.startsWith("/api/");

    const ip = resolveRequestIp(c);

    // DNS rebinding 対策: リクエストのホストがループバック以外なら拒否する。
    // /api/* は loopback 専用配信のため、bind モードに関係なく Host はループバックを要求する。
    // LAN モードでは hostAllowed が無条件 true になり Host 検証が効かなくなるため、
    // DNS rebinding ページ（Host: attacker.example → 127.0.0.1 への同一オリジン fetch）が
    // 全履歴を読めるのを防ぐのがこの分岐（attack-review F1）
    if (isApiPath) {
      if (!isLoopbackHost(url.hostname)) {
        return badRequest();
      }
    } else if (!hostAllowed(url.hostname, hostname)) {
      return badRequest();
    }

    // /api/* は接続元 IP がループバックのときのみ配信する。bind ホスト名ではなく接続の実 source IP で
    // 判定するため、ポート転送・リバーストンネルで届く非ループバック接続はここで 403 になる。
    // （bind がループバックでも防御は維持され、SSH トンネル経由のループバック接続は通る）
    if (isApiPath && !isLoopbackHost(ip)) {
      return apiForbidden();
    }

    // rate limit は「安価な検証で拒否されたリクエストの後」に適用する。Host 検証（400）や
    // /api ゲート（403）が先に走るため、悪意ある Web ページの DNS-rebinding ループが
    // 被害者自身の rate limit 予算を消費して正当なダッシュボードを 429 にできる
    // ドライブバイ自己 DoS（F7）を起こせない。拒否済みリクエストは予算を消費しない。
    // キーは (source IP, Host) のペアにする。ループバック bind では全リクエストが同一 IP に
    // 集約されるため、Host をキーに含めて DNS-rebinding ページ（Host: attacker.example）と
    // ユーザー自身のリクエスト（Host: 127.0.0.1）のバケットを分離する（attack-review F5。
    // Host: 127.0.0.1 の img ループによる共有バケット枯渇は残余リスクとして AGENTS.md に記載）
    if (!limitRequest(rateLimitKey(ip, url.hostname), isApiPath)) {
      return tooManyRequests();
    }

    c.set("pathname", pathname);
    c.set("clientIp", ip);
    return next();
  });

  app.get("/api/usage", (c) => {
    // ミドルウェアが同じゲートを適用済みだが、パス分類（decodeURIComponent + startsWith）と
    // Hono のルーティングが将来ずれた場合に備えて、配信元をハンドラ自身でも再検証する
    // （シングルポイント化せず defense-in-depth を維持。attack-review F15）
    if (!isLoopbackHost(c.get("clientIp"))) {
      return apiForbidden();
    }
    if (usageBody === null) {
      // キャッシュなしでも 200 で空データを返す（キャッシュ有無を 404/200 で判別させない）
      return new Response(JSON.stringify({ daily: [], monthly: [] }), {
        status: 200,
        headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }),
      });
    }
    return new Response(usageBody, {
      status: 200,
      headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }),
    });
  });

  app.all("*", (c) => {
    // 非ループバック接続（LAN 公開時）には案内ページのみ配信し、クライアント資産を配らない。
    // ループバック接続（ローカル + SSH トンネル）は通常のダッシュボードを配信する
    if (!isLoopbackHost(c.get("clientIp"))) {
      return lanOnlyResponse(port, c.get("pathname"));
    }
    return serveStatic(rootDir, c.get("pathname"), staticCache);
  });

  // Hono の fetch(request, env) はテストの app(request, server) 契約（第二引数に接続情報）と一致する。
  // fetch は同期 Response を返し得るため async で wrap して Promise<Response> に揃える
  const handler = async (request: Request, server?: unknown): Promise<Response> => {
    return app.fetch(request, server);
  };
  return Object.assign(handler, {
    setUsageBody(body: string | null): void {
      usageBody = body;
    },
  }) as unknown as AppWithUsage;
}

function badRequest(): Response {
  // 400 も共通セキュリティヘッダを付けて返す（フレーム化・MIME スニッフィング防止の defense-in-depth）
  return new Response(JSON.stringify({ error: "bad request" }), {
    status: 400,
    headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8" }),
  });
}

// 非ループバック接続への応答。トンネル案内ページは " / " のみに配信し、それ以外のパスは 404
// （クライアント資産を LAN に配らない）。CSP はこの案内ページ用に個別設定する:
// script を持たずインライン style のみのため、style-src を許可する
// （共通 CSP の style-src 'self' がページ自身の <style> を止めないように）
function lanOnlyResponse(port: number, pathname: string): Response {
  if (pathname !== "/") {
    return notFoundResponse();
  }
  return new Response(lanOnlyPage(port), {
    status: 200,
    headers: withCommonHeaders({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    }),
  });
}

// どのエンドポイントもリクエストボディを読まないため、この上限で十分（4KB）。
// 巨大ボディは Content-Length の段階で 413 にする（attack-review F8）
const MAX_REQUEST_BODY_BYTES = 4096;

// デコード前のパス長上限。allowlist のパスは全て短いため、実用上十分な長さ（attack-review F16）
const MAX_PATH_LENGTH = 4096;

// rate limit のキー。ループバック bind では全リクエストが同一 source IP に集約されるため、
// Host をキーに含めて DNS-rebinding ページ（Host: attacker.example）のリクエストと
// ユーザー自身のリクエスト（Host: 127.0.0.1）のバケットを分離する（attack-review F5）
function rateLimitKey(ip: string, hostname: string): string {
  return `${ip}|${hostname}`;
}

function tooManyRequests(): Response {
  return new Response("Too Many Requests", {
    status: 429,
    headers: withCommonHeaders({}),
  });
}

function payloadTooLarge(): Response {
  return new Response("Payload Too Large", {
    status: 413,
    headers: withCommonHeaders({}),
  });
}

function apiForbidden(): Response {
  // ボディはエンドポイント名・bind ポート・トンネルコマンドを一切含めない generic な文言のみ
  // （LAN スキャナーへの情報漏出を避ける。SSH トンネルの案内は起動時コンソール出力と
  // LAN 案内ページで行う。attack-review F7）
  return new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }),
  });
}

// ミドルウェアで使う Context の型定義（get/set に pathname / clientIp を保持する）
declare module "hono" {
  interface ContextVariableMap {
    pathname: string;
    clientIp: string;
  }
}

// 接続元 IP を Context の env から解決する。優先順位:
// 1. テストが渡す { requestIP(request) }（AppWithUsage の第二引数互換）
// 2. Bun サーバが渡す server.requestIP(request)
// 3. Node の @hono/node-server が渡す incoming.socket.remoteAddress
interface ConnInfoEnv {
  requestIP?: (request: Request) => { address: string } | null;
  server?: { requestIP?: (request: Request) => { address: string } | null };
  incoming?: { socket?: { remoteAddress?: string } };
}
function resolveRequestIp(c: Context): string {
  const env = c.env as ConnInfoEnv;
  if (env?.requestIP) {
    const ip = env.requestIP(c.req.raw);
    if (ip) { return ip.address; }
  }
  if (env?.server?.requestIP) {
    const ip = env.server.requestIP(c.req.raw);
    if (ip) { return ip.address; }
  }
  if (env?.incoming?.socket?.remoteAddress) {
    return env.incoming.socket.remoteAddress;
  }
  // IP を解決できないリクエストは単一の固定キーに集約する。unique キーだと rate limit を
  // 素通りし、Map の最古キー回収（maxKeys 超過時）で他クライアントのバケットを追い出せる
  // （unresolved リクエストによる rate-limit リセット）。実運用では Bun/Node が必ず接続 IP を
  // 提供するためこの分岐は通常到達しない。ループバック判定で false になるため /api/* は
  // fail-closed で拒否される
  return "unresolved";
}

// 配信するのはブラウザが必要とする固定ファイルのみ。URL からパスを組み立てないため、
// パストラバーサル・hardlink / symlink による許可リスト外ファイルの配信（F3 / F12）、
// サーバ CLI バンドル等の予期しない成果物の漏出（F15）を構造的に防ぐ。
// また未知パスへの同期 FS アクセス（statSync / realpathSync）を生まない（F13）
const STATIC_ALLOWLIST: Record<string, string> = {
  "/": "index.html",
  "/dist/bundle.js": "dist/bundle.js",
  "/public/vendor/chart.umd.min.js": "public/vendor/chart.umd.min.js",
  "/public/app.css": "public/app.css",
};

// 配下判定はプラットフォームのパス区切りで行う。"/" 決め打ちにすると Windows（区切りが "\"）で
// 常に「配下ではない」と判定され、静的ファイルがすべて 404 になる。
// 判定規則そのものは paths.ts の isUnderBase に集約している（キャッシュディレクトリの検証と共通）
export function isWithinBases(target: string, bases: string[], separator: string = sep): boolean {
  return bases.some((base) => isUnderBase(target, base, { separator }));
}

async function serveStatic(rootDir: string, pathname: string, staticCache: Map<string, ArrayBuffer>): Promise<Response> {
  const relative = STATIC_ALLOWLIST[pathname];
  if (relative === undefined) {
    return notFoundResponse();
  }
  const resolved = join(rootDir, relative);

  // 一度読んだファイルはキャッシュから配信する（再読込・存在チェックでファイルシステムに触れない）
  const cached = staticCache.get(resolved);
  if (cached !== undefined) {
    return new Response(cached, {
      status: 200,
      headers: withCommonHeaders({ "content-type": CONTENT_TYPES[extensionName(resolved)] ?? "application/octet-stream" }),
    });
  }

  let isFile: boolean;
  try {
    isFile = statSync(resolved).isFile();
  } catch {
    return notFoundResponse();
  }
  if (!isFile) {
    return notFoundResponse();
  }

  // symlink が許可対象外（そのファイルの属するディレクトリの外）を指している場合は配信しない。
  // 固定 allowlist でも dist/bundle.js がルート直下の秘密ファイルへの symlink に差し替えられた場合を防ぐ
  let real: string;
  try {
    real = realpathSync(resolved);
    const realBase = realpathSync(dirname(resolved));
    if (!isWithinBases(real, [realBase])) {
      return notFoundResponse();
    }
  } catch {
    return notFoundResponse();
  }

  const contentType = CONTENT_TYPES[extensionName(resolved)];
  try {
    // realpath で検証した実体パスを開いて読む（check と read の間で resolved が symlink に
    // すり替わる TOCTOU を避け、real が検証済みの場所を指すことを保証する）。
    // 同期読込のため、検証と読込の間にパスが差し替わる競合面を持たない
    const body = readFileSync(real);
    const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    staticCache.set(resolved, buffer);
    return new Response(buffer, {
      status: 200,
      headers: withCommonHeaders({ "content-type": contentType ?? "application/octet-stream" }),
    });
  } catch {
    return new Response("Internal Server Error", { status: 500, headers: withCommonHeaders({}) });
  }
}

function extensionName(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot) : "";
}

function confirmLanStart(): boolean {
  const buf = new Uint8Array(64);
  let n = 0;
  try {
    n = readSync(0, buf);
  } catch {
    return false;
  }
  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// ランタイム判定: Bun 実行時のみ process.versions.bun が存在する
function isBun(): boolean {
  return process.versions.bun !== undefined;
}

// bind 失敗の原因が設定で直せるものなら、直し方まで含めて伝える。
// EADDRINUSE は「別プロセスが使用中」以外に、Windows の予約済みポート範囲や
// WSL の localhost forwarding でも起きるため、ポート変更の案内を添える
export function bindError(error: Error, port: number): Error {
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") { return error; }
  return new Error(
    `port ${port} is already in use. Use --port to listen on a different port (e.g. --port ${port + 1}). ` +
      "On Windows the port can also be blocked by a reserved port range " +
      "(check: netsh interface ipv4 show excludedportrange protocol=tcp) or by a WSL process.",
  );
}

// サーバを bind して実際のポートを返す。Bun / Node どちらのランタイムでも動く。
// bind 失敗の案内文言への変換は呼び出し側（main）で 1 回だけ行う。Bun は同期 throw、
// Node は error イベントと通知経路が違うが、async 関数の拒否として同じ形で表に出るため、
// ここでランタイムごとに包み直す必要はない
async function startServer(app: AppWithUsage, hostname: string, port: number): Promise<number> {
  if (isBun()) {
    const server = Bun.serve({
      hostname,
      port,
      // Bun サーバが接続情報（requestIP を含む）を fetch の第二引数で提供する
      fetch: (request, server) => app(request, server as unknown),
    });
    return server.port ?? port;
  }

  // Node 実行時: @hono/node-server で起動する。serve が env に { incoming, outgoing } を渡すため、
  // createApp のミドルウェアが incoming.socket.remoteAddress から IP を解決できる。
  // bind エラー（EADDRINUSE 等）は Node では非同期に飛ぶため、Promise で待ち受けて
  // Bun の同期 throw と同じく呼び出し側の拒否として扱えるようにする
  const { serve } = await import("@hono/node-server");
  return new Promise<number>((resolve, reject) => {
    let listening = false;
    const server = serve(
      {
        hostname,
        port,
        fetch: (request, env) => app(request, env as unknown),
      },
      // 実際に bind されたポートを返す（PORT=0 での自動採番にも対応する）
      (info) => {
        listening = true;
        resolve(info.port);
      },
    );
    server.on("error", (error: Error) => {
      // bind 後のサーバーエラーで reject しても解決済みで無視されるため、起動後は明示的に
      // ログへ出す（error リスナーがある間 Node は throw しないので、黙って消える）
      if (listening) {
        console.error(`ERROR: server error: ${messageOf(error)}`);
        return;
      }
      reject(error);
    });
  });
}

// 既定ポート。3000 は React / Next / Rails 等の開発サーバーが使う最も競合しやすい番号で、
// 初回起動がいきなり EADDRINUSE になりやすい。IANA の well-known / 一般的な開発用ポートを
// 避け、Windows の動的ポート範囲（既定 49152-65535）にも入らない番号を既定にする
export const DEFAULT_PORT = 3737;

export type PortSource = "--port" | "PORT" | "default";

// 1..65535 の整数文字列のみ受け付ける。Number() 直読みだと PORT=abc が NaN になり、
// bind 失敗が「判りにくいエラー」になるため、設定ミスを起動時に明確なメッセージで報告する
// （cli.ts の catch が `ERROR: <message>` を出力して exit 1 する）。
// 既定値の適用は resolvePort だけが行う（両方が既定値を持つと、どちらが決めたのか読めなくなる）。
// source を持ち回るのは、--port で指定したのに "Invalid PORT=..." と言われて
// 原因を取り違えるのを防ぐため
export function parsePort(value: string, source: PortSource = "PORT"): number {
  const invalid = new Error(`Invalid ${source}=${value}: expected an integer between 1 and 65535`);
  if (!/^\d+$/.test(value)) { throw invalid; }
  const port = Number(value);
  if (port < 1 || port > 65535) { throw invalid; }
  return port;
}

export interface ResolvedPort {
  port: number;
  source: PortSource;
}

// ポート番号と「どこで決まったか」を同時に返す。優先順位は --port > PORT > 既定値。
// 判定と値の計算を分けると両者が食い違い得るため（空文字の PORT を「既定値」と判定しながら
// parsePort("") を呼んで Invalid PORT= で落ちる、という不整合が実際に起きた）、1 箇所で決める
export function resolvePort(cliPort: string | undefined, envPort: string | undefined): ResolvedPort {
  if (cliPort !== undefined) { return { port: parsePort(cliPort, "--port"), source: "--port" }; }
  // 空文字は未設定と同等に扱う（シェルで PORT= と書いた場合に起動できないのを避ける）
  if (envPort !== undefined && envPort !== "") { return { port: parsePort(envPort), source: "PORT" }; }
  return { port: DEFAULT_PORT, source: "default" };
}

// 起動ログに付ける決定元の表示。既定値のときは何も付けない（通常の起動を煩わせない）。
// 「既定を変えたはずなのに違うポートで起動している」ときに、環境変数の残存や
// --port の指定を即座に見分けられるようにする
export function portSourceLabel(source: PortSource): string {
  if (source === "default") { return ""; }
  return `  (port from ${source})`;
}

export interface CliOptions {
  port?: string;
  help: boolean;
}

export const USAGE = `Usage: ccusage-ledger [options]

Options:
  -p, --port <number>  Port to listen on (default: ${DEFAULT_PORT}, env: PORT)
  -h, --help           Show this help

Environment:
  HOST                       Bind address (default: 127.0.0.1)
  PORT                       Port to listen on (overridden by --port)
  CCUSAGE_LEDGER_ALLOW_LAN   Set to 1 to allow a non-loopback bind`;

// 引数解析。未知のフラグは黙って無視せずエラーにする（打ち間違いに気づけるようにする）。
// --name=value の分解はオプション個別ではなくループ先頭で行う。長いオプション一般の
// 書き方であって --port 固有の性質ではないため、オプションを増やしたときに
// 「= 形式だけ対応が漏れる」事故を構造的に防ぐ
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const equals = arg.indexOf("=");
    const name = arg.startsWith("--") && equals !== -1 ? arg.slice(0, equals) : arg;
    const inlineValue = arg.startsWith("--") && equals !== -1 ? arg.slice(equals + 1) : undefined;

    if (name === "--help" || name === "-h") {
      options.help = true;
      continue;
    }
    if (name === "--port" || name === "-p") {
      // 値が別トークンの場合だけ次を読み進める（--port --help のように次がフラグなら拒否する）
      const value = inlineValue ?? argv[i + 1];
      // --port= のように = の後ろが空の場合も「値が無い」として扱う
      if (value === undefined || value === "" || (inlineValue === undefined && value.startsWith("-"))) {
        throw new Error(`${name} requires a value (e.g. ${name} ${DEFAULT_PORT})`);
      }
      options.port = value;
      if (inlineValue === undefined) { i++; }
      continue;
    }
    throw new Error(`Unknown option: ${name} (run with --help for usage)`);
  }
  return options;
}

// HOST は IP リテラルまたはホスト名のみ受け付ける。bind に渡す値がそのまま browserUrl →
// openBrowser（xdg-open / open への URL 引数）に流れるため、シェルメタ文字や URL を
// 壊す文字を事前に弾く（parsePort と対称の設定ミス検出。bind 失敗の「判りにくいエラー」を防ぎ、
// 意図しない URL がブラウザ起動に渡るのを防ぐ）。[A-Za-z0-9.:-] 以外（IPv6 の括弧、シェル
// メタ文字、空白等）は拒否する
export function parseHostname(value: string | undefined): string {
  const raw = value ?? "127.0.0.1";
  if (raw === "" || !/^[A-Za-z0-9.:-]+$/.test(raw)) {
    throw new Error(`Invalid HOST=${raw}: expected an IP literal or hostname (allowed: [A-Za-z0-9.:-])`);
  }
  return raw;
}

export async function main(): Promise<void> {
  const rootDir = PACKAGE_DIR;
  const cachePath = defaultCachePath(process.env);

  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    console.log(USAGE);
    return;
  }
  // 優先順位: --port > PORT > 既定値。指定元をエラーメッセージと起動ログに反映する
  const { port, source: portSource } = resolvePort(cli.port, process.env.PORT);
  // HOST は IP リテラル/ホスト名以外を起動時に拒否する（browserUrl → openBrowser に流れるため）。
  // bind 失敗の「判りにくいエラー」より先に、設定ミスを明確なメッセージで報告する
  const hostname = parseHostname(process.env.HOST);

  const lanPolicy = lanStartPolicy(hostname, Boolean(process.stdin.isTTY), isLanAllowed(process.env));
  if (lanPolicy === "refuse") {
    console.error(
      `ERROR: HOST=${hostname} (non-loopback bind) would expose the dashboard and usage data to the network. ` +
        "Set CCUSAGE_LEDGER_ALLOW_LAN=1 to override, or use a loopback bind with an SSH tunnel: " +
        sshTunnelHint(port),
    );
    process.exit(1);
  }
  if (lanPolicy === "prompt") {
    const warning = lanBindWarning(hostname, port)!;
    console.warn(warning);
    process.stdout.write("Start anyway? (y/N): ");
    if (!confirmLanStart()) {
      console.error("Aborted. Set HOST to a loopback address, or set CCUSAGE_LEDGER_ALLOW_LAN=1 to start without confirmation.");
      process.exit(1);
    }
  } else if (lanPolicy === "warn") {
    console.warn(lanBindWarning(hostname, port)!);
  }

  const app = createApp({ rootDir, cachePath, hostname, port });

  // bind する。Bun 実行時は Bun.serve（requestIP を提供）、Node 実行時は @hono/node-server を使う
  // bind 失敗はランタイムを問わずここで案内文言に変換する（Bun / Node で 2 箇所に散らさない）
  const boundPort = await startServer(app, hostname, port).catch((error: unknown) => {
    throw bindError(error instanceof Error ? error : new Error(String(error)), port);
  });

  // ループバック TCP ポートは同一マシンの全ローカルユーザー/プロセスから閲覧できる。
  // 共有マシンでは他のローカルユーザーが /api/usage の全履歴を読めるため、その旨を起動時に警告する
  // （認証は意図的に実装していない。境界は「画面に届ける人」の制限で担保する設計。AGENTS.md 参照）
  if (isLoopbackHost(hostname)) {
    console.warn(
      "NOTE: the dashboard is bound to loopback and is readable by any local user/process on this machine. " +
        "On a shared machine this exposes your ccusage usage data to other local users.",
    );
  }

  // bind 後にデータ取得する（最大60s 掛かってもサーバーは起動したまま。取得後はメモリの usageBody を更新）。
  // fresh のときだけ usageBody を差し替える。cache フォールバック時は createApp が起動時に
  // 同じ readCache で既に読み込んでいるため、重複読み込み・再設定をしない
  const result = await fetchUsage({ command: DEFAULT_COMMAND, cachePath });
  if (result !== null && result.source === "fresh") {
    app.setUsageBody(JSON.stringify(projectUsageData(result.data)));
  }

  console.log(`ccusage ledger: http://${displayHostname(hostname)}:${boundPort}${portSourceLabel(portSource)}`);
  if (result === null) {
    console.warn("WARN: failed to fetch ccusage data and no cache exists. /api/usage will return an empty dataset.");
  } else {
    console.log(`Data source: ${result.source === "fresh" ? "ccusage cli.js (fresh)" : "cache"}`);
  }

  const autoOpenEnv = {
    SSH_CONNECTION: process.env.SSH_CONNECTION,
    SSH_TTY: process.env.SSH_TTY,
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    isTTY: Boolean(process.stdout.isTTY),
    platform: process.platform,
  };
  if (shouldAutoOpen(autoOpenEnv)) {
    openBrowser(browserUrl(hostname, boundPort));
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`ERROR: ${messageOf(error)}`);
    process.exit(1);
  });
}
