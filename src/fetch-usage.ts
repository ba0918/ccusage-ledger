import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { defaultCachePath } from "./paths";
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

export const DEFAULT_COMMAND = ["bunx", "ccusage@20.0.19", "--json", "--sections", "daily,monthly", "--by-agent"];

function defaultSpawn(command: string[]): SpawnResult {
  // ccusage 取得がハングしてもサーバ起動（bind）を止めないようタイムアウトを設ける
  const result = Bun.spawnSync(command, { timeout: 60_000 });
  return { stdout: result.stdout.toString(), exitCode: result.exitCode };
}

function isUsageData(data: unknown): data is UsageData {
  if (typeof data !== "object" || data === null) return false;
  const sections = ["daily", "monthly"];
  return sections.every((section) => Array.isArray((data as Record<string, unknown>)[section]));
}

export function fetchUsage(options: FetchUsageOptions = {}): FetchUsageResult | null {
  const command = options.command ?? DEFAULT_COMMAND;
  const cachePath = options.cachePath ?? defaultCachePath(process.env);
  const spawn = options.spawn ?? defaultSpawn;

  try {
    const result = spawn(command);
    if (result.exitCode === 0) {
      const parsed: unknown = JSON.parse(result.stdout);
      if (isUsageData(parsed)) {
        writeCache(cachePath, parsed);
        return { data: parsed, source: "fresh" };
      }
    }
  } catch {
    // コマンド実行・パース失敗はキャッシュフォールバックへ
  }

  return readCache(cachePath);
}

function writeCache(cachePath: string, data: UsageData): void {
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${cachePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmpPath, cachePath);
}

function readCache(cachePath: string): FetchUsageResult | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!isUsageData(parsed)) throw new Error("invalid usage data shape");
    return { data: parsed, source: "cache" };
  } catch {
    return null;
  }
}
