import { readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join, normalize } from "node:path";
import type { Server } from "bun";

interface RequestIPProvider {
  requestIP(request: Request): { address: string } | null;
}
import { fetchUsage, DEFAULT_COMMAND } from "./fetch-usage";
import { PACKAGE_DIR, defaultCachePath } from "./paths";
import { browserUrl, openBrowser, shouldAutoOpen } from "./open-browser";
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
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function withCommonHeaders(headers: Record<string, string>): Headers {
  return new Headers({ ...COMMON_HEADERS, ...headers });
}

// ループバック判定はリテラル集合ではなく IP アドレスとして行う
// （127.0.0.0/8 の別名や ::1 はすべてループバック。HOST=127.0.0.2 等でも検証を有効にする）
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost") return true;
  const version = isIP(host);
  if (version === 4) return host.startsWith("127.");
  if (version === 6) {
    // IPv4-mapped IPv6（::ffff:127.0.0.1 とその canonical 形式 ::ffff:7f00:1）の末尾 32bit が 127.0.0.0/8 かで判定する
    const mapped = mappedIPv4(host);
    if (mapped !== null) return mapped.startsWith("127.");
    return host === "::1";
  }
  return false;
}

// ::ffff:x.x.x.x または ::ffff:hhhh:hhhh（末尾 32bit が IPv4）から IPv4 文字列を復元する
function mappedIPv4(host: string): string | null {
  const m = host.match(/^.*:ffff:([0-9a-f.:]+)$/);
  if (!m) return null;
  const tail = m[1]!;
  if (tail.includes(".")) return tail;
  const groups = tail.split(":");
  if (groups.length === 1) {
    const value = Number.parseInt(groups[0]!, 16);
    if (!Number.isFinite(value) || value > 0xffff) return null;
    return `0.0.${(value >> 8) & 0xff}.${value & 0xff}`;
  }
  if (groups.length === 2) {
    const high = Number.parseInt(groups[0]!, 16);
    const low = Number.parseInt(groups[1]!, 16);
    if (!Number.isFinite(high) || !Number.isFinite(low) || high > 0xffff || low > 0xffff) return null;
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return null;
}

export function lanBindWarning(bindHostname: string): string | null {
  if (isLoopbackHost(bindHostname)) return null;
  // 平文 HTTP は同一セグメントの攻撃者が応答を改ざん・盗聴でき、CSP も意味を失うことを明記する
  return `WARN: binding to HOST=${bindHostname} exposes the dashboard and /api/usage data to anyone on the network (no authentication, plaintext HTTP: traffic can be eavesdropped and tampered with). To view from another device, use an SSH tunnel: ssh -L 3000:127.0.0.1:3000`;
}

export type LanStartPolicy = "ok" | "warn" | "prompt" | "refuse";

export function lanStartPolicy(bindHostname: string, isTTY: boolean, allowLan: boolean): LanStartPolicy {
  if (lanBindWarning(bindHostname) === null) return "ok";
  if (allowLan) return "warn";
  // 非 TTY（ヘルプなし起動）では確認プロンプトが効かないため、明示オプトインが無ければ拒否する
  return isTTY ? "prompt" : "refuse";
}

export function isLanAllowed(env: Record<string, string | undefined>): boolean {
  return env.CCUSAGE_LEDGER_ALLOW_LAN === "1" || env.CCUSAGE_LEDGER_ALLOW_LAN === "true";
}

export function hostAllowed(urlHostname: string, bindHostname: string): boolean {
  // 非ループバック bind（HOST 指定による LAN 公開の明示オプトイン）では Host 検証を適用しない
  if (!isLoopbackHost(bindHostname)) return true;
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
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
    return true;
  };
  return Object.assign(limiter, { size: () => hits.size });
}

export interface AppWithUsage {
  (request: Request, server?: RequestIPProvider): Promise<Response>;
  setUsageBody(body: string | null): void;
}

export function createApp(options: {
  rootDir: string;
  cachePath: string;
  hostname?: string;
  rateLimit?: (key: string) => boolean;
}): AppWithUsage {
  const { rootDir, cachePath, hostname = "127.0.0.1" } = options;

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
  const lanMode = !isLoopbackHost(hostname);
  const rateLimiter = options.rateLimit ?? createRateLimiter(lanMode ? 120 : 600, 60_000);
  const staticCache = new Map<string, ArrayBuffer>();

  const app = async (request: Request, server?: RequestIPProvider): Promise<Response> => {
    const ip = server?.requestIP(request)?.address ?? "unknown";
    if (!rateLimiter(ip)) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: withCommonHeaders({ "content-type": "text/plain; charset=utf-8" }),
      });
    }

    const url = parseUrl(request.url);
    if (url === null) {
      return new Response(JSON.stringify({ error: "bad request" }), {
        status: 400,
        headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8" }),
      });
    }

    // DNS rebinding 対策（ループバック bind 時のみ）: リクエストのホストがループバック以外なら拒否
    if (!hostAllowed(url.hostname, hostname)) {
      return new Response(JSON.stringify({ error: "bad request" }), {
        status: 400,
        headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8" }),
      });
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response(JSON.stringify({ error: "bad request" }), {
        status: 400,
        headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8" }),
      });
    }

    if (pathname === "/api/usage") {
      // 非ループバック bind ではデータを配信しない（SSH トンネル経由のループバック接続のみに限定）
      if (!isLoopbackHost(hostname)) {
        return new Response(JSON.stringify({ error: "forbidden: /api/usage is only served over loopback. Use an SSH tunnel: ssh -L 3000:127.0.0.1:3000" }), {
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
    }

    return serveStatic(rootDir, pathname, staticCache);
  };

  return Object.assign(app, {
    setUsageBody(body: string | null): void {
      usageBody = body;
    },
  });
}

const STATIC_PREFIXES = ["/dist/", "/public/"];

export function isWithinBases(target: string, bases: string[]): boolean {
  return bases.some((base) => target === base || target.startsWith(base + "/"));
}

async function serveStatic(rootDir: string, pathname: string, staticCache: Map<string, ArrayBuffer>): Promise<Response> {
  // 許可リストは「パス」ではなく「解決後のファイルが配信対象ディレクトリ内にあるか」で判定する
  // （エンコード済み ..%2f で許可リストを迂回され、src/・package.json・.git 等が配信されるのを防ぐ）
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = normalize(join(rootDir, relative));

  // 末尾ドット・スペースは Windows で Win32 層により剥がされ、別ファイル（例: .html ブロック回避）に解決され得る
  if (pathname !== "/" && /[. ]$/.test(pathname)) {
    return new Response("Not Found", { status: 404, headers: withCommonHeaders({}) });
  }

  const allowedBases = STATIC_PREFIXES.map((prefix) => normalize(join(rootDir, prefix)).replace(/[\\/]+$/, ""));
  if (pathname !== "/" && !isWithinBases(resolved, allowedBases)) {
    return new Response("Not Found", { status: 404, headers: withCommonHeaders({}) });
  }

  // エクスポート成果物（個人データ埋め込みの単一 HTML）を配信しない。index.html はルート / のみ
  // （大文字小文字の違いでブロックを回避されないよう case-insensitive に比較する）
  if (pathname !== "/" && extensionName(resolved).toLowerCase() === ".html") {
    return new Response("Not Found", { status: 404, headers: withCommonHeaders({}) });
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
    return new Response("Not Found", { status: 404, headers: withCommonHeaders({}) });
  }
  if (!isFile) {
    return new Response("Not Found", { status: 404, headers: withCommonHeaders({}) });
  }

  // symlink が allowlist 外を指している場合は配信しない（realpath で解決して再チェック）
  let real: string;
  try {
    real = realpathSync(resolved);
    const realBases = allowedBases.map((base) => realpathSync(base));
    if (pathname !== "/" && !isWithinBases(real, realBases)) {
      return new Response("Not Found", { status: 404, headers: withCommonHeaders({}) });
    }
  } catch {
    return new Response("Not Found", { status: 404, headers: withCommonHeaders({}) });
  }

  const contentType = CONTENT_TYPES[extensionName(resolved)];
  try {
    // realpath で検証した実体パスを開いて読む（check と read の間で resolved が symlink に
    // すり替わる TOCTOU を避け、real が検証済みの場所を指すことを保証する）
    const body = await Bun.file(real).arrayBuffer();
    staticCache.set(resolved, body);
    return new Response(body, {
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

export async function main(): Promise<void> {
  const rootDir = PACKAGE_DIR;
  const cachePath = defaultCachePath(process.env);

  const port = Number(process.env.PORT ?? 3000);
  const hostname = process.env.HOST ?? "127.0.0.1";

  const lanPolicy = lanStartPolicy(hostname, Boolean(process.stdin.isTTY), isLanAllowed(process.env));
  if (lanPolicy === "refuse") {
    console.error(
      `ERROR: HOST=${hostname} (non-loopback bind) would expose the dashboard and usage data to the network. ` +
        "Set CCUSAGE_LEDGER_ALLOW_LAN=1 to override, or use a loopback bind with an SSH tunnel: ssh -L 3000:127.0.0.1:3000",
    );
    process.exit(1);
  }
  if (lanPolicy === "prompt") {
    const warning = lanBindWarning(hostname)!;
    console.warn(warning);
    process.stdout.write("Start anyway? (y/N): ");
    if (!confirmLanStart()) {
      console.error("Aborted. Set HOST to a loopback address, or set CCUSAGE_LEDGER_ALLOW_LAN=1 to start without confirmation.");
      process.exit(1);
    }
  } else if (lanPolicy === "warn") {
    console.warn(lanBindWarning(hostname)!);
  }

  const app = createApp({ rootDir, cachePath, hostname });
  const server = Bun.serve({ hostname, port, fetch: app });

  // bind 後にデータ取得する（最大60s 掛かってもサーバーは起動したまま。取得後はメモリの usageBody を更新）
  const result = await fetchUsage({ command: DEFAULT_COMMAND, cachePath });
  if (result !== null) {
    app.setUsageBody(JSON.stringify(projectUsageData(result.data)));
  }

  const displayHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  const boundPort = server.port ?? port;
  console.log(`ccusage ledger: http://${displayHost}:${boundPort}`);
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
  void main();
}
