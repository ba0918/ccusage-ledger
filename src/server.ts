import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
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
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  "x-content-type-options": "nosniff",
};

function withCommonHeaders(headers: Record<string, string>): Headers {
  return new Headers({ ...COMMON_HEADERS, ...headers });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function hostAllowed(urlHostname: string, bindHostname: string): boolean {
  // 非ループバック bind（HOST 指定による LAN 公開の明示オプトイン）では Host 検証を適用しない
  if (!LOOPBACK_HOSTS.has(bindHostname)) return true;
  const hostname = urlHostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(hostname);
}

export function createApp(options: { rootDir: string; cachePath: string; hostname?: string }) {
  const { rootDir, cachePath, hostname = "127.0.0.1" } = options;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

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
      if (!existsSync(cachePath)) {
        return new Response(JSON.stringify({ error: "usage data not available" }), {
          status: 404,
          headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }),
        });
      }
      const body = await Bun.file(cachePath).arrayBuffer();
      return new Response(body, {
        status: 200,
        headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }),
      });
    }

    return serveStatic(rootDir, pathname);
  };
}

const STATIC_PREFIXES = ["/dist/", "/public/"];

async function serveStatic(rootDir: string, pathname: string): Promise<Response> {
  // 許可リストは「パス」ではなく「解決後のファイルが配信対象ディレクトリ内にあるか」で判定する
  // （エンコード済み ..%2f で許可リストを迂回され、src/・package.json・.git 等が配信されるのを防ぐ）
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = normalize(join(rootDir, relative));

  const allowedBases = STATIC_PREFIXES.map((prefix) => normalize(join(rootDir, prefix)).replace(/[\\/]+$/, ""));
  const withinAllowed = allowedBases.some((base) => resolved === base || resolved.startsWith(base + "/"));
  if (pathname !== "/" && !withinAllowed) {
    return new Response("Not Found", { status: 404 });
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

  const contentType = CONTENT_TYPES[extensionName(resolved)];
  try {
    const body = await Bun.file(resolved).arrayBuffer();
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

export async function main(): Promise<void> {
  const rootDir = PACKAGE_DIR;
  const cachePath = defaultCachePath(process.env);
  const result = fetchUsage({ command: DEFAULT_COMMAND, cachePath });

  const port = Number(process.env.PORT ?? 3000);
  const hostname = process.env.HOST ?? "127.0.0.1";

  const app = createApp({ rootDir, cachePath, hostname });
  const server = Bun.serve({ hostname, port, fetch: app });

  const displayHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  const boundPort = server.port ?? port;
  console.log(`ccusage ledger: http://${displayHost}:${boundPort}`);
  if (result === null) {
    console.warn("WARN: ccusage データを取得できず、キャッシュもありません。/api/usage は 404 を返します。");
  } else {
    console.log(`データ取得元: ${result.source === "fresh" ? "bunx ccusage --json（新規取得）" : "キャッシュ"}`);
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
