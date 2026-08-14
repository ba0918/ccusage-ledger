import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, linkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_PORT, bindError, createApp, createRateLimiter, isLanAllowed, isLoopbackHost, isWithinBases, lanBindWarning, lanStartPolicy, parseArgs, parsePort, parseUrl, parseHostname, portSourceLabel, resolvePort, type AppWithUsage } from "./server";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "usage.json"), "utf-8");

let rootDir: string;
let cachePath: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "ccusage-server-"));
  cachePath = join(rootDir, "cache", "usage.json");
  // キャッシュディレクトリは実運用と同じく自分所有 0700 で作る（assertSafeCacheDir の前提）
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  mkdirSync(join(rootDir, "dist"), { recursive: true });
  mkdirSync(join(rootDir, "public", "vendor"), { recursive: true });
  writeFileSync(join(rootDir, "index.html"), "<!doctype html><title>ccusage</title>");
  writeFileSync(join(rootDir, "public", "app.css"), "body { color: #000; }");
  writeFileSync(join(rootDir, "dist", "bundle.js"), "console.log('bundle');");
  writeFileSync(join(rootDir, "public", "vendor", "chart.umd.min.js"), "// chart.js");
  writeFileSync(join(rootDir, "secret.txt"), "TOP-SECRET");
  writeFileSync(cachePath, FIXTURE);
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

// 実サーバの接続情報を模す（Bun の requestIP 相当）。source IP はループバックで与える
function appEnv(ip: string): { requestIP: () => { address: string } } {
  return { requestIP: () => ({ address: ip }) };
}

async function get(path: string, ip = "127.0.0.1"): Promise<Response> {
  const app = createApp({ rootDir, cachePath });
  return app(new Request(`http://127.0.0.1${path}`), appEnv(ip));
}

async function call(app: AppWithUsage, path: string, ip = "127.0.0.1"): Promise<Response> {
  return app(new Request(`http://127.0.0.1${path}`), appEnv(ip));
}

describe("server /api/usage", () => {
  test("cachePath の内容を application/json で返す", async () => {
    const res = await get("/api/usage");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const expected = { ...JSON.parse(FIXTURE) };
    delete expected.totals;
    expect(await res.json()).toEqual(expected);
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
    const res = await call(app, "/api/usage");
    expect(res.status).toBe(200);
    const expected = { ...JSON.parse(FIXTURE) };
    delete expected.totals;
    expect(await res.json()).toEqual(expected);
  });

  test("LAN bind（非ループバック）の非ループバック接続には /api/usage を配信しない", async () => {
    const app = createApp({ rootDir, cachePath, hostname: "0.0.0.0" });
    const res = await call(app, "/api/usage", "192.168.1.10");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("LAN bind でもループバック接続（SSH トンネル）からは /api/usage を配信する", async () => {
    const app = createApp({ rootDir, cachePath, hostname: "0.0.0.0" });
    const res = await call(app, "/api/usage", "127.0.0.1");
    expect(res.status).toBe(200);
    expect((await res.json() as { daily: unknown[] }).daily.length).toBeGreaterThan(0);
  });

  test("LAN bind でも /api/usage はループバック Host を要求する（DNS rebinding 対策）", async () => {
    // LAN モードでは非 /api パスの Host 検証を無効化するが、/api/* は loopback 専用配信のため
    // 全 bind モードで Host がループバックであることを要求する。DNS rebinding ページが
    // 127.0.0.1 への同一オリジン fetch で全履歴を読めるのを防ぐ（attack-review F1）
    const app = createApp({ rootDir, cachePath, hostname: "0.0.0.0" });
    const res = await app(new Request("http://attacker.example/api/usage"), appEnv("127.0.0.1"));
    expect(res.status).toBe(400);
  });

  test("パーセントエンコードした /api/usage（/%61pi/usage）もループバック以外の接続には配信しない", async () => {
    // Hono はパスセグメントをデコードしてルーティングするため、エンコードでゲートを迂回できない
    const app = createApp({ rootDir, cachePath, hostname: "0.0.0.0" });
    for (const path of ["/%61pi/usage", "/%61pi/%75sage", "/%61p%69/usage", "/api%2fusage"]) {
      const res = await call(app, path, "192.168.1.10");
      expect(res.status).toBe(403);
    }
  });

  test("ループバックからパーセントエンコードした /api/usage は配信する（Hono のデコードルーティング経由）", async () => {
    const app = createApp({ rootDir, cachePath });
    const res = await call(app, "/%61pi/usage", "127.0.0.1");
    expect(res.status).toBe(200);
    expect((await res.json() as { daily: unknown[] }).daily.length).toBeGreaterThan(0);
  });

  test("403 は generic ボディを返し、bind ポート・トンネルコマンド・エンドポイント名を含めない", async () => {
    const app = createApp({ rootDir, cachePath, hostname: "0.0.0.0", port: 5000 });
    const res = await call(app, "/api/usage", "192.168.1.10");
    const body = await res.json() as { error: string };
    expect(body.error).toBe("forbidden");
    expect(JSON.stringify(body)).not.toContain("ssh");
    expect(JSON.stringify(body)).not.toContain("5000");
    expect(JSON.stringify(body)).not.toContain("api");
  });

  test("スキーマ外のフィールドは /api/usage で配信しない（curated projection）", async () => {
    const raw = JSON.parse(FIXTURE);
    raw.daily[0].agent = "all";
    raw.totals = { totalCost: 999 };
    writeFileSync(cachePath, JSON.stringify(raw));
    const app = createApp({ rootDir, cachePath });
    const res = await call(app, "/api/usage");
    const body = await res.json() as { daily: Record<string, unknown>[]; totals?: unknown };
    expect(body.daily[0]!.agent).toBeUndefined();
    expect(body.totals).toBeUndefined();
  });

  test("起動時に読み込んだキャッシュがスキーマ不一致なら空データを返す", async () => {
    writeFileSync(cachePath, JSON.stringify({ daily: "not-array", monthly: [] }));
    const app = createApp({ rootDir, cachePath });
    const res = await call(app, "/api/usage");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ daily: [], monthly: [] });
  });

  test("キャッシュディレクトリが 0700 でない場合はキャッシュを読み込まない（read 側の fail-closed）", async () => {
    // write 側と対称に、read 側も所有権・0700 を検証してから読む。0755 なら空データ扱い
    chmodSync(dirname(cachePath), 0o755);
    const app = createApp({ rootDir, cachePath });
    const res = await call(app, "/api/usage");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ daily: [], monthly: [] });
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

  test("public/app.css を text/css で返す", async () => {
    const res = await get("/public/app.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toContain("color: #000");
  });

  test("存在しないパスは 404 を返す", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
  });

  test("静的レスポンスに CSP ヘッダを付与する", async () => {
    const res = await get("/");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("CSP に base-uri 'none' と form-action 'none' を含む", async () => {
    const res = await get("/");
    expect(res.headers.get("content-security-policy")).toContain("base-uri 'none'");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'none'");
  });

  test("CSP は style-src-attr のみに unsafe-inline を許し、style-src（<style> 要素）には含めない", async () => {
    const res = await get("/");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).not.toContain("style-src 'self' 'unsafe-inline'");
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
    const res = await app(request, appEnv("127.0.0.1"));
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

  test("404 レスポンスにも共通セキュリティヘッダを付与する", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
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

  test("サーバ CLI バンドル（dist/ccusage-ledger.js）は配信しない", async () => {
    writeFileSync(join(rootDir, "dist", "ccusage-ledger.js"), "#!/usr/bin/env bun\n");
    const res = await get("/dist/ccusage-ledger.js");
    expect(res.status).toBe(404);
  });

  test("末尾にドット・スペースの付いた .html は 404 を返す（Windows の trailing-dot 迂回対策）", async () => {
    writeFileSync(join(rootDir, "dist", "ccusage-ledger.html"), "<html>embedded data</html>");
    const resDot = await get("/dist/ccusage-ledger.html.");
    expect(resDot.status).toBe(404);
    const resSpace = await get("/dist/ccusage-ledger.html%20");
    expect(resSpace.status).toBe(404);
  });

  test("固定 allowlist のため、hardlink を仕掛けても許可リスト外のファイルは配信できない", async () => {
    // 攻撃者が dist/ に秘密ファイルの hardlink を作っても、allowlist に無いパスは 404
    linkSync(join(rootDir, "secret.txt"), join(rootDir, "dist", "leak"));
    const res = await get("/dist/leak");
    expect(res.status).toBe(404);
  });

  test("静的配信は一度読み込んだ内容をキャッシュし、ファイルを再読込しない", async () => {
    const app = createApp({ rootDir, cachePath });
    const first = await call(app, "/dist/bundle.js");
    expect(first.status).toBe(200);
    rmSync(join(rootDir, "dist", "bundle.js"));
    const second = await call(app, "/dist/bundle.js");
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("console.log");
  });

  test("symlink が許可リスト内（同ディレクトリ内）を指す場合、読む直前に差し替えても配信する（TOCTOU 対策）", async () => {
    const bundle = join(rootDir, "dist", "bundle.js");
    const realTarget = join(rootDir, "dist", "bundle.js.real");
    writeFileSync(realTarget, "console.log('bundle');");
    rmSync(bundle);
    symlinkSync(realTarget, bundle);
    const app = createApp({ rootDir, cachePath });
    const res = await call(app, "/dist/bundle.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("bundle");
  });

  test("末尾がバックスラッシュのファイルへの symlink は配信しない（POSIX の区切り誤判定）", async () => {
    // POSIX では "\\" は正当なファイル名文字。配下判定が両方の区切りを剥がすと
    // rootDir/"dist\\"（dist ディレクトリの外にある兄弟ファイル）が rootDir/dist と
    // 一致してしまい、allowlist されたパスで外のファイルを配信できてしまう
    const sibling = join(rootDir, "dist\\");
    writeFileSync(sibling, "TOP-SECRET-SIBLING");
    rmSync(join(rootDir, "dist", "bundle.js"));
    symlinkSync(sibling, join(rootDir, "dist", "bundle.js"));

    const res = await get("/dist/bundle.js");
    expect(res.status).toBe(404);
  });

  test("symlink が許可リスト外（ルート直下の秘密ファイル）を指す場合は 404", async () => {
    rmSync(join(rootDir, "dist", "bundle.js"));
    symlinkSync(join(rootDir, "secret.txt"), join(rootDir, "dist", "bundle.js"));
    const res = await get("/dist/bundle.js");
    expect(res.status).toBe(404);
  });

  test("rate limiter を超えたリクエストは 429 を返す", async () => {
    let count = 0;
    const app = createApp({
      rootDir,
      cachePath,
      hostname: "0.0.0.0",
      rateLimit: () => ++count <= 2,
    });
    const r1 = await call(app, "/", "192.168.1.10");
    const r2 = await call(app, "/", "192.168.1.10");
    const r3 = await call(app, "/", "192.168.1.10");
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
  });

  test("ループバック bind でも rate limit を適用する（presence oracle の濫用防止）", async () => {
    let count = 0;
    const app = createApp({
      rootDir,
      cachePath,
      rateLimit: () => ++count <= 2,
    });
    const r1 = await call(app, "/");
    const r2 = await call(app, "/");
    const r3 = await call(app, "/");
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
  });

  test("ループバック bind のデフォルト static rate limit は寛大な上限（600/分）を使う", async () => {
    const app = createApp({ rootDir, cachePath });
    const statuses: number[] = [];
    for (let i = 0; i < 601; i++) {
      const res = await call(app, "/");
      statuses.push(res.status);
    }
    expect(statuses[599]).toBe(200);
    expect(statuses[600]).toBe(429);
  });

  test("/api/usage は静的リソースと別の rate limit バケットを持つ（静的洪水で枯渇しない）", async () => {
    // /api/usage のデフォルト上限（ループバック 300/分）を超えても、静的リソースは別バケットで配信される
    const app = createApp({ rootDir, cachePath });
    const statuses: number[] = [];
    for (let i = 0; i < 301; i++) {
      const res = await call(app, "/api/usage");
      statuses.push(res.status);
    }
    expect(statuses[299]).toBe(200);
    expect(statuses[300]).toBe(429);
    const staticRes = await call(app, "/dist/bundle.js");
    expect(staticRes.status).toBe(200);
  });

  test("IP を解決できないリクエストは /api/usage を配信しない（fail-closed）", async () => {
    // 実サーバは常に接続元 IP を解決できる。解決できない場合は unique キーで扱われ
    // ループバック判定に落ちないため /api/* は拒否される
    const app = createApp({ rootDir, cachePath });
    const res = await app(new Request("http://127.0.0.1/api/usage"));
    expect(res.status).toBe(403);
  });

  test("Host 拒否（DNS rebinding）されるリクエストは rate limit の予算を消費しない（ドライブバイ自己 DoS 防止）", async () => {
    // rate limit を Host 検証より先に実行すると、悪意ある Web ページのバックグラウンドループが
    // 被害者自身のループバック予算を食い尽くして 429 にできる。Host 拒否は予算を消費せずに
    // 400 を返すべき（F7）
    let apiCalls = 0;
    const app = createApp({
      rootDir,
      cachePath,
      rateLimit: () => { apiCalls++; return true; },
    });
    for (let i = 0; i < 20; i++) {
      const res = await app(new Request("http://evil.example.com/api/usage"), appEnv("127.0.0.1"));
      expect(res.status).toBe(400);
    }
    // Host 拒否された 20 リクエストが rateLimit に一切触れないことを検証する
    expect(apiCalls).toBe(0);
  });

  test("/api ループバックゲートで 403 になる非ループバック接続は rate limit の予算を消費しない", async () => {
    let apiCalls = 0;
    const app = createApp({
      rootDir,
      cachePath,
      hostname: "0.0.0.0",
      rateLimit: () => { apiCalls++; return true; },
    });
    for (let i = 0; i < 20; i++) {
      const res = await call(app, "/api/usage", "192.168.1.10");
      expect(res.status).toBe(403);
    }
    expect(apiCalls).toBe(0);
  });

  test("rate limit キーは source IP と Host のペア（Host 別のリクエストは別バケット）", async () => {
    // ループバック bind では全リクエストが同一 source IP に集約されるため、キーに Host を
    // 含めて DNS-rebinding ページ（Host: attacker.example）がユーザーの予算と別バケットになる。
    // 同一 (IP, Host) のリクエストは同じバケットを使う（attack-review F5）
    const keys: string[] = [];
    const app = createApp({ rootDir, cachePath, rateLimit: (key) => { keys.push(key); return true; } });
    await app(new Request("http://127.0.0.1/"), appEnv("127.0.0.1"));
    await app(new Request("http://localhost/"), appEnv("127.0.0.1"));
    await app(new Request("http://127.0.0.1/"), appEnv("192.168.1.10"));
    expect(keys).toEqual(["127.0.0.1|127.0.0.1", "127.0.0.1|localhost", "192.168.1.10|127.0.0.1"]);
  });

  test("Content-Length が大きすぎるリクエストは 413 を返す（ボディ上限）", async () => {
    // どのエンドポイントもボディを読まないため、巨大ボディは不要なメモリ消費になるだけ。
    // Content-Length ヘッダの段階で拒否する（attack-review F8）
    const app = createApp({ rootDir, cachePath });
    const request = new Request("http://127.0.0.1/", {
      method: "POST",
      headers: { "content-length": "5000" },
      body: "x",
    });
    const res = await app(request, appEnv("127.0.0.1"));
    expect(res.status).toBe(413);
  });

  test("極端に長いパスはデコード前に 400 を返す（パス長上限）", async () => {
    // decodeURIComponent の前に長さを検証し、巨大なパスによるデコード・比較コストを抑える
    const app = createApp({ rootDir, cachePath });
    const longPath = `/${"a".repeat(9000)}`;
    const res = await app(new Request(`http://127.0.0.1${longPath}`), appEnv("127.0.0.1"));
    expect(res.status).toBe(400);
  });

  test("どのレスポンスにも Access-Control-Allow-Origin を含めない（CORS 不在の不変条件）", async () => {
    // LAN モード + DNS rebinding で /api/usage に到達できた場合でも、ACAO が無ければ
    // ブラウザはクロスオリジン読み取りを遮断する。CORS ヘッダ追加が回帰で起きないことを
    // 機械的に検証する（attack-review F4 / F13）
    const app = createApp({ rootDir, cachePath, hostname: "0.0.0.0" });
    const paths = ["/api/usage", "/", "/dist/bundle.js", "/nope"];
    for (const path of paths) {
      const res = await app(new Request(`http://127.0.0.1${path}`, {
        headers: { origin: "https://evil.example" },
      }), appEnv("127.0.0.1"));
      expect(res.headers.get("access-control-allow-origin"), path).toBeNull();
    }
    const forbidden = await app(new Request("http://127.0.0.1/api/usage"), appEnv("192.168.1.10"));
    expect(forbidden.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("server LAN 案内ページ", () => {
  test("LAN bind の非ループバック接続には案内ページを返し、クライアント資産は配信しない", async () => {
    const app = createApp({ rootDir, cachePath, hostname: "0.0.0.0" });
    const page = await call(app, "/", "192.168.1.10");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("SSH tunnel");
    const bundle = await call(app, "/dist/bundle.js", "192.168.1.10");
    expect(bundle.status).toBe(404);
    const chart = await call(app, "/public/vendor/chart.umd.min.js", "192.168.1.10");
    expect(chart.status).toBe(404);
  });

  test("port を省略したときの案内ページは既定ポートを示す", async () => {
    // createApp の既定値が DEFAULT_PORT とずれると、案内ページの ssh コマンドが
    // 実際には繋がらないポートを案内する（既定ポート変更時に取り残された経緯がある）
    const app = createApp({ rootDir, cachePath, hostname: "0.0.0.0" });
    const page = await call(app, "/", "192.168.1.10");
    expect(await page.text()).toContain(`ssh -L ${DEFAULT_PORT}:127.0.0.1:${DEFAULT_PORT}`);
  });

  test("LAN bind のループバック接続（SSH トンネル）には通常のダッシュボードを配信する", async () => {
    const app = createApp({ rootDir, cachePath, hostname: "0.0.0.0" });
    const page = await call(app, "/", "127.0.0.1");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ccusage");
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

  test("大量のキーを登録してもメモリが無制限に増えない（キー回収）", () => {
    const limiter = createRateLimiter(1, 1000);
    for (let i = 0; i < 10_000; i++) {
      limiter(`key-${i}`, 1000);
    }
    // 上限（例: 4096 キー）を超えたら古いキーが回収される
    const hits = (limiter as { size: () => number }).size();
    expect(hits).toBeLessThanOrEqual(4096);
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

  test("Windows のパス区切り（\\）でも配下判定が機能する", () => {
    // "/" 決め打ちで比較すると Windows では常に false になり、静的ファイルが
    // すべて 404 になってダッシュボードが表示できなくなる
    const base = "C:\\Users\\u\\node_modules\\ccusage-ledger";
    expect(isWithinBases(`${base}\\dist\\bundle.js`, [`${base}\\dist`], "\\")).toBe(true);
    expect(isWithinBases(`${base}\\index.html`, [base], "\\")).toBe(true);
    expect(isWithinBases(base, [base], "\\")).toBe(true);
  });

  test("Windows でも前方一致の取り違えを起こさない", () => {
    expect(isWithinBases("C:\\root\\dist-other\\x", ["C:\\root\\dist"], "\\")).toBe(false);
    expect(isWithinBases("C:\\root\\src\\server.ts", ["C:\\root\\dist"], "\\")).toBe(false);
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

  test("IPv4-mapped IPv6 の canonical 形式（::ffff:7f00:1）もループバックとして判定する", () => {
    for (const host of ["::ffff:7f00:1", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("非ループバックのホストは false", () => {
    for (const host of ["0.0.0.0", "192.168.1.10", "::", "evil.example.com", "::ffff:192.168.1.10"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test("末尾にドットが付いたホストはループバックとして扱わない（trailing-dot は明示的に拒否）", () => {
    // node:net の isIP は現状 trailing-dot を拒否するが、isIP の実装変化に依存せず
    // 仕様として明示的に拒否する（URL パーサーは "127.0.0.1." を正規化して通すため、
    // この関数に到達する前に解決されることもあるが、単体契約として固定する）
    for (const host of ["127.0.0.1.", "::1.", "localhost.", "127.0.0.2."]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test(":ffff:127.x で終わる非ループバック IPv6 はループバックと誤判定しない（IPv4-mapped のみ対象）", () => {
    // プレフィックスに非ゼロのグループを含むアドレスは IPv4-mapped ではないため false
    for (const host of ["1::ffff:127.0.0.1", "2001:db8::ffff:7f00:1", "fe80::ffff:7f00:1", "0:0:0:0:1:ffff:7f00:1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
    // canonical な IPv4-mapped loopback は引き続き true
    for (const host of ["::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });
});

describe("server Host 検証（DNS rebinding 対策）", () => {
  test("ループバック bind 時に非ループバックのホストは 400 を返す", async () => {
    const app = createApp({ rootDir, cachePath });
    const res = await app(new Request("http://evil.example.com/"), appEnv("127.0.0.1"));
    expect(res.status).toBe(400);
  });

  test("ループバック bind 時に localhost / 127.0.0.1 のホストは許可する", async () => {
    const app = createApp({ rootDir, cachePath });
    const localhost = await app(new Request("http://localhost/"), appEnv("127.0.0.1"));
    expect(localhost.status).toBe(200);
    const loopback = await app(new Request("http://127.0.0.1/"), appEnv("127.0.0.1"));
    expect(loopback.status).toBe(200);
  });

  test("LAN bind（0.0.0.0）ではホスト検証を適用しない", async () => {
    const app = createApp({ rootDir, cachePath, hostname: "0.0.0.0" });
    const res = await app(new Request("http://192.168.1.10/"), appEnv("192.168.1.10"));
    expect(res.status).toBe(200);
  });

  test("ループバック別名（HOST=127.0.0.2）でも非ループバックのホストは 400 を返す", async () => {
    const app = createApp({ rootDir, cachePath, hostname: "127.0.0.2" });
    const res = await app(new Request("http://evil.example.com/"), appEnv("127.0.0.1"));
    expect(res.status).toBe(400);
  });
});

describe("server LAN bind 警告", () => {
  test("ループバック bind では警告しない", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      expect(lanBindWarning(host, 3000)).toBeNull();
    }
  });

  test("非ループバック bind では警告を返す", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10"]) {
      expect(lanBindWarning(host, 3000)).toContain("WARN");
    }
  });

  test("非ループバック bind の警告に平文 HTTP の盗聴・改ざんリスクを明記する", () => {
    for (const host of ["0.0.0.0", "192.168.1.10"]) {
      const warning = lanBindWarning(host, 3000)!;
      expect(warning.toLowerCase()).toContain("plaintext");
      expect(warning.toLowerCase()).toContain("tamper");
      expect(warning.toLowerCase()).toContain("ssh tunnel");
    }
  });

  test("警告の SSH トンネル案内に実際の bind ポートを使う", () => {
    const warning = lanBindWarning("0.0.0.0", 5000)!;
    expect(warning).toContain("ssh -L 5000:127.0.0.1:5000");
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

  test("非ループバック bind + 非 TTY + 非オプトインでは起動を拒否する（fail-closed）", () => {
    expect(lanStartPolicy("0.0.0.0", false, false)).toBe("refuse");
    expect(lanStartPolicy("192.168.1.10", false, false)).toBe("refuse");
  });

  test("非ループバック bind + 非 TTY + 明示オプトインでは警告のみ", () => {
    expect(lanStartPolicy("0.0.0.0", false, true)).toBe("warn");
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

describe("server parseHostname", () => {
  test("有効な HOST（IP リテラル / localhost / ホスト名）はそのまま返す", () => {
    expect(parseHostname(undefined)).toBe("127.0.0.1");
    expect(parseHostname("0.0.0.0")).toBe("0.0.0.0");
    expect(parseHostname("127.0.0.1")).toBe("127.0.0.1");
    expect(parseHostname("::")).toBe("::");
    expect(parseHostname("::1")).toBe("::1");
    expect(parseHostname("localhost")).toBe("localhost");
    expect(parseHostname("myhost.local")).toBe("myhost.local");
  });

  test("シェルメタ文字や URL を壊す文字を含む HOST は拒否する（openBrowser への不正 URL 流入を防ぐ）", () => {
    for (const bad of ["127.0.0.1$(touch /tmp/pwn)", "127.0.0.1;id", "host|nc", "a b", "a/b", "a%20b", "<script>", '"', "a$b"]) {
      expect(() => parseHostname(bad)).toThrow(/Invalid HOST/);
    }
  });

  test("空文字の HOST は拒否する（未設定はデフォルトで解決される）", () => {
    expect(() => parseHostname("")).toThrow(/Invalid HOST/);
  });
});

describe("server bindError", () => {
  test("EADDRINUSE にはポート変更の手段を添える", () => {
    // 実際に踏んだ落とし穴: Windows では予約済みポート範囲や WSL の localhost forwarding でも
    // EADDRINUSE になり、プロセスを探しても見つからない
    const error = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:3000"), {
      code: "EADDRINUSE",
    });
    const message = bindError(error, 3000).message;
    expect(message).toContain("port 3000 is already in use");
    expect(message).toContain("--port");
    expect(message).toContain("excludedportrange");
  });

  test("EADDRINUSE 以外のエラーはそのまま通す（原因を書き換えない）", () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(bindError(error, 3000)).toBe(error);
  });
});

describe("server parseArgs / parsePort", () => {
  test("--port と -p で値を受け取る（= 記法も含む）", () => {
    expect(parseArgs(["--port", "4000"]).port).toBe("4000");
    expect(parseArgs(["-p", "4000"]).port).toBe("4000");
    expect(parseArgs(["--port=4000"]).port).toBe("4000");
  });

  test("--help を認識する", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs([]).help).toBe(false);
  });

  test("値のない --port はエラーにする（次のフラグを値として飲み込まない）", () => {
    expect(() => parseArgs(["--port"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--port", "--help"])).toThrow(/requires a value/);
  });

  test("未知のオプションは黙って無視せずエラーにする", () => {
    // 打ち間違い（--prot 4000 等）が黙って既定ポート起動になると原因に気づけない
    expect(() => parseArgs(["--prot", "4000"])).toThrow(/Unknown option/);
  });

  test("既定ポートは競合しやすい 3000 ではない", () => {
    // 既定値の適用は resolvePort だけが行う（parsePort は検証のみ）
    expect(resolvePort(undefined, undefined).port).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).not.toBe(3000);
    // Windows の既定動的ポート範囲（49152-65535）に入らない
    expect(DEFAULT_PORT).toBeLessThan(49152);
  });

  test("不正な値は指定元を明示して拒否する（--port と PORT を取り違えない）", () => {
    expect(() => parsePort("abc", "--port")).toThrow(/Invalid --port=abc/);
    expect(() => parsePort("0", "--port")).toThrow(/Invalid --port=0/);
    expect(() => parsePort("70000")).toThrow(/Invalid PORT=70000/);
  });
});

describe("server resolvePort / portSourceLabel", () => {
  test("優先順位どおりにポートと決定元を返す", () => {
    expect(resolvePort("4000", "3000")).toEqual({ port: 4000, source: "--port" });
    expect(resolvePort("4000", undefined)).toEqual({ port: 4000, source: "--port" });
    expect(resolvePort(undefined, "3000")).toEqual({ port: 3000, source: "PORT" });
    expect(resolvePort(undefined, undefined)).toEqual({ port: DEFAULT_PORT, source: "default" });
  });

  test("空文字の PORT は未設定として扱い、既定ポートで起動する", () => {
    // 判定だけ「既定値」にして値の計算を分けると parsePort("") が Invalid PORT= で落ちる。
    // 決定元と値を同じ関数で返すことで、両者が食い違わないようにしている
    expect(resolvePort(undefined, "")).toEqual({ port: DEFAULT_PORT, source: "default" });
  });

  test("不正な値は指定元を明示して拒否する", () => {
    expect(() => resolvePort("abc", undefined)).toThrow(/Invalid --port=abc/);
    expect(() => resolvePort(undefined, "70000")).toThrow(/Invalid PORT=70000/);
  });

  test("既定値のときは起動ログに何も足さない", () => {
    expect(portSourceLabel("default")).toBe("");
  });

  test("既定以外は決定元を表示する（既定を変えたのに違うポートで起動する理由が分かる）", () => {
    // 環境変数の残存に気づけず「既定ポートが効いていない」と誤解する事例が実際に起きた
    expect(portSourceLabel("PORT")).toContain("PORT");
    expect(portSourceLabel("--port")).toContain("--port");
  });
});

describe("server parseArgs の = 形式", () => {
  test("値を取らないフラグに = で値を付けたら拒否する", () => {
    // 黙って無視すると「指定したのに効かない」ことに気づけない
    expect(() => parseArgs(["--help=json"])).toThrow(/does not take a value/);
    expect(() => parseArgs(["--help="])).toThrow(/does not take a value/);
  });

  test("--port=4000 と --port 4000 が同じ結果になる", () => {
    expect(parseArgs(["--port=4000"])).toEqual(parseArgs(["--port", "4000"]));
  });

  test("= 形式では次のトークンを消費しない", () => {
    // --port=4000 --help のように後続がある場合、値として飲み込まれてはいけない
    expect(parseArgs(["--port=4000", "--help"])).toEqual({ port: "4000", help: true });
  });

  test("= 形式で値が空なら拒否する", () => {
    expect(() => parseArgs(["--port="])).toThrow(/requires a value/);
  });

  test("未知のオプションは = 形式でもオプション名だけを報告する", () => {
    expect(() => parseArgs(["--prot=4000"])).toThrow(/Unknown option: --prot/);
  });
});
