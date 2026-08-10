import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchUsage, type SpawnResult } from "./fetch-usage";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "usage.json"), "utf-8"));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccusage-fetch-"));
  return dir;
}

function writeCacheFixture(cachePath: string): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(FIXTURE));
}

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
