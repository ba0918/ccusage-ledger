import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_DIR, defaultCachePath } from "./paths";
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

export const CCUSAGE_VERSION = "20.0.19";
export const DEFAULT_COMMAND = ["--json", "--sections", "daily,monthly", "--by-agent"];

// 子プロセスに渡す環境変数の許可リスト（API キー・トークン等の秘密は渡さない）
const ALLOWED_ENV_KEYS = ["PATH", "HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP", "TERM", "SHELL"] as const;

export function spawnEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function ccusageCliPath(packageDir: string = PACKAGE_DIR): string {
  return join(packageDir, "node_modules", "ccusage", "src", "cli.js");
}

export function buildCcusageCommand(cliPath: string, args: string[]): string[] {
  return ["bun", "run", cliPath, ...args];
}

async function defaultSpawn(args: string[]): Promise<SpawnResult> {
  const cliPath = ccusageCliPath();
  if (!existsSync(cliPath)) {
    throw new Error(`ccusage がインストールされていません: ${cliPath}（bun install を実行してください）`);
  }
  // bunx による毎回のレジストリ解決をやめ、依存として固定した cli.js を直接実行する。
  // 子プロセスには許可リストの環境変数だけを渡し、RCE された場合に奪える秘密を無くす。
  const proc = Bun.spawn(buildCcusageCommand(cliPath, args), {
    env: spawnEnv(process.env),
    stdout: "pipe",
    stderr: "ignore",
    timeout: 60_000,
  });
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
