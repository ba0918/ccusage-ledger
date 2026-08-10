import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "usage.json"), "utf-8");

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "ccusage-server-"));
  mkdirSync(join(rootDir, "data"), { recursive: true });
  mkdirSync(join(rootDir, "dist"), { recursive: true });
  mkdirSync(join(rootDir, "public", "vendor"), { recursive: true });
  writeFileSync(join(rootDir, "index.html"), "<!doctype html><title>ccusage</title>");
  writeFileSync(join(rootDir, "dist", "bundle.js"), "console.log('bundle');");
  writeFileSync(join(rootDir, "public", "vendor", "chart.umd.min.js"), "// chart.js");
  writeFileSync(join(rootDir, "data", "usage.json"), FIXTURE);
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

async function get(path: string): Promise<Response> {
  const app = createApp({ rootDir });
  return app(new Request(`http://127.0.0.1${path}`));
}

describe("server /api/usage", () => {
  test("data/usage.json の内容を application/json で返す", async () => {
    const res = await get("/api/usage");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
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
});

describe("server セキュリティ", () => {
  test("パストラバーサルは 404 を返す", async () => {
    const res = await get("/../../etc/passwd");
    expect(res.status).toBe(404);
  });
});
