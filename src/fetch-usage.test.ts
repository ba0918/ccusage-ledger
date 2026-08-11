import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchUsage, DEFAULT_COMMAND, type SpawnResult } from "./fetch-usage";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "usage.json"), "utf-8"));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccusage-fetch-"));
  return dir;
}

function writeCacheFixture(cachePath: string): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(FIXTURE));
}

describe("DEFAULT_COMMAND", () => {
  test("ccusage のバージョンを固定してエージェント内訳を取得する", () => {
    expect(DEFAULT_COMMAND).toEqual(["bunx", "ccusage@20.0.19", "--json", "--sections", "daily,monthly", "--by-agent"]);
  });
});

describe("fetchUsage デフォルト cachePath", () => {
  test("XDG_CACHE_HOME 基準のパスをデフォルトに使う", async () => {
    const dir = tempDir();
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = dir;
    try {
      const expected = join(dir, "ccusage-ledger", "usage.json");
      writeCacheFixture(expected);
      const result = await fetchUsage({ spawn: async () => ({ stdout: "", exitCode: 1 }) });
      expect(result).not.toBeNull();
      expect(result!.source).toBe("cache");
      expect(result!.data).toEqual(FIXTURE);
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });
});

describe("fetchUsage キャッシュ書き込み", () => {
  test("キャッシュファイルは 0600 で書かれる", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = async (): Promise<SpawnResult> => ({ stdout: JSON.stringify(FIXTURE), exitCode: 0 });

    await fetchUsage({ cachePath, spawn });

    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual(FIXTURE);
  });

  test("キャッシュ書き込み後は一時ファイルを残さない", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = async (): Promise<SpawnResult> => ({ stdout: JSON.stringify(FIXTURE), exitCode: 0 });

    await fetchUsage({ cachePath, spawn });

    const tmpFiles = readdirSync(dirname(cachePath)).filter((name) => name.includes(".tmp"));
    expect(tmpFiles).toEqual([]);
  });
});

describe("fetchUsage", () => {
  test("取得成功時に stdout の JSON をキャッシュファイルへ保存して返す", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: JSON.stringify(FIXTURE),
      exitCode: 0,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("fresh");
    expect(result!.data.daily).toHaveLength(3);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual(FIXTURE);
  });

  test("取得失敗時は既存キャッシュへフォールバックする", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    writeCacheFixture(cachePath);
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: "",
      exitCode: 1,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("cache");
    expect(result!.data).toEqual(FIXTURE);
  });

  test("取得失敗かつキャッシュが無い場合は null を返す", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: "",
      exitCode: 1,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).toBeNull();
  });

  test("スキーマ不一致の stdout は無効としてキャッシュへフォールバックする", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    writeCacheFixture(cachePath);
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: JSON.stringify({ error: "invalid output" }),
      exitCode: 0,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("cache");
    expect(result!.data).toEqual(FIXTURE);
  });

  test("スキーマ不一致の stdout かつキャッシュが無い場合は null を返す", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: JSON.stringify({ daily: "not-an-array" }),
      exitCode: 0,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).toBeNull();
  });

  test("スキーマ不一致のキャッシュは無効として扱う", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ daily: 1, monthly: 2 }));
    const spawn = async (): Promise<SpawnResult> => ({
      stdout: "",
      exitCode: 1,
    });

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).toBeNull();
  });

  test("spawn が例外を投げてもキャッシュがあればフォールバックする", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    writeCacheFixture(cachePath);
    const spawn = async (): Promise<SpawnResult> => {
      throw new Error("command not found");
    };

    const result = await fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("cache");
  });

  test("コマンドに --sections を渡し monthly セクションを含める", async () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const command = ["bunx", "ccusage", "--json", "--sections", "daily,monthly"];
    const spawn = async (cmd: string[]): Promise<SpawnResult> => {
      expect(cmd).toEqual(command);
      return { stdout: JSON.stringify(FIXTURE), exitCode: 0 };
    };

    const result = await fetchUsage({ cachePath, spawn, command });

    expect(result!.source).toBe("fresh");
  });
});
