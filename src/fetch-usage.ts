import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, closeSync, chmodSync, readdirSync, statSync, lstatSync, fstatSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { messageOf } from "./errors";
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
  // ディレクトリの存在判定（テストから差し替える）
  dirExists?: (path: string) => boolean;
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
      const path = options.userHome + suffix;
      // 存在しないディレクトリは渡さない。ccusage は指定されたディレクトリが無いと
      // エラー終了するため、使っていないエージェント（例: Claude Code 未使用）の
      // デフォルトを常に渡すと、取得が丸ごと失敗して常に空のダッシュボードになる
      const exists = options.dirExists ?? ((target: string) => existsSync(target));
      if (exists(path)) { result[key] = path; }
    }
  }
  return result;
}

// npm / bun のフラットな node_modules では依存が兄弟にホイストされるため、
// 配布物の <packageDir>/node_modules/<name> は存在しない。ここを決め打ちにすると、
// npx / bunx で入れた配布版では cli.js が見つからず、データ取得も整合性検証も必ず失敗する。
// Node の解決規則で実際の位置を求め、解決できない場合のみネストパスにフォールバックする。
// createRequire は Bun / Node どちらでも動く（Bun.resolveSync は Node 実行時に使えない）
export function resolvePackageRoot(name: string, packageDir: string = PACKAGE_DIR): string {
  try {
    const requireFrom = createRequire(join(packageDir, "package.json"));
    return dirname(requireFrom.resolve(`${name}/package.json`));
  } catch {
    return join(packageDir, "node_modules", ...name.split("/"));
  }
}

export function ccusagePackageRoot(packageDir: string = PACKAGE_DIR): string {
  return resolvePackageRoot("ccusage", packageDir);
}

export function ccusageCliPath(packageDir: string = PACKAGE_DIR): string {
  return join(ccusagePackageRoot(packageDir), "src", "cli.js");
}

// ccusage@20.0.19 のラッパー（node_modules/ccusage = cli.js + config-schema.json）の sha256。
// ラッパーは cli.js + config-schema.json のみでプラットフォーム非依存のため、全プラットフォームで
// 同一の固定値を照合できる。依存を更新した場合は再計算して必ず更新する
// （vendor-integrity.test.ts の固定値と同一アルゴリズムで算出する）
export const CCUSAGE_WRAPPER_SHA256 = "986573dbd113bcf093a5dd9a5253f26ebdd97500daa4ad64d53af19d2bc1c1f4";

// 実行プラットフォームの native バイナリ（@ccusage/ccusage-<platform>-<arch>）の sha256。
// native バイナリはプラットフォームごとに内容が異なるため、プラットフォーム別テーブルで照合する。
// 登録値は ccusage@20.0.19 の npm tarball（registry が配布する実体）から、hashPackageFiles と
// 同一アルゴリズムで計算した固定値（linux-x64 は node_modules 実インストールとの一致を裏取り済み）。
// 依存を更新した場合は全プラットフォームで再計算して必ず更新する
export const CCUSAGE_NATIVE_SHA256_BY_PLATFORM: Record<string, string> = {
  "darwin-arm64": "544ece2253789f1dfbce508ef76f71bf715d85e81bc3d43c025ddb5691fd2dfc",
  "darwin-x64": "a4394b106a783c792250bfc345d8454a68a1c9eb80935ae2d827787882fc81f1",
  "linux-arm64": "c01dfdd9701dd8fe1897e3981c88ffe6c18a6c30c48b6348ff3e9501b80ee458",
  "linux-x64": "2dfeb9fef4617794b35ef14e934127dd3f4a29a2afc922868c0f5595e79b6188",
  "win32-arm64": "5874189a8432f09b3a0d39e010562d674e4a7762fd47c19f771b899921feaf46",
  "win32-x64": "7b0e9b30d1ef25da43c45554e8b91cd0963ac938532ae6a4dd0d8bf0cb7fffb4",
};

// プラットフォームキー（"linux-x64" 等）。native バイナリのハッシュ対象と期待値テーブルの
// 解決を同一キーに揃える（platform と arch で別々に持ち回らず、1 箇所に集約する）
export function ccusagePlatformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

// 現在プラットフォームの native 期待ハッシュ。未登録なら null（検証不可）
export function expectedNativeCcusageHash(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  return CCUSAGE_NATIVE_SHA256_BY_PLATFORM[ccusagePlatformKey(platform, arch)] ?? null;
}

// 未登録プラットフォーム（ハッシュ検証不可）の扱いを決める環境変数。
// 明示オプトインなしでは検証できない native バイナリを実行しない（fail-closed）
export function isAllowUnverifiedNative(env: Record<string, string | undefined>): boolean {
  return env.CCUSAGE_LEDGER_ALLOW_UNVERIFIED_NATIVE === "1" || env.CCUSAGE_LEDGER_ALLOW_UNVERIFIED_NATIVE === "true";
}

// native ハッシュの検証方針を純関数として決定する。
// verified: ハッシュ登録済み（照合する）/ unverified-override: 未登録だが明示オプトインあり（WARN で続行）
// / refuse: 未登録かつオプトインなし（実行拒否）
export function nativeIntegrityPolicy(
  env: Record<string, string | undefined>,
  expected: string | null,
): "verified" | "unverified-override" | "refuse" {
  if (expected !== null) { return "verified"; }
  return isAllowUnverifiedNative(env) ? "unverified-override" : "refuse";
}

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
  // native パッケージもホイストされ得るため、ラッパーと同じ解決規則で位置を求める
  const root = resolvePackageRoot(name, packageDir);
  return existsSync(root) ? root : null;
}

// ディレクトリ配下の全ファイルを「相対パス + ':' + 内容」の連結でハッシュする。
// 相対パス自体をダイジェストに含めるため、区切り文字を "/" に正規化してから並べ替え・ハッシュする
// （Windows の readdirSync は入れ子を "\" 区切りで返すため、正規化しないと同一内容でも
//   固定値と一致せず、改ざんが無いのに整合性チェックが常に失敗する）
export function toPosixRelPath(name: string, separator: string = sep): string {
  return name.split(separator).join("/");
}

function hashPackageFiles(root: string): string {
  const files = (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .filter((name) => statSync(join(root, name)).isFile())
    .map((name) => ({ name, key: toPosixRelPath(name) }))
    .sort((a, b) => {
      if (a.key < b.key) { return -1; }
      return a.key > b.key ? 1 : 0;
    });
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.key);
    hash.update(":");
    hash.update(readFileSync(join(root, file.name)));
  }
  return hash.digest("hex");
}

// ラッパー（node_modules/ccusage）の sha256。プラットフォーム非依存のため、CCUSAGE_WRAPPER_SHA256 と
// 全プラットフォームで照合できる
export function computeWrapperHash(packageDir: string = PACKAGE_DIR): string {
  return hashPackageFiles(ccusagePackageRoot(packageDir));
}

// 実行プラットフォームの native バイナリの sha256。native がインストールされていない場合は null。
// 期待値（CCUSAGE_NATIVE_SHA256_BY_PLATFORM）と同じプラットフォームキーでハッシュ対象を解決する
export function computeNativeHash(packageDir: string = PACKAGE_DIR): string | null {
  const nativeRoot = ccusageNativePackageDir(packageDir);
  if (nativeRoot === null) { return null; }
  return hashPackageFiles(nativeRoot);
}

// 旧来の combined ハッシュ（ラッパー + native を連結）はプラットフォーム非依存ではないため、
// 単一固定値として使えない。代わりに computeWrapperHash / computeNativeHash を
// それぞれ CCUSAGE_WRAPPER_SHA256 / CCUSAGE_NATIVE_SHA256_BY_PLATFORM と照合する

function assertCcusageIntegrity(packageDir: string = PACKAGE_DIR): void {
  // インストール済みの ccusage が改ざんされていないかを起動ごとに検証する。
  // ラッパーは全プラットフォームで固定値と照合し、native バイナリはプラットフォーム別テーブルが
  // 登録済みのプラットフォームでのみ照合する（F4）。
  // 環境変数経由の秘密は allowlist で守れるが、ファイルベースの秘密（~/.claude 等）は
  // 依存が悪意を持つと読まれ得る（AGENTS.md 記載の残余リスク）。このチェックは
  // ローカル/レジストリ上での post-install 改ざんを検出する defense-in-depth であり、
  // 固定版そのものの悪意ある publish は検知できない（限界を明示）
  const wrapperHash = computeWrapperHash(packageDir);
  if (wrapperHash !== CCUSAGE_WRAPPER_SHA256) {
    throw new Error(
      `ccusage integrity check failed (expected wrapper sha256 ${CCUSAGE_WRAPPER_SHA256}, got ${wrapperHash}). ` +
        "The installed ccusage package differs from the pinned version. Re-run `bun install` to restore it.",
    );
  }

  const nativeHash = computeNativeHash(packageDir);
  if (nativeHash === null) {
    // native が無い環境では cli.js が「native binary is not available」で失敗するため、
    // ここで検証不可として fail させる必要はない
    return;
  }
  const expected = expectedNativeCcusageHash();
  if (expected === null) {
    // native はプラットフォームごとに内容が異なるため、未登録プラットフォームでは照合できない。
    // 検証できないバイナリを黙って実行すると改ざん検出の意味が無くなるため、明示オプトイン
    // （CCUSAGE_LEDGER_ALLOW_UNVERIFIED_NATIVE=1）なしでは実行を拒否する（fail-closed。
    // ハッシュの登録方法は CCUSAGE_NATIVE_SHA256_BY_PLATFORM のコメントを参照）
    const policy = nativeIntegrityPolicy(process.env, null);
    if (policy === "unverified-override") {
      console.warn(
        `WARN: ccusage native binary integrity is not verified on ${ccusagePlatformKey()} (no expected hash recorded). ` +
          "Running with CCUSAGE_LEDGER_ALLOW_UNVERIFIED_NATIVE=1 override.",
      );
      return;
    }
    throw new Error(
      `ccusage native binary integrity cannot be verified on ${ccusagePlatformKey()} (no expected hash recorded). ` +
        "Refusing to run an unverified native binary. Set CCUSAGE_LEDGER_ALLOW_UNVERIFIED_NATIVE=1 to override, " +
        "or add the hash to CCUSAGE_NATIVE_SHA256_BY_PLATFORM.",
    );
  }
  if (nativeHash !== expected) {
    throw new Error(
      `ccusage native binary integrity check failed (expected sha256 ${expected}, got ${nativeHash}). ` +
        "The installed ccusage native binary differs from the pinned version. Re-run `bun install` to restore it.",
    );
  }
}

// 実行中インタプリタ（process.execPath）で cli.js を直接起動する。
// bunx / npx どちらで起動しても、process.execPath が bun / node を自動解決するため
// ランタイム非依存になる（PATH ハイジャック対策も兼ねる）
export function buildCcusageCommand(cliPath: string, args: string[], execPath: string = process.execPath): string[] {
  return [execPath, cliPath, ...args];
}

// 子プロセスの stdout をバイト上限付きで読み切る（巨大出力でメモリを枯渇させない）。
// Web ReadableStream と Node の Readable の両方が async iteration に対応しているため、
// defaultSpawn の stdout（node:child_process の Readable）とテストの ReadableStream の
// 両方でこの 1 実装を使える（stdout 上限のロジックを 1 箇所に集約する）
export const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export async function readStdoutWithLimit(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number = MAX_STDOUT_BYTES,
): Promise<string> {
  // TextDecoder をストリーミングで使うと、全チャンク保持 + マージコピーの二重メモリを回避できる
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`ccusage stdout is too large (limit ${maxBytes} bytes)`);
    }
    parts.push(decoder.decode(chunk, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

// 子プロセスの終了コードを待つ。timeout や kill でシグナル終了した場合は code が null に
// なるため、失敗（1）として扱う（呼び出し側は exitCode === 0 のみを成功とみなす）。
// spawn 失敗（ENOENT 等）は 'error' で通知されるため、reject して読み込みのハングを防ぐ
export interface ExitTimeoutOptions {
  timeoutMs: number;
  terminationGraceMs: number;
  forceKillWaitMs: number;
  onTimeout?: () => void;
}

export function waitForExit(proc: ChildProcess, timeout?: ExitTimeoutOptions): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let forceCompletionTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = (): void => {
      if (terminationTimer) { clearTimeout(terminationTimer); }
      if (forceKillTimer) { clearTimeout(forceKillTimer); }
      if (forceCompletionTimer) { clearTimeout(forceCompletionTimer); }
      proc.off("error", onError);
      proc.off("close", onClose);
    };
    const finish = (action: () => void): void => {
      if (settled) { return; }
      settled = true;
      cleanup();
      action();
    };
    const onError = (error: Error): void => finish(() => reject(error));
    const onClose = (code: number | null): void => finish(() => resolve(code ?? 1));
    proc.on("error", onError);
    proc.on("close", onClose);

    if (timeout) {
      terminationTimer = setTimeout(() => {
        timeout.onTimeout?.();
        proc.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          proc.kill("SIGKILL");
          forceCompletionTimer = setTimeout(
            () => finish(() => resolve(1)),
            timeout.forceKillWaitMs,
          );
        }, timeout.terminationGraceMs);
      }, timeout.timeoutMs);
    }
  });
}

export async function collectProcessOutput(
  proc: ChildProcess,
  timeout: ExitTimeoutOptions,
): Promise<SpawnResult> {
  const stdout = proc.stdout;
  if (stdout === null) { throw new Error("ccusage stdout is not available"); }
  const timeoutError = new Error("ccusage process timed out");
  const [output, exitCode] = await Promise.all([
    readStdoutWithLimit(stdout),
    waitForExit(proc, {
      ...timeout,
      onTimeout: () => {
        stdout.destroy(timeoutError);
        timeout.onTimeout?.();
      },
    }),
  ]);
  return { stdout: output, exitCode };
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
  const command = buildCcusageCommand(cliPath, args);
  // spawn は同期 throw し得るため、spawn 自体を try の内側で行う。これにより mkdtempSync で
  // 作った一時 HOME が、spawn 失敗時に finally の掃除から漏れずに残らない
  let proc: ChildProcess | null = null;
  try {
    // spawn の stdio タプル指定は戻り値型を never に縮約するため、ChildProcess として明示する
    proc = spawn(command[0]!, command.slice(1), {
      env: spawnEnv(process.env, { userHome: userHomeDir(process.env), emptyHome }),
      stdio: ["ignore", "pipe", "ignore"] as const,
    });

    // stdout をバイト上限付きで収集する（readStdoutWithLimit と同一実装）。上限超過時は
    // readStdoutWithLimit が throw し、finally の kill で子プロセスを止めて読み止めのまま
    // 残留するのを防ぐ（Bun.spawn の頃のタイムアウト残留対策と同様）
    // stdout の読み切りと終了待ちを同時に開始する。Promise.all は両方に即座にハンドラを
    // 付けるため、片方が reject しても、もう片方が unhandled rejection にならない。
    // stdout の EOF は必ずしもプロセス終了と同時ではないため、exitCode は 'close' を
    // 待って読む（待たずに proc.exitCode を見ると null になり、失敗を成功と誤判定する）
    return await collectProcessOutput(proc, {
      timeoutMs: 60_000,
      terminationGraceMs: 1_000,
      forceKillWaitMs: 1_000,
    });
  } finally {
    if (proc !== null && proc.exitCode === null && !proc.killed) {
      proc.kill();
    }
    // 一時 HOME は子プロセス終了後に掃除する。掃除の失敗で fetch 自体を失敗させず、
    // 取得済みの結果をキャッシュフォールバックで上書きしない（best-effort）
    try {
      rmSync(emptyHome, { recursive: true, force: true });
    } catch (error) {
      console.warn(`WARN: failed to remove temporary HOME: ${messageOf(error)}`);
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
          console.warn(`WARN: failed to write usage cache: ${messageOf(error)}`);
        }
        return { data: projected, source: "fresh" };
      }
      // スキーマ不一致の出力はキャッシュへフォールバックする。警告なしで静かに stale を
      // 配信し続けないよう、ここで WARN を出す（integrity check の失敗は下の catch で ERROR）
      console.warn("WARN: ccusage produced invalid usage data; falling back to cache");
    } else {
      console.warn(`WARN: ccusage exited with code ${result.exitCode}; falling back to cache`);
    }
  } catch (error) {
    // コマンド実行・パース失敗はキャッシュフォールバックへ。ただし integrity check の失敗は
    // 改ざん検出という性質上、WARN ではなく明示的な ERROR でオペレータに知らせる
    // （キャッシュフォールバックで stale データを配信し続けても気づかないのを防ぐ）
    if (error instanceof Error && error.message.includes("integrity check failed")) {
      console.error(`ERROR: ${error.message}`);
    } else {
      console.warn(`WARN: ccusage fetch failed; falling back to cache: ${messageOf(error)}`);
    }
  }

  return readCache(cachePath);
}

// ディレクトリのパーミッションが 0700（所有者のみ読み書き可）かどうか。
// assertSafeCacheDir（検証）と writeCache（修復）が同じ判定を使うための共通ヘルパー
function isPrivateDirMode(mode: number): boolean {
  return (mode & 0o777) === 0o700;
}

// キャッシュを読み書きする前にディレクトリの安全性を検証する。他人が書き込み可能な
// ディレクトリでは、キャッシュの改ざん・偽造（表示データのスプーフィング）ができるため
// 所有権と 0700 を確認できなければ fail-closed（キャッシュなし扱い）にする
export function assertSafeCacheDir(cacheDir: string): void {
  const dirStat = statSync(cacheDir);
  if (typeof process.getuid === "function" && dirStat.uid !== process.getuid()) {
    throw new Error(`cache directory is not owned by the current user: ${cacheDir}`);
  }
  if (!isPrivateDirMode(dirStat.mode)) {
    throw new Error(`cache directory is not private (mode ${(dirStat.mode & 0o777).toString(8)}, expected 0700): ${cacheDir}`);
  }
}

// キャッシュファイルのサイズ上限。ccusage の stdout 上限（MAX_STDOUT_BYTES）と同量に揃え、
// 巨大なキャッシュによる起動時 JSON.parse / メモリ消費を抑える。stdout と別値にすると
// 片方だけが変わる事故を防ぐため、MAX_STDOUT_BYTES から導出する
export const MAX_CACHE_BYTES = MAX_STDOUT_BYTES;

function writeCache(cachePath: string, data: UsageData): void {
  const cacheDir = dirname(cachePath);
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  // 共有ディレクトリ（例: 0755 の ~/.cache）にキャッシュを書くと他ユーザーから読まれる/改ざんされる。
  // 自分所有でも 0700 でなければ 0700 に設定し直してから、所有権と 0700 を最終検証する
  // （攻撃者が書き込み可能なディレクトリでは、共有ディレクトリの owner 以外から 0600/0700 へ
  // 再設定できないため、assertSafeCacheDir が失敗して書き込みを中止する）
  if (!isPrivateDirMode(statSync(cacheDir).mode)) {
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

// キャッシュを安全条件（所有権・0700・サイズ上限）付きで読み込む単一実装。
// server.ts の createApp もこの関数を共用するため、起動時読み込みと fetchUsage の
// フォールバックで同一の検証列が走る（検証ロジックの二重実装を避ける）
export function readCache(cachePath: string): FetchUsageResult | null {
  try {
    // 読み込み側も書込み側と同じ安全条件（所有権・0700・サイズ）で検証してから読む。
    // 他人に書かれた/偽造されたキャッシュを配信しない（fail-closed）
    assertSafeCacheDir(dirname(cachePath));
    // lstat で symlink 自体を拒否する（statSync / readFileSync はリンク先を追うため、
    // 検証だけでは同一ユーザーが仕掛けた symlink 経由の偽造 JSON を配信してしまう。
    // writeExportedHtml と同じ安全条件。attack-review F22）
    if (lstatSync(cachePath).isSymbolicLink()) {
      throw new Error("usage cache is a symbolic link");
    }
    // サイズ検証と読取を同一 fd で行う（statSync → readFileSync の間に対象が
    // 差し替わる TOCTOU を避け、「検証した対象」と「読む対象」を一致させる。attack-review F22）
    const fd = openSync(cachePath, "r");
    let parsed: unknown;
    try {
      if (fstatSync(fd).size > MAX_CACHE_BYTES) {
        throw new Error("usage cache is too large");
      }
      parsed = JSON.parse(readFileSync(fd, "utf-8"));
    } finally {
      closeSync(fd);
    }
    if (!isUsageData(parsed)) { throw new Error("invalid usage data shape"); }
    // キャッシュは投影済みで保存されているが、旧形式のキャッシュへの安全策として再投影する（冪等）
    return { data: projectUsageData(parsed), source: "cache" };
  } catch {
    return null;
  }
}
