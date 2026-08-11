import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, closeSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
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

// 子プロセスの stdout をバイト上限付きで読み切る（巨大出力でメモリを枯渇させない）
export const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export async function readStdoutWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number = MAX_STDOUT_BYTES,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`ccusage stdout is too large (limit ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function defaultSpawn(args: string[]): Promise<SpawnResult> {
  const cliPath = ccusageCliPath();
  if (!existsSync(cliPath)) {
    throw new Error(`ccusage がインストールされていません: ${cliPath}（bun install を実行してください）`);
  }
  // bunx による毎回のレジストリ解決をやめ、依存として固定した cli.js を直接実行する。
  // 子プロセスには許可リストの環境変数だけを渡し、RCE された場合に環境変数経由の秘密を奪えないようにする。
  // （注意: HOME を渡すため、ccusage が悪意を持つ場合は ~/.claude 等のファイルは読まれ得る）
  const proc = Bun.spawn(buildCcusageCommand(cliPath, args), {
    env: spawnEnv(process.env),
    stdout: "pipe",
    stderr: "ignore",
    timeout: 60_000,
  });
  const stdout = await readStdoutWithLimit(proc.stdout);
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
  // 攻撃者が書き込み可能なディレクトリでは、共有ディレクトリの owner 以外から
  // 0600 へ再設定できない場合があるため、mkdir 後にも 0700 を再適用して担保する
  try {
    chmodSync(dirname(cachePath), 0o700);
  } catch {
    // ディレクトリを所有していない場合はエラーになるが、書き込み自体は続行する
  }
  // temp 名をランダムにして、PID ベースの予測可能な名前への symlink 仕掛けを防ぐ。
  // openSync の 'wx'（O_CREAT|O_EXCL）により既存の symlink を追わない
  const tmpPath = `${cachePath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2));
    closeSync(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
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
