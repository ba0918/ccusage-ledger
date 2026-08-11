import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "./server";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "usage.json"), "utf-8");

let rootDir: string;
let cachePath: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "ccusage-server-"));
  cachePath = join(rootDir, "cache", "usage.json");
  mkdirSync(dirname(cachePath), { recursive: true });
  mkdirSync(join(rootDir, "dist"), { recursive: true });
  mkdirSync(join(rootDir, "public", "vendor"), { recursive: true });
  writeFileSync(join(rootDir, "index.html"), "<!doctype html><title>ccusage</title>");
  writeFileSync(join(rootDir, "dist", "bundle.js"), "console.log('bundle');");
  writeFileSync(join(rootDir, "public", "vendor", "chart.umd.min.js"), "// chart.js");
  writeFileSync(join(rootDir, "secret.txt"), "TOP-SECRET");
  writeFileSync(cachePath, FIXTURE);
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

async function get(path: string): Promise<Response> {
  const app = createApp({ rootDir, cachePath });
  return app(new Request(`http://127.0.0.1${path}`));
}

describe("server /api/usage", () => {
  test("cachePath の内容を application/json で返す", async () => {
    const res = await get("/api/usage");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe(FIXTURE);
  });

  test("cachePath のファイルが無い場合は 404 を返す", async () => {
    rmSync(cachePath);
    const res = await get("/api/usage");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "usage data not available" });
  });

  test("/api/usage は cache-control: no-store を返す", async () => {
    const res = await get("/api/usage");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("/api/usage は起動時に読み込んだ内容を配信し、ファイルを再読込しない", async () => {
    const app = createApp({ rootDir, cachePath });
    rmSync(cachePath);
    const res = await app(new Request("http://127.0.0.1/api/usage"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FIXTURE);
  });
});

describe("server 静的配信", () => {
  test("index.html を text/html で返す", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("ccusage");
  });

  test("dist/bundle.js を text/javascript で返す", async () => {
    const res = await get("/dist/bundle.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("console.log");
  });

  test("public/vendor の Chart.js を返す", async () => {
    const res = await get("/public/vendor/chart.umd.min.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("chart.js");
  });

  test("存在しないパスは 404 を返す", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
  });

  test("静的レスポンスに CSP ヘッダを付与する", async () => {
    const res = await get("/");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});

describe("server セキュリティ", () => {
  test("パストラバーサルは 404 を返す", async () => {
    const res = await get("/../../etc/passwd");
    expect(res.status).toBe(404);
  });

  test("壊れたパーセントエンコーディングは 400 を返す", async () => {
    const res = await get("/%%");
    expect(res.status).toBe(400);
  });

  test("プロジェクトルート直下のファイルは配信しない（許可リスト）", async () => {
    for (const path of ["/src/server.ts", "/package.json", "/.git/config", "/data/usage.json", "/AGENTS.md"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
    }
  });

  test("静的配信は許可リスト内のみ 200 を返す", async () => {
    const res = await get("/dist/bundle.js");
    expect(res.status).toBe(200);
  });

  test("エンコード済みパストラバーサル（..%2f）は許可リスト外のファイルを配信しない", async () => {
    for (const path of [
      "/dist/..%2fsecret.txt",
      "/dist/..%2fsrc%2fserver.ts",
      "/dist/..%2f.git%2fconfig",
      "/dist/%2e%2e%2fsecret.txt",
      "/dist%2f..%2fsecret.txt",
    ]) {
      const res = await get(path);
      expect(res.status).toBe(404);
    }
  });

  test("ディレクトリへの要求は 404 を返す（500 にしない）", async () => {
    const res = await get("/dist");
    expect(res.status).toBe(404);
    const res2 = await get("/dist/..%2fpublic");
    expect(res2.status).toBe(404);
  });
});

describe("server Host 検証（DNS rebinding 対策）", () => {
  test("ループバック bind 時に非ループバックのホストは 400 を返す", async () => {
    const app = createApp({ rootDir, cachePath });
    const res = await app(new Request("http://evil.example.com/"));
    expect(res.status).toBe(400);
  });

  test("ループバック bind 時に localhost / 127.0.0.1 のホストは許可する", async () => {
    const app = createApp({ rootDir, cachePath });
    const localhost = await app(new Request("http://localhost/"));
    expect(localhost.status).toBe(200);
    const loopback = await app(new Request("http://127.0.0.1/"));
    expect(loopback.status).toBe(200);
  });

  test("LAN bind（0.0.0.0）ではホスト検証を適用しない", async () => {
    const app = createApp({ rootDir, cachePath, hostname: "0.0.0.0" });
    const res = await app(new Request("http://192.168.1.10/"));
    expect(res.status).toBe(200);
  });
});
