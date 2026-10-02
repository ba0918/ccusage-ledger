import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchUsage, readCache, collectionContext } from "./fetch-usage";
import { refreshSince, replaceCoverage, type CacheMetadata } from "./month-cache";
import type { PeriodEntry } from "./types";

const entry = (period: string, totalCost = 1): PeriodEntry => ({ period, totalCost, totalTokens: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, modelsUsed: [], modelBreakdowns: [] });
const now = new Date("2026-02-14T12:00:00Z");
function setup() {
  const cachePath = join(mkdtempSync(join(tmpdir(), "ledger-month-")), "usage.json");
  return { cachePath, now };
}

test("repeat startup requests a complete month window and replaces its changed total", async () => {
  const options = setup();
  await fetchUsage({ ...options, spawn: async () => ({ exitCode: 0, stdout: JSON.stringify({ daily: [entry("2026-01-02")], monthly: [entry("2026-01")] }) }) });
  let command: string[] = [];
  const result = await fetchUsage({ ...options, spawn: async (args) => { command = args; return { exitCode: 0, stdout: JSON.stringify({ daily: [entry("2026-01-02", 2)], monthly: [entry("2026-01", 2)] }) }; } });
  expect(command.slice(-2)).toEqual(["--since", "20260101"]);
  expect(result?.data.monthly?.[0]?.totalCost).toBe(2);
});

test("reconciliation expires after seven days even after a window refresh", async () => {
  const options = setup();
  const empty = async () => ({ exitCode: 0, stdout: '{"daily":[],"monthly":[]}' });
  await fetchUsage({ ...options, spawn: empty });
  await fetchUsage({ ...options, now: new Date(now.getTime() + 6 * 86400000), spawn: empty });
  let args: string[] = [];
  await fetchUsage({ ...options, now: new Date(now.getTime() + 7 * 86400000), spawn: async (command) => { args = command; return empty(); } });
  expect(args).not.toContain("--since");
});

test("source changes cannot reuse or fall back to the previous user's cache", async () => {
  const options = setup();
  const old = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = "/synthetic/source-a";
    await fetchUsage({ ...options, spawn: async () => ({ exitCode: 0, stdout: '{"daily":[],"monthly":[]}' }) });
    process.env.CODEX_HOME = "/synthetic/source-b";
    expect(await fetchUsage({ ...options, spawn: async () => ({ exitCode: 1, stdout: "" }) })).toBeNull();
  } finally {
    if (old === undefined) { delete process.env.CODEX_HOME; } else { process.env.CODEX_HOME = old; }
  }
});

test("auto-discovered config changes invalidate fallback and incremental coverage", async () => {
  const options = setup();
  const old = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "ledger-config-"));
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    writeFileSync(join(dir, "ccusage.json"), JSON.stringify({ defaults: { timezone: "UTC" } }));
    await fetchUsage({ ...options, spawn: async () => ({ exitCode: 0, stdout: '{"daily":[],"monthly":[]}' }) });
    writeFileSync(join(dir, "ccusage.json"), JSON.stringify({ defaults: { timezone: "Asia/Tokyo" } }));
    expect(await fetchUsage({ ...options, spawn: async () => ({ exitCode: 1, stdout: "" }) })).toBeNull();
  } finally {
    if (old === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = old; }
  }
});

test("invalid, future or obsolete metadata never enables a window merge", () => {
  for (const metadata of [
    { fingerprint: "same", fullAt: Number.NaN },
    { fingerprint: "same", fullAt: now.getTime(), version: 99, refreshedAt: now.getTime() },
    { fingerprint: "same", fullAt: now.getTime(), version: 1, refreshedAt: now.getTime() + 1 },
  ]) {
    expect(refreshSince(now, metadata as CacheMetadata, "same")).toBeNull();
  }
});

test("window output outside coverage is rejected instead of duplicating old records", () => {
  expect(() => replaceCoverage({ daily: [entry("2025-12-01")] }, { daily: [entry("2025-12-01")] }, "2026-01-01")).toThrow();
});

test("retained plus refreshed records cannot exceed aggregate validation limits", () => {
  expect(() => replaceCoverage({ daily: Array.from({ length: 10000 }, () => entry("2025-12-01")) }, { daily: [entry("2026-01-01")] }, "2026-01-01")).toThrow();
});

test("month window follows the configured upstream timezone at rollover", async () => {
  const options = { ...setup(), now: new Date("2026-02-28T16:00:00Z") };
  const old = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "ledger-config-"));
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    writeFileSync(join(dir, "ccusage.json"), JSON.stringify({ defaults: { timezone: "Asia/Tokyo" } }));
    const empty = async () => ({ exitCode: 0, stdout: '{"daily":[],"monthly":[]}' });
    await fetchUsage({ ...options, spawn: empty });
    let args: string[] = [];
    await fetchUsage({ ...options, spawn: async (command) => { args = command; return empty(); } });
    expect(args.slice(-2)).toEqual(["--since", "20260201"]);
  } finally {
    if (old === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = old; }
  }
});

test("custom constrained commands never receive an incremental since override", async () => {
  const options = { ...setup(), command: ["--json", "--since", "20250115"] };
  const empty = async () => ({ exitCode: 0, stdout: '{"daily":[],"monthly":[]}' });
  await fetchUsage({ ...options, spawn: empty });
  let args: string[] = [];
  await fetchUsage({ ...options, spawn: async (command) => { args = command; return empty(); } });
  expect(args).toEqual(options.command);
});

test("rebuild explicitly collects full history", async () => {
  const options = setup();
  const empty = async () => ({ exitCode: 0, stdout: '{"daily":[],"monthly":[]}' });
  await fetchUsage({ ...options, spawn: empty });
  let args: string[] = [];
  await fetchUsage({ ...options, rebuildCache: true, spawn: async (command) => { args = command; return empty(); } });
  expect(args).not.toContain("--since");
});

test("constrained configs and uncertain timezones safely disable window collection", async () => {
  const old = process.env.CLAUDE_CONFIG_DIR;
  const oldTZ = process.env.TZ;
  const dir = mkdtempSync(join(tmpdir(), "ledger-config-"));
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    for (const defaults of [{ since: "20260115" }, { until: "20260115" }, { timezone: "Not/AZone" }, {}]) {
      if (Object.keys(defaults).length === 0) { process.env.TZ = "UTC"; }
      writeFileSync(join(dir, "ccusage.json"), JSON.stringify({ defaults }));
      const options = setup();
      const empty = async () => ({ exitCode: 0, stdout: '{"daily":[],"monthly":[]}' });
      await fetchUsage({ ...options, spawn: empty });
      let args: string[] = [];
      await fetchUsage({ ...options, spawn: async (command) => { args = command; return empty(); } });
      expect(args).not.toContain("--since");
    }
  } finally {
    if (old === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = old; }
    if (oldTZ === undefined) { delete process.env.TZ; } else { process.env.TZ = oldTZ; }
  }
});

test("replacement removes absent periods, preserves earlier months and is idempotent", () => {
  const cached = { daily: [entry("2025-12-31"), entry("2026-01-01")], monthly: [entry("2025-12"), entry("2026-01")] };
  const fresh = { daily: [entry("2026-02-01", 7)], monthly: [entry("2026-02", 9)] };
  const merged = replaceCoverage(cached, fresh, "2026-01-01");
  expect(merged.daily?.map((row) => row.period)).toEqual(["2025-12-31", "2026-02-01"]);
  expect(merged.monthly?.map((row) => row.totalCost)).toEqual([1, 9]);
  expect(replaceCoverage(merged, fresh, "2026-01-01")).toEqual(merged);
  expect(replaceCoverage(merged, { daily: [], monthly: [] }, "2026-01-01")).toEqual({ daily: [entry("2025-12-31")], monthly: [entry("2025-12")] });
});

test("window boundary crosses years and leap months without slicing a month", () => {
  for (const [date, expected] of [["2026-01-01", "2025-12-01"], ["2024-03-31", "2024-02-01"], ["2026-12-31", "2026-11-01"]] as const) {
    const instant = new Date(`${date}T12:00:00Z`);
    expect(refreshSince(instant, { version: 1, fingerprint: "same", fullAt: instant.getTime(), refreshedAt: instant.getTime() }, "same", "UTC")).toBe(expected);
  }
});

test("failed reconciliation preserves data and metadata without advancing freshness", async () => {
  const options = setup();
  await fetchUsage({ ...options, spawn: async () => ({ exitCode: 0, stdout: JSON.stringify({ daily: [entry("2026-01-01")], monthly: [] }) }) });
  const before = readFileSync(options.cachePath, "utf8");
  const result = await fetchUsage({ ...options, now: new Date(now.getTime() + 8 * 86400000), spawn: async () => ({ exitCode: 1, stdout: "" }) });
  expect(result?.source).toBe("cache");
  expect(readFileSync(options.cachePath, "utf8")).toBe(before);
  const saved = JSON.parse(before);
  expect(saved._ledger.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(saved._ledger)).not.toContain(process.cwd());
});

test("preloading refuses cache from incompatible configuration", async () => {
  const options = setup();
  await fetchUsage({ ...options, command: ["--json", "--since", "20260101"], spawn: async () => ({ exitCode: 0, stdout: '{"daily":[],"monthly":[]}' }) });
  expect(readCache(options.cachePath)).toBeNull();
});

test("collection reports observed stages and cancellation cannot save or return fallback", async () => {
  const options = setup();
  const stages: string[] = [];
  const empty = { exitCode: 0, stdout: '{"daily":[],"monthly":[]}' };
  await fetchUsage({ ...options, onStage: (stage) => stages.push(stage), spawn: async () => empty });
  expect(stages).toEqual(["Verifying ccusage", "Collecting full history", "Validating and saving usage"]);
  const before = readFileSync(options.cachePath, "utf8");
  const controller = new AbortController();
  await expect(fetchUsage({ ...options, signal: controller.signal, spawn: async () => { controller.abort(); return empty; } })).rejects.toThrow();
  expect(readFileSync(options.cachePath, "utf8")).toBe(before);
});

test("already cancelled startup never launches collection", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await expect(fetchUsage({ ...setup(), signal: controller.signal, spawn: async () => { spawned = true; return { exitCode: 0, stdout: '{"daily":[],"monthly":[]}' }; } })).rejects.toThrow();
  expect(spawned).toBe(false);
});

test("config discovery stops after its first valid object", () => {
  const old = process.env.CLAUDE_CONFIG_DIR;
  const first = mkdtempSync(join(tmpdir(), "ledger-config-"));
  const ignored = mkdtempSync(join(tmpdir(), "ledger-config-"));
  try {
    writeFileSync(join(first, "ccusage.json"), '{"defaults":{"timezone":"UTC"}}');
    writeFileSync(join(ignored, "ccusage.json"), " ".repeat(1024 * 1024 + 1));
    process.env.CLAUDE_CONFIG_DIR = `${first},${ignored}`;
    expect(collectionContext().timezone).toBe("UTC");
  } finally {
    if (old === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = old; }
  }
});

test("configuration changing during collection cannot merge into the earlier source", async () => {
  const options = setup();
  const old = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = "/synthetic/source-a";
    const empty = { exitCode: 0, stdout: '{"daily":[],"monthly":[]}' };
    await fetchUsage({ ...options, spawn: async () => empty });
    expect(await fetchUsage({ ...options, spawn: async () => { process.env.CODEX_HOME = "/synthetic/source-b"; return empty; } })).toBeNull();
  } finally {
    if (old === undefined) { delete process.env.CODEX_HOME; } else { process.env.CODEX_HOME = old; }
  }
});

test("an un-fingerprintable active config still permits a full collection without cache reuse", async () => {
  const options = setup();
  const old = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "ledger-config-"));
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    writeFileSync(join(dir, "ccusage.json"), `{}${" ".repeat(1024 * 1024)}`);
    let args: string[] = [];
    const result = await fetchUsage({ ...options, spawn: async (command) => { args = command; return { exitCode: 0, stdout: '{"daily":[],"monthly":[]}' }; } });
    expect(result?.source).toBe("fresh");
    expect(result?.cacheWriteWarning).toBe(true);
    expect(args).not.toContain("--since");
    expect(readCache(options.cachePath)).toBeNull();
  } finally {
    if (old === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = old; }
  }
});

test("retargeting a configured pi store invalidates both window coverage and fallback", async () => {
  const options = setup();
  const old = process.env.CLAUDE_CONFIG_DIR;
  const root = mkdtempSync(join(tmpdir(), "ledger-pi-store-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const link = join(root, "store");
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, link, "junction");
  try {
    process.env.CLAUDE_CONFIG_DIR = root;
    writeFileSync(join(root, "ccusage.json"), JSON.stringify({ pi: { stores: [{ name: "synthetic", path: link }] } }));
    const empty = { exitCode: 0, stdout: '{"daily":[],"monthly":[]}' };
    await fetchUsage({ ...options, spawn: async () => empty });
    const prior = readFileSync(options.cachePath, "utf8");
    unlinkSync(link);
    symlinkSync(second, link, "junction");
    expect(readCache(options.cachePath)).toBeNull();
    let args: string[] = [];
    expect(await fetchUsage({ ...options, spawn: async (command) => { args = command; return { exitCode: 1, stdout: "" }; } })).toBeNull();
    expect(args).not.toContain("--since");
    expect(readFileSync(options.cachePath, "utf8")).toBe(prior);
    await fetchUsage({ ...options, spawn: async (command) => { args = command; return empty; } });
    expect(args).not.toContain("--since");
    expect(readCache(options.cachePath)).not.toBeNull();
  } finally {
    if (old === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = old; }
  }
});
