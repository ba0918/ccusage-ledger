import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, closeSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { PACKAGE_DIR, defaultCachePath } from "./paths";
import type { UsageData } from "./types";
import { SECTIONS, isUsageData, projectUsageData } from "./usage-data";

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

// セクション集合は usage-data.ts の SECTIONS と常に一致させる（検証と取得がずれるとキャッシュが常に無効化される）
export const DEFAULT_COMMAND = ["--json", "--sections", SECTIONS.join(","), "--by-agent"];

// 子プロセスに渡す環境変数の許可リスト（API キー・トークン等の秘密は渡さない）
const ALLOWED_ENV_KEYS = ["PATH", "HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP", "TERM", "SHELL"] as const;

export function spawnEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) { result[key] = value; }
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
  // TextDecoder をストリーミングで使うと、全チャンク保持 + マージコピーの二重メモリを回避できる
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { break; }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`ccusage stdout is too large (limit ${maxBytes} bytes)`);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return parts.join("");
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
  try {
    const stdout = await readStdoutWithLimit(proc.stdout);
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  } finally {
    // stdout 上限超過などで throw した場合は、パイプを読み止めたままの子プロセスが
    // タイムアウトまで残留するため、確実に終了させる
    proc.kill();
  }
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
        // キャッシュは白リスト投影済みで保存する（未知フィールドをディスクに永続化しない）。
        // 取得結果も投影済みを返すため、配信側で再投影しても冪等になる
        const projected = projectUsageData(parsed);
        try {
          writeCache(cachePath, projected);
        } catch (error) {
          // キャッシュ書き込み失敗はベストエフォートで扱う。取得済みの新鮮データを捨てずに返す
          console.warn(`WARN: failed to write usage cache: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { data: projected, source: "fresh" };
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
  // キャッシュは JSON.parse で読むだけなので、可読性のためのインデントを付けない
  // （巨大な全履歴を 1 ファイルに書く場面で、文字列生成時間・ファイルサイズ・一時メモリを削る）
  const tmpPath = `${cachePath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(data));
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
    if (!isUsageData(parsed)) { throw new Error("invalid usage data shape"); }
    // キャッシュは投影済みで保存されているが、旧形式のキャッシュへの安全策として再投影する（冪等）
    return { data: projectUsageData(parsed), source: "cache" };
  } catch {
    return null;
  }
}
