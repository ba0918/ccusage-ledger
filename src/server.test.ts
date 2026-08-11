import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp, createRateLimiter, isLanAllowed, isLoopbackHost, isWithinBases, lanBindWarning, lanStartPolicy, parseUrl } from "./server";

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

  test("cachePath のファイルが無い場合は 200 で空データを返す（存在オラクルにしない）", async () => {
    rmSync(cachePath);
    const res = await get("/api/usage");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ daily: [], monthly: [] });
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
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("静的レスポンスにクロスオリジン・プライバシーヘッダを付与する", async () => {
    const res = await get("/");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toContain("geolocation=()");
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

  test("不正な URL のリクエストは 400 を返す（500 にしない）", async () => {
    const app = createApp({ rootDir, cachePath });
    const request = new Request("http://127.0.0.1/");
    Object.defineProperty(request, "url", { value: "http://[", configurable: true });
    const res = await app(request);
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

  test("配信対象ディレクトリ内の .html（エクスポート成果物）は配信しない", async () => {
    writeFileSync(join(rootDir, "dist", "ccusage-ledger.html"), "<html>embedded data</html>");
    const res = await get("/dist/ccusage-ledger.html");
    expect(res.status).toBe(404);
  });

  test("大文字小文字の異なる .HTML エクスポート成果物も配信しない", async () => {
    writeFileSync(join(rootDir, "dist", "CCUSAGE-LEDGER.HTML"), "<html>embedded data</html>");
    const res = await get("/dist/CCUSAGE-LEDGER.HTML");
    expect(res.status).toBe(404);
  });

  test("静的配信は一度読み込んだ内容をキャッシュし、ファイルを再読込しない", async () => {
    const app = createApp({ rootDir, cachePath });
    const first = await app(new Request("http://127.0.0.1/dist/bundle.js"));
    expect(first.status).toBe(200);
    rmSync(join(rootDir, "dist", "bundle.js"));
    const second = await app(new Request("http://127.0.0.1/dist/bundle.js"));
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("console.log");
  });

  test("rate limiter を超えたリクエストは 429 を返す", async () => {
    let count = 0;
    const app = createApp({
      rootDir,
      cachePath,
      hostname: "0.0.0.0",
      rateLimit: () => ++count <= 2,
    });
    const r1 = await app(new Request("http://192.168.1.10/"));
    const r2 = await app(new Request("http://192.168.1.10/"));
    const r3 = await app(new Request("http://192.168.1.10/"));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
  });

  test("ループバック bind では rate limit を適用しない", async () => {
    const app = createApp({ rootDir, cachePath });
    const r1 = await app(new Request("http://127.0.0.1/"));
    const r2 = await app(new Request("http://127.0.0.1/"));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

describe("server createRateLimiter", () => {
  test("ウィンドウ内の上限を超えると false を返す", () => {
    const limiter = createRateLimiter(2, 1000);
    expect(limiter("a", 1000)).toBe(true);
    expect(limiter("a", 1100)).toBe(true);
    expect(limiter("a", 1200)).toBe(false);
  });

  test("キー別にカウントし、ウィンドウ経過でリセットされる", () => {
    const limiter = createRateLimiter(1, 1000);
    expect(limiter("a", 1000)).toBe(true);
    expect(limiter("b", 1100)).toBe(true);
    expect(limiter("a", 3000)).toBe(true);
  });
});

describe("server isWithinBases", () => {
  test("基底内のパスは true", () => {
    expect(isWithinBases("/root/dist/bundle.js", ["/root/dist", "/root/public"])).toBe(true);
    expect(isWithinBases("/root/dist", ["/root/dist"])).toBe(true);
  });

  test("基底外のパスは false", () => {
    expect(isWithinBases("/root/src/server.ts", ["/root/dist", "/root/public"])).toBe(false);
    expect(isWithinBases("/root/dist-other/x", ["/root/dist"])).toBe(false);
  });
});

describe("server parseUrl", () => {
  test("正しい URL は URL を返す", () => {
    expect(parseUrl("http://127.0.0.1/")?.hostname).toBe("127.0.0.1");
  });

  test("不正な URL は null を返す（throw しない）", () => {
    expect(parseUrl("http://[")).toBeNull();
    expect(parseUrl("not a url")).toBeNull();
  });
});

describe("server isLoopbackHost", () => {
  test("ループバック IP と localhost は true", () => {
    for (const host of ["localhost", "127.0.0.1", "127.0.0.2", "127.255.255.255", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("非ループバックのホストは false", () => {
    for (const host of ["0.0.0.0", "192.168.1.10", "::", "evil.example.com", "::ffff:192.168.1.10"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
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

  test("ループバック別名（HOST=127.0.0.2）でも非ループバックのホストは 400 を返す", async () => {
    const app = createApp({ rootDir, cachePath, hostname: "127.0.0.2" });
    const res = await app(new Request("http://evil.example.com/"));
    expect(res.status).toBe(400);
  });
});

describe("server LAN bind 警告", () => {
  test("ループバック bind では警告しない", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(lanBindWarning(host)).toBeNull();
    }
  });

  test("非ループバック bind では警告を返す", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10"]) {
      expect(lanBindWarning(host)).toContain("WARN");
    }
  });
});

describe("server LAN bind 起動ポリシー", () => {
  test("ループバック bind は確認も警告もしない", () => {
    expect(lanStartPolicy("127.0.0.1", true, false)).toBe("ok");
    expect(lanStartPolicy("localhost", false, false)).toBe("ok");
  });

  test("非ループバック bind + TTY では確認を求める", () => {
    expect(lanStartPolicy("0.0.0.0", true, false)).toBe("prompt");
  });

  test("非ループバック bind + 非 TTY では警告のみ", () => {
    expect(lanStartPolicy("0.0.0.0", false, false)).toBe("warn");
    expect(lanStartPolicy("192.168.1.10", false, false)).toBe("warn");
  });

  test("非ループバック bind + 明示オプトインでは警告のみ", () => {
    expect(lanStartPolicy("0.0.0.0", true, true)).toBe("warn");
    expect(lanStartPolicy("0.0.0.0", false, true)).toBe("warn");
  });
});

describe("server LAN 公開オプトイン環境変数", () => {
  test("CCUSAGE_LEDGER_ALLOW_LAN の値で判定する", () => {
    expect(isLanAllowed({})).toBe(false);
    expect(isLanAllowed({ CCUSAGE_LEDGER_ALLOW_LAN: "0" })).toBe(false);
    expect(isLanAllowed({ CCUSAGE_LEDGER_ALLOW_LAN: "1" })).toBe(true);
    expect(isLanAllowed({ CCUSAGE_LEDGER_ALLOW_LAN: "true" })).toBe(true);
  });
});
