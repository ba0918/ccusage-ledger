import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchUsage, DEFAULT_COMMAND, spawnEnv, withSafeChain, type SpawnResult } from "./fetch-usage";

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
  test("--by-agent でエージェント内訳を取得する", () => {
    expect(DEFAULT_COMMAND).toEqual(["bunx", "ccusage", "--json", "--sections", "daily,monthly", "--by-agent"]);
  });
});

describe("withSafeChain", () => {
  test("safe-chain があればコマンドの先頭に前置する", () => {
    expect(withSafeChain(DEFAULT_COMMAND, true)).toEqual(["safe-chain", ...DEFAULT_COMMAND]);
  });

  test("safe-chain が無ければ素のコマンドを返す", () => {
    expect(withSafeChain(DEFAULT_COMMAND, false)).toEqual(DEFAULT_COMMAND);
  });
});

describe("spawnEnv", () => {
  test("safe-chain 起動時は PKG_EXECPATH を除外する（pkg ブートストラップの誤解釈回避）", () => {
    expect(spawnEnv({ PKG_EXECPATH: "/safe-chain/bin/safe-chain", PATH: "/bin" }, true)).toEqual({ PATH: "/bin" });
  });

  test("safe-chain なしの起動では env をそのまま渡す", () => {
    expect(spawnEnv({ PKG_EXECPATH: "/safe-chain/bin/safe-chain", PATH: "/bin" }, false)).toEqual({
      PKG_EXECPATH: "/safe-chain/bin/safe-chain",
      PATH: "/bin",
    });
  });
});

describe("fetchUsage デフォルト cachePath", () => {
  test("XDG_CACHE_HOME 基準のパスをデフォルトに使う", () => {
    const dir = tempDir();
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = dir;
    try {
      const expected = join(dir, "ccusage-ledger", "usage.json");
      writeCacheFixture(expected);
      const result = fetchUsage({ spawn: (_command: string[]) => ({ stdout: "", exitCode: 1 }) });
      expect(result).not.toBeNull();
      expect(result!.source).toBe("cache");
      expect(result!.data).toEqual(FIXTURE);
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });
});

describe("fetchUsage", () => {
  test("取得成功時に stdout の JSON をキャッシュファイルへ保存して返す", () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = (_command: string[]): SpawnResult => ({
      stdout: JSON.stringify(FIXTURE),
      exitCode: 0,
    });

    const result = fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("fresh");
    expect(result!.data.daily).toHaveLength(3);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual(FIXTURE);
  });

  test("取得失敗時は既存キャッシュへフォールバックする", () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    writeCacheFixture(cachePath);
    const spawn = (_command: string[]): SpawnResult => ({
      stdout: "",
      exitCode: 1,
    });

    const result = fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("cache");
    expect(result!.data).toEqual(FIXTURE);
  });

  test("取得失敗かつキャッシュが無い場合は null を返す", () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = (_command: string[]): SpawnResult => ({
      stdout: "",
      exitCode: 1,
    });

    const result = fetchUsage({ cachePath, spawn });

    expect(result).toBeNull();
  });

  test("スキーマ不一致の stdout は無効としてキャッシュへフォールバックする", () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    writeCacheFixture(cachePath);
    const spawn = (_command: string[]): SpawnResult => ({
      stdout: JSON.stringify({ error: "invalid output" }),
      exitCode: 0,
    });

    const result = fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("cache");
    expect(result!.data).toEqual(FIXTURE);
  });

  test("スキーマ不一致の stdout かつキャッシュが無い場合は null を返す", () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const spawn = (_command: string[]): SpawnResult => ({
      stdout: JSON.stringify({ daily: "not-an-array" }),
      exitCode: 0,
    });

    const result = fetchUsage({ cachePath, spawn });

    expect(result).toBeNull();
  });

  test("スキーマ不一致のキャッシュは無効として扱う", () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ daily: 1, monthly: 2 }));
    const spawn = (_command: string[]): SpawnResult => ({
      stdout: "",
      exitCode: 1,
    });

    const result = fetchUsage({ cachePath, spawn });

    expect(result).toBeNull();
  });

  test("spawn が例外を投げてもキャッシュがあればフォールバックする", () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    writeCacheFixture(cachePath);
    const spawn = (_command: string[]): SpawnResult => {
      throw new Error("command not found");
    };

    const result = fetchUsage({ cachePath, spawn });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("cache");
  });

  test("コマンドに --sections を渡し monthly セクションを含める", () => {
    const dir = tempDir();
    const cachePath = join(dir, "data", "usage.json");
    const command = ["bunx", "ccusage", "--json", "--sections", "daily,monthly"];
    const spawn = (cmd: string[]): SpawnResult => {
      expect(cmd).toEqual(command);
      return { stdout: JSON.stringify(FIXTURE), exitCode: 0 };
    };

    const result = fetchUsage({ cachePath, spawn, command });

    expect(result!.source).toBe("fresh");
  });
});
