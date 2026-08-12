import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, closeSync, chmodSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
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

// 子プロセスに渡す環境変数の許可リスト（API キー・トークン等の秘密は渡さない）。
// HOME は含めない（後述: 空の一時ディレクトリに置き換えて渡す）
const ALLOWED_ENV_KEYS = [
  "PATH",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "SHELL",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GEMINI_DATA_DIR",
  "OPENCODE_DATA_DIR",
] as const;

// ccusage が各エージェントのデータを読むための env。HOME を渡さない代わりにこの env で
// データソースを明示的に指定し、「ccusage が読める入口」をデータディレクトリだけに絞る
// （~/.ssh や ~/.aws 等のエージェント以外の秘密にはデフォルト探索で触れない）。
// デフォルトは現在のユーザーの HOME ベース。claude は projects/、gemini は tmp/ まで絞れるが、
// codex / opencode は認証情報（auth.json 等）と履歴が同一ディレクトリのためディレクトリ単位で妥協する
const AGENT_DATA_DIR_DEFAULTS: Record<string, string> = {
  CLAUDE_CONFIG_DIR: "~/.claude/projects",
  CODEX_HOME: "~/.codex",
  GEMINI_DATA_DIR: "~/.gemini/tmp",
  OPENCODE_DATA_DIR: "~/.local/share/opencode",
};

export function userHomeDir(env: Record<string, string | undefined>): string {
  return env.HOME ?? homedir();
}

export interface SpawnEnvOptions {
  userHome: string;
  emptyHome: string;
}

export function spawnEnv(env: Record<string, string | undefined>, options: SpawnEnvOptions): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = env[key];
    // 空文字は未設定と同等に扱う（データディレクトリ env のデフォルト解決を正しく働かせる）
    if (value !== undefined && value !== "") { result[key] = value; }
  }
  // HOME は渡さない。ccusage がデフォルトで ~/.claude 等を探索しないよう、空の一時ディレクトリを設定する。
  // データソースは上記のデータディレクトリ env でのみ渡す
  result.HOME = options.emptyHome;
  for (const key of Object.keys(AGENT_DATA_DIR_DEFAULTS) as Array<keyof typeof AGENT_DATA_DIR_DEFAULTS>) {
    // ユーザーが明示的に設定している場合はそれを尊重し、未設定のときだけデフォルトを解決する。
    // slice(1) で "~" を除いた後置換して連結する（String.replace の $ パターン置換を避ける。
    // HOME に "$&" 等が含まれても置換が壊れない）
    if (result[key] === undefined) {
      const suffix = AGENT_DATA_DIR_DEFAULTS[key]!.slice(1);
      result[key] = options.userHome + suffix;
    }
  }
  return result;
}

export function ccusageCliPath(packageDir: string = PACKAGE_DIR): string {
  return join(packageDir, "node_modules", "ccusage", "src", "cli.js");
}

// ccusage@20.0.19 の実行コード全体（ラッパー + 実行プラットフォームの native バイナリ）の sha256。
// 依存を更新した場合や別プラットフォーム（darwin / win32 等）で開発する場合は再計算して必ず更新する
// （vendor-integrity.test.ts の固定値と同一アルゴリズムで算出する）
export const CCUSAGE_SHA256 = "69e6fd78a1296a269e6a750b8497a6c06b8233bb85d6a418a99c42639ee8612a";

// ccusage の native バイナリパッケージ名（@ccusage/ccusage-<platform>-<arch>）。
// ccusage@20.0.19 の cli.js が持つ解決ロジックと同一のものを、実行せずにハッシュ対象を
// 特定するために直接持つ（cli.js はラッパーで、実処理はこの native バイナリが担う）
export function ccusageNativePackageName(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const table: Record<string, Record<string, string>> = {
    darwin: { arm64: "@ccusage/ccusage-darwin-arm64", x64: "@ccusage/ccusage-darwin-x64" },
    linux: { arm64: "@ccusage/ccusage-linux-arm64", x64: "@ccusage/ccusage-linux-x64" },
    win32: { arm64: "@ccusage/ccusage-win32-arm64", x64: "@ccusage/ccusage-win32-x64" },
  };
  return table[platform]?.[arch] ?? null;
}

export function ccusageNativePackageDir(packageDir: string = PACKAGE_DIR): string | null {
  const name = ccusageNativePackageName();
  if (name === null) { return null; }
  // name は "@ccusage/ccusage-<platform>-<arch>" のスコープ付きなので、node_modules/ に直接連結する
  const root = join(packageDir, "node_modules", name);
  return existsSync(root) ? root : null;
}

// ディレクトリ配下の全ファイルを「相対パス + ':' + 内容」の連結でハッシュする
function hashPackageFiles(root: string): string {
  const files = (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .filter((name) => statSync(join(root, name)).isFile())
    .sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update(":");
    hash.update(readFileSync(join(root, rel)));
  }
  return hash.digest("hex");
}

// 実行されるコード全体（node_modules/ccusage ラッパー + 実行プラットフォームの native バイナリ）を
// ハッシュする。native パッケージはインストール済みなら必ず含める（cli.js 単体ではなく、実処理が
// ある native バイナリの改ざんも検出するため）。インストール場所に依存しないよう、
// ディレクトリのハッシュは識別子（ccusage / native）を付けて連結する
export function computeCcusageHash(packageDir: string = PACKAGE_DIR): string {
  const roots: Array<[string, string]> = [["ccusage", join(packageDir, "node_modules", "ccusage")]];
  const nativeRoot = ccusageNativePackageDir(packageDir);
  if (nativeRoot !== null) { roots.push(["native", nativeRoot]); }
  const hash = createHash("sha256");
  for (const [id, root] of roots) {
    hash.update(id);
    hash.update(":");
    hash.update(hashPackageFiles(root));
  }
  return hash.digest("hex");
}

function assertCcusageIntegrity(packageDir: string = PACKAGE_DIR): void {
  // インストール済みの ccusage（ラッパー + native バイナリ）が改ざんされていないかを起動ごとに検証する。
  // 環境変数経由の秘密は allowlist で守れるが、ファイルベースの秘密（~/.claude 等）は
  // 依存が悪意を持つと読まれ得る（AGENTS.md 記載の残余リスク）。このチェックは
  // ローカル/レジストリ上での post-install 改ざんを検出する defense-in-depth であり、
  // 固定版そのものの悪意ある publish は検知できない（限界を明示）
  const actual = computeCcusageHash(packageDir);
  if (actual !== CCUSAGE_SHA256) {
    throw new Error(
      `ccusage integrity check failed (expected sha256 ${CCUSAGE_SHA256}, got ${actual}). ` +
        "The installed ccusage package differs from the pinned version. Re-run `bun install` to restore it.",
    );
  }
}

// 実行中インタプリタ（process.execPath）で cli.js を直接起動する。
// bunx / npx どちらで起動しても、process.execPath が bun / node を自動解決するため
// ランタイム非依存になる（PATH ハイジャック対策も兼ねる）
export function buildCcusageCommand(cliPath: string, args: string[], execPath: string = process.execPath): string[] {
  return [execPath, cliPath, ...args];
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
    throw new Error(`ccusage is not installed: ${cliPath} (run \`bun install\`)`);
  }
  // 依存として固定した cli.js を実行する前に、インストール済みパッケージの完全性を検証する
  assertCcusageIntegrity();

  // HOME を渡さないための空の一時ディレクトリ。ccusage がデフォルトで ~/.claude 等を
  // 探索しないようにし、データソースは spawnEnv が渡すデータディレクトリ env に限定する
  const emptyHome = mkdtempSync(join(tmpdir(), "ccusage-home-"));
  // 依存として固定した cli.js を直接実行する。
  // 子プロセスには許可リストの環境変数だけを渡し、RCE された場合に環境変数経由の秘密を奪えないようにする。
  // （HOME は渡さず空の一時ディレクトリを設定するため、ccusage が読めるのは明示指定した
  //   データディレクトリのみ。ただし実行ユーザーが同じなので、改ざんされたバイナリが
  //   ファイルシステムを直接探索することは防げない。integrity check が主防衛）
  // spawn の stdio タプル指定は戻り値型を never に縮約するため、ChildProcess として明示する
  const command = buildCcusageCommand(cliPath, args);
  const proc: ChildProcess = spawn(command[0]!, command.slice(1), {
    env: spawnEnv(process.env, { userHome: userHomeDir(process.env), emptyHome }),
    stdio: ["ignore", "pipe", "ignore"] as const,
    timeout: 60_000,
  });

  // stdout をバイト上限付きで収集する。上限超過時は子プロセスを kill して
  // 読み止めのまま残留するのを防ぐ（Bun.spawn の頃のタイムアウト残留対策と同様）
  const stdout: Buffer[] = [];
  let total = 0;
  let limitExceeded = false;
  try {
    const stdoutStream = proc.stdout;
    if (stdoutStream === null) {
      throw new Error("ccusage stdout is not available");
    }
    const stdoutText = await new Promise<string>((resolve, reject) => {
      stdoutStream.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > MAX_STDOUT_BYTES) {
          limitExceeded = true;
          proc.kill();
          reject(new Error(`ccusage stdout is too large (limit ${MAX_STDOUT_BYTES} bytes)`));
          return;
        }
        stdout.push(chunk);
      });
      stdoutStream.on("error", reject);
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (limitExceeded) { return; }
        resolve(Buffer.concat(stdout).toString("utf-8"));
        void code;
      });
    });
    const exitCode = proc.exitCode ?? proc.killed ? 1 : 0;
    return { stdout: stdoutText, exitCode };
  } finally {
    if (proc.exitCode === null && !proc.killed) {
      proc.kill();
    }
    // 一時 HOME は子プロセス終了後に掃除する。掃除の失敗で fetch 自体を失敗させず、
    // 取得済みの結果をキャッシュフォールバックで上書きしない（best-effort）
    try {
      rmSync(emptyHome, { recursive: true, force: true });
    } catch (error) {
      console.warn(`WARN: failed to remove temporary HOME: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  } catch (error) {
    // コマンド実行・パース失敗はキャッシュフォールバックへ。ただし integrity check の失敗は
    // 改ざん検出という性質上、WARN ではなく明示的な ERROR でオペレータに知らせる
    // （キャッシュフォールバックで stale データを配信し続けても気づかないのを防ぐ）
    if (error instanceof Error && error.message.includes("integrity check failed")) {
      console.error(`ERROR: ${error.message}`);
    }
  }

  return readCache(cachePath);
}

// キャッシュを読み書きする前にディレクトリの安全性を検証する。他人が書き込み可能な
// ディレクトリでは、キャッシュの改ざん・偽造（表示データのスプーフィング）ができるため
// 所有権と 0700 を確認できなければ fail-closed（キャッシュなし扱い）にする
export function assertSafeCacheDir(cacheDir: string): void {
  const dirStat = statSync(cacheDir);
  if (typeof process.getuid === "function" && dirStat.uid !== process.getuid()) {
    throw new Error(`cache directory is not owned by the current user: ${cacheDir}`);
  }
  if ((dirStat.mode & 0o777) !== 0o700) {
    throw new Error(`cache directory is not private (mode ${(dirStat.mode & 0o777).toString(8)}, expected 0700): ${cacheDir}`);
  }
}

// キャッシュファイルのサイズ上限。ccusage の stdout 上限（MAX_STDOUT_BYTES）と同量に揃え、
// 巨大なキャッシュによる起動時 JSON.parse / メモリ消費を抑える
export const MAX_CACHE_BYTES = 64 * 1024 * 1024;

function writeCache(cachePath: string, data: UsageData): void {
  const cacheDir = dirname(cachePath);
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  // 共有ディレクトリ（例: 0755 の ~/.cache）にキャッシュを書くと他ユーザーから読まれる/改ざんされる。
  // 自分所有でも 0700 でなければ 0700 に設定し直してから、所有権と 0700 を最終検証する
  // （攻撃者が書き込み可能なディレクトリでは、共有ディレクトリの owner 以外から 0600/0700 へ
  // 再設定できないため、assertSafeCacheDir が失敗して書き込みを中止する）
  if ((statSync(cacheDir).mode & 0o777) !== 0o700) {
    chmodSync(cacheDir, 0o700);
  }
  assertSafeCacheDir(cacheDir);
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
    // 読み込み側も書込み側と同じ安全条件（所有権・0700・サイズ）で検証してから読む。
    // 他人に書かれた/偽造されたキャッシュを配信しない（fail-closed）
    assertSafeCacheDir(dirname(cachePath));
    if (statSync(cachePath).size > MAX_CACHE_BYTES) {
      throw new Error("usage cache is too large");
    }
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!isUsageData(parsed)) { throw new Error("invalid usage data shape"); }
    // キャッシュは投影済みで保存されているが、旧形式のキャッシュへの安全策として再投影する（冪等）
    return { data: projectUsageData(parsed), source: "cache" };
  } catch {
    return null;
  }
}
