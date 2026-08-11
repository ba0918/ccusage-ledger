import { mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { defaultCachePath } from "./paths";
import type { UsageData } from "./types";
import { isUsageData } from "./usage-data";

export interface SpawnResult {
  stdout: string;
  exitCode: number;
}

export type SpawnFn = (command: string[]) => Promise<SpawnResult>;

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

async function defaultSpawn(command: string[]): Promise<SpawnResult> {
  // ccusage 取得がハングしてもサーバーのイベントループを塞がないよう非同期 spawn + タイムアウトを使う
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", timeout: 60_000 });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

export async function fetchUsage(options: FetchUsageOptions = {}): Promise<FetchUsageResult | null> {
  const command = options.command ?? DEFAULT_COMMAND;
  const cachePath = options.cachePath ?? defaultCachePath(process.env);
  const spawn = options.spawn ?? defaultSpawn;

  try {
    const result = await spawn(command);
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
  // 同時実行（サーバー / export / 複数プロセス）で同じ temp 名を共有しないよう PID を含める
  const tmpPath = `${cachePath}.tmp.${process.pid}`;
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
