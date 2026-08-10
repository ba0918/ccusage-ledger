import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UsageData } from "./types";

export interface SpawnResult {
  stdout: string;
  exitCode: number;
}

export type SpawnFn = (command: string[]) => SpawnResult;

export interface FetchUsageOptions {
  command?: string[];
  cachePath?: string;
  spawn?: SpawnFn;
}

export interface FetchUsageResult {
  data: UsageData;
  source: "fresh" | "cache";
}

export const DEFAULT_COMMAND = ["bunx", "ccusage", "--json", "--sections", "daily,monthly"];

function defaultSpawn(command: string[]): SpawnResult {
  const result = Bun.spawnSync(command);
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

export function fetchUsage(options: FetchUsageOptions = {}): FetchUsageResult | null {
  const command = options.command ?? DEFAULT_COMMAND;
  const cachePath = options.cachePath ?? "data/usage.json";
  const spawn = options.spawn ?? defaultSpawn;

  try {
    const result = spawn(command);
    if (result.exitCode === 0) {
      const data = JSON.parse(result.stdout) as UsageData;
      writeCache(cachePath, data);
      return { data, source: "fresh" };
    }
  } catch {
    // コマンド実行・パース失敗はキャッシュフォールバックへ
  }

  return readCache(cachePath);
}

function writeCache(cachePath: string, data: UsageData): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(data, null, 2));
}

function readCache(cachePath: string): FetchUsageResult | null {
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf-8")) as UsageData;
    return { data, source: "cache" };
  } catch {
    return null;
  }
}
