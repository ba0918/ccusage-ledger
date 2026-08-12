import { readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join, normalize } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";

import { fetchUsage, DEFAULT_COMMAND } from "./fetch-usage";
import { PACKAGE_DIR, defaultCachePath } from "./paths";
import { browserUrl, displayHostname, openBrowser, shouldAutoOpen } from "./open-browser";
import { isUsageData, projectUsageData } from "./usage-data";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const COMMON_HEADERS: Record<string, string> = {
  // base-uri 'none': HTML 注入時に <base> で相対 URL 解決を乗っ取られないようにする
  // form-action 'none': フォーム送信先の強制を防ぐ（このアプリはフォーム送信を行わない）
  // style-src 'unsafe-inline': モデル別バーの幅（style="width:N%"）をインライン style で設定しているため。
  //   値は数値のみでデータ由来文字列を挿入しない。CSS 変数 + stylesheet 化すれば外せる（将来課題）
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  // frame-ancestors を無視する古いブラウザ向けの defense-in-depth（CSP だけに依存しない）
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

// LAN 公開時・/api/usage 拒否時に案内する推奨トンネルコマンド（3 箇所で同一文言を使う）。
// ポートは実際の bind ポート（PORT 環境変数）を反映する
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

// ::ffff:x.x.x.x または ::ffff:hhhh:hhhh（末尾 32bit が IPv4）から IPv4 文字列を復元する
function mappedIPv4(host: string): string | null {
  const m = host.match(/^.*:ffff:([0-9a-f.:]+)$/);
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
  // Map は挿入順を保持するため、上限超過時に先頭（最古）から削除できる
  const hits = new Map<string, number[]>();
  const limiter = (key: string, now: number = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    // 大量の source IP で Map が無制限に育たないよう、最古キーから回収する
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

export function createApp(options: {
  rootDir: string;
  cachePath: string;
  hostname?: string;
  port?: number;
  rateLimit?: (key: string) => boolean;
}): AppWithUsage {
  const { rootDir, cachePath, hostname = "127.0.0.1", port = 3000 } = options;

  // /api/usage は起動時にキャッシュを読み込んでメモリから配信する（リクエスト毎のファイル読込で DoS 面を作らない）。
  // 検証 + 白リスト投影を通し、型不一致データや未知フィールドを配信しない
  let usageBody: string | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (isUsageData(parsed)) {
      usageBody = JSON.stringify(projectUsageData(parsed));
    }
  } catch {
    usageBody = null;
  }

  // rate limit は常に適用する。loopback は寛大な上限（600/分）、LAN 公開時はより厳しい上限（120/分）
  // 注意: ループバック bind では全ローカルプロセスが同一 source IP に集約されるため、
  // rate limit は同一マシンの別プロセスによる /api/usage の大量リクエストを止められない
  // （ループバック共有は AGENTS.md で許容した脅威モデル内の残余リスク）
  const lanMode = !isLoopbackHost(hostname);
  const rateLimiter = options.rateLimit ?? createRateLimiter(lanMode ? 120 : 600, 60_000);
  const staticCache = new Map<string, ArrayBuffer>();

  const app = new Hono();

  // rate limit と DNS rebinding 対策は全ルートに適用するミドルウェアで行う。
  // IP は Hono の fetch 第二引数（env）経由で渡される接続情報から解決する
  // （テストは { requestIP } を、Bun/Node の実サーバはサーバ固有の接続情報を env に渡す）
  app.use("*", async (c, next) => {
    const ip = resolveRequestIp(c);
    if (!rateLimiter(ip)) {
      return c.text("Too Many Requests", 429);
    }

    const url = parseUrl(c.req.url);
    if (url === null) {
      return c.json({ error: "bad request" }, 400);
    }

    // DNS rebinding 対策（ループバック bind 時のみ）: リクエストのホストがループバック以外なら拒否
    if (!hostAllowed(url.hostname, hostname)) {
      return c.json({ error: "bad request" }, 400);
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return c.json({ error: "bad request" }, 400);
    }

    c.set("pathname", pathname);
    return next();
  });

  app.get("/api/usage", (_c) => {
    // 非ループバック bind ではデータを配信しない（SSH トンネル経由のループバック接続のみに限定）
    if (!isLoopbackHost(hostname)) {
      return new Response(JSON.stringify({ error: `forbidden: /api/usage is only served over loopback. Use an SSH tunnel: ${sshTunnelHint(port)}` }), {
        status: 403,
        headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }),
      });
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

// ミドルウェアで使う Context の型定義（get/set に pathname を保持する）
declare module "hono" {
  interface ContextVariableMap {
    pathname: string;
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
  return "unknown";
}

const STATIC_PREFIXES = ["/dist/", "/public/"];

export function isWithinBases(target: string, bases: string[]): boolean {
  return bases.some((base) => target === base || target.startsWith(`${base}/`));
}

async function serveStatic(rootDir: string, pathname: string, staticCache: Map<string, ArrayBuffer>): Promise<Response> {
  // 許可リストは「パス」ではなく「解決後のファイルが配信対象ディレクトリ内にあるか」で判定する
  // （エンコード済み ..%2f で許可リストを迂回され、src/・package.json・.git 等が配信されるのを防ぐ）
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = normalize(join(rootDir, relative));

  // 末尾ドット・スペースは Windows で Win32 層により剥がされ、別ファイル（例: .html ブロック回避）に解決され得る
  if (pathname !== "/" && /[. ]$/.test(pathname)) {
    return notFoundResponse();
  }

  const allowedBases = STATIC_PREFIXES.map((prefix) => normalize(join(rootDir, prefix)).replace(/[\\/]+$/, ""));
  if (pathname !== "/" && !isWithinBases(resolved, allowedBases)) {
    return notFoundResponse();
  }

  // エクスポート成果物（個人データ埋め込みの単一 HTML）を配信しない。index.html はルート / のみ
  // （大文字小文字の違いでブロックを回避されないよう case-insensitive に比較する）
  if (pathname !== "/" && extensionName(resolved).toLowerCase() === ".html") {
    return notFoundResponse();
  }

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

  // symlink が allowlist 外を指している場合は配信しない（realpath で解決して再チェック）
  let real: string;
  try {
    real = realpathSync(resolved);
    const realBases = allowedBases.map((base) => realpathSync(base));
    if (pathname !== "/" && !isWithinBases(real, realBases)) {
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

// サーバを bind して実際のポートを返す。Bun / Node どちらのランタイムでも動く
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
  // createApp のミドルウェアが incoming.socket.remoteAddress から IP を解決できる
  const { serve } = await import("@hono/node-server");
  serve(
    {
      hostname,
      port,
      fetch: (request, env) => app(request, env as unknown),
    },
    () => {},
  );
  // Node の serve は options.port で即時 bind するため、実際の port を返す
  return port;
}

export async function main(): Promise<void> {
  const rootDir = PACKAGE_DIR;
  const cachePath = defaultCachePath(process.env);

  const port = Number(process.env.PORT ?? 3000);
  const hostname = process.env.HOST ?? "127.0.0.1";

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
  const boundPort = await startServer(app, hostname, port);

  // bind 後にデータ取得する（最大60s 掛かってもサーバーは起動したまま。取得後はメモリの usageBody を更新）
  const result = await fetchUsage({ command: DEFAULT_COMMAND, cachePath });
  if (result !== null) {
    app.setUsageBody(JSON.stringify(projectUsageData(result.data)));
  }

  console.log(`ccusage ledger: http://${displayHostname(hostname)}:${boundPort}`);
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
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
