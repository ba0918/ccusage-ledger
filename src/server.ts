import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { fetchUsage, DEFAULT_COMMAND } from "./fetch-usage";

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

export function createApp(options: { rootDir: string }) {
  const { rootDir } = options;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
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
      const usagePath = join(rootDir, "data", "usage.json");
      if (!existsSync(usagePath)) {
        return new Response(JSON.stringify({ error: "usage data not available" }), {
          status: 404,
          headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }),
        });
      }
      const body = await Bun.file(usagePath).arrayBuffer();
      return new Response(body, {
        status: 200,
        headers: withCommonHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }),
      });
    }

    return serveStatic(rootDir, pathname);
  };
}

async function serveStatic(rootDir: string, pathname: string): Promise<Response> {
  const normalizedRoot = normalize(rootDir);
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = normalize(join(rootDir, relative));
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + "/")) {
    return new Response("Not Found", { status: 404 });
  }
  if (!existsSync(resolved)) {
    return new Response("Not Found", { status: 404 });
  }

  const file = Bun.file(resolved);
  const contentType = CONTENT_TYPES[extensionName(resolved)];
  const body = await file.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: withCommonHeaders({ "content-type": contentType ?? "application/octet-stream" }),
  });
}

function extensionName(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot) : "";
}

export async function main(): Promise<void> {
  const rootDir = process.cwd();
  const usagePath = join(rootDir, "data", "usage.json");
  const result = fetchUsage({ command: DEFAULT_COMMAND, cachePath: usagePath });

  const port = Number(process.env.PORT ?? 3000);
  const hostname = "127.0.0.1";

  const app = createApp({ rootDir });
  const server = Bun.serve({ hostname, port, fetch: app });

  console.log(`ccusage ledger: http://${hostname}:${server.port}`);
  if (result === null) {
    console.warn("WARN: ccusage データを取得できず、キャッシュもありません。/api/usage は 404 を返します。");
  } else {
    console.log(`データ取得元: ${result.source === "fresh" ? "bunx ccusage --json（新規取得）" : "キャッシュ"}`);
  }
}

if (import.meta.main) {
  void main();
}
