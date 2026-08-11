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
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
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
  if (version === 6) return host === "::1" || host.startsWith("::ffff:127.");
  return false;
}

export function lanBindWarning(bindHostname: string): string | null {
  if (isLoopbackHost(bindHostname)) return null;
  return `WARN: binding to HOST=${bindHostname} exposes the dashboard and /api/usage data to anyone on the network (no authentication). To view from another device, use an SSH tunnel: ssh -L 3000:127.0.0.1:3000`;
}

export type LanStartPolicy = "ok" | "warn" | "prompt";

export function lanStartPolicy(bindHostname: string, isTTY: boolean, allowLan: boolean): LanStartPolicy {
  if (lanBindWarning(bindHostname) === null) return "ok";
  if (allowLan) return "warn";
  return isTTY ? "prompt" : "warn";
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

export function createRateLimiter(limit: number, windowMs: number): (key: string, now?: number) => boolean {
  const hits = new Map<string, number[]>();
  return (key: string, now: number = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
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

  // /api/usage は起動時にキャッシュを読み込んでメモリから配信する（リクエスト毎のファイル読込で DoS 面を作らない）
  let usageBody: string | null = null;
  try {
    usageBody = readFileSync(cachePath, "utf-8");
  } catch {
    usageBody = null;
  }

  // rate limit は非ループバック（LAN 公開）時のみ適用する。ローカルは信頼前提の設計
  const lanMode = !isLoopbackHost(hostname);
  const rateLimiter = options.rateLimit ?? (lanMode ? createRateLimiter(120, 60_000) : null);
  const staticCache = new Map<string, ArrayBuffer>();

  const app = async (request: Request, server?: RequestIPProvider): Promise<Response> => {
    if (rateLimiter !== null) {
      const ip = server?.requestIP(request)?.address ?? "unknown";
      if (!rateLimiter(ip)) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: withCommonHeaders({ "content-type": "text/plain; charset=utf-8" }),
        });
      }
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

  const allowedBases = STATIC_PREFIXES.map((prefix) => normalize(join(rootDir, prefix)).replace(/[\\/]+$/, ""));
  if (pathname !== "/" && !isWithinBases(resolved, allowedBases)) {
    return new Response("Not Found", { status: 404 });
  }

  // エクスポート成果物（個人データ埋め込みの単一 HTML）を配信しない。index.html はルート / のみ
  // （大文字小文字の違いでブロックを回避されないよう case-insensitive に比較する）
  if (pathname !== "/" && extensionName(resolved).toLowerCase() === ".html") {
    return new Response("Not Found", { status: 404 });
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
    return new Response("Not Found", { status: 404 });
  }
  if (!isFile) {
    return new Response("Not Found", { status: 404 });
  }

  // symlink が allowlist 外を指している場合は配信しない（realpath で解決して再チェック）
  let real: string;
  try {
    real = realpathSync(resolved);
    const realBases = allowedBases.map((base) => realpathSync(base));
    if (pathname !== "/" && !isWithinBases(real, realBases)) {
      return new Response("Not Found", { status: 404 });
    }
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  const contentType = CONTENT_TYPES[extensionName(resolved)];
  try {
    const body = await Bun.file(resolved).arrayBuffer();
    staticCache.set(resolved, body);
    return new Response(body, {
      status: 200,
      headers: withCommonHeaders({ "content-type": contentType ?? "application/octet-stream" }),
    });
  } catch {
    return new Response("Internal Server Error", { status: 500 });
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
    app.setUsageBody(JSON.stringify(result.data));
  }

  const displayHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  const boundPort = server.port ?? port;
  console.log(`ccusage ledger: http://${displayHost}:${boundPort}`);
  if (result === null) {
    console.warn("WARN: failed to fetch ccusage data and no cache exists. /api/usage will return an empty dataset.");
  } else {
    console.log(`Data source: ${result.source === "fresh" ? "bunx ccusage --json (fresh)" : "cache"}`);
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
