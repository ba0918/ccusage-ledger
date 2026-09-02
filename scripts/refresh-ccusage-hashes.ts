// ccusage を更新したときに、起動ごとの整合性照合で使う固定値を再計算して書き戻す。
//
//   bun run refresh-ccusage-hashes          # src/fetch-usage.ts などを書き換える
//   bun run refresh-ccusage-hashes --check  # 書き換えず、更新が必要かどうかだけを終了コードで返す
//
// 対象は CCUSAGE_WRAPPER_SHA256 と CCUSAGE_NATIVE_SHA256_BY_PLATFORM の全プラットフォーム。
// native バイナリはプラットフォームごとに内容が異なり、ローカルの node_modules には実行中の
// プラットフォームの 1 つしか入らないため、registry が配布する npm tarball を実体として計算する。
//
// tarball は「bun.lock に記録された sha512 と一致すること」を確認してから展開する。これにより、
// 固定値が `bun install --frozen-lockfile` で実際に入るバイトから導かれることが保証される
// （registry から取り直した別物や、途中で差し替えられたものを掴んで固定値化するのを防ぐ）。
// ハッシュの計算には src/fetch-usage.ts の hashPackageFiles をそのまま使う。起動時の照合と
// 同じ関数を通すことで、算出側と検証側のアルゴリズムがずれることが構造的に起きない。
//
// 展開には tar コマンドを使う（Linux / macOS / Windows 10 以降に同梱）。開発用スクリプトのため
// 配布物には含まれない（package.json の files は明示リスト）。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCUSAGE_NATIVE_SHA256_BY_PLATFORM, ccusageNativePackageName, hashPackageFiles } from "../src/fetch-usage";

const REGISTRY = "https://registry.npmjs.org";
const WRAPPER_PACKAGE = "ccusage";
const REPO_ROOT = join(import.meta.dir, "..");
const FETCH_USAGE_FILE = "src/fetch-usage.ts";

// 固定版の表記を追従させるファイル。ハッシュだけ更新して版数の記述が古いまま残ると、
// 「どの版に対する固定値なのか」が読み取れなくなるため、同じ操作でまとめて直す
const VERSION_DOC_FILES = [
  FETCH_USAGE_FILE,
  "src/vendor-integrity.test.ts",
  "README.md",
  "AGENTS.md",
  "docs/spec/dashboard.md",
];

// package.json の dependencies に固定した ccusage の版。範囲指定（^ や ~）では
// 「どの実体を固定値にしたか」が一意に決まらないため受け付けない
export function pinnedCcusageVersion(packageJson: string): string {
  const parsed = JSON.parse(packageJson) as { dependencies?: Record<string, string> };
  const version = parsed.dependencies?.[WRAPPER_PACKAGE];
  if (version === undefined) {
    throw new Error(`package.json の dependencies に ${WRAPPER_PACKAGE} がありません`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${WRAPPER_PACKAGE} は完全固定の版である必要があります（現在: ${version}）`);
  }
  return version;
}

// bun.lock のパッケージ表から名前 -> integrity（sha512-...）を取り出す。
// 各行は "<name>": ["<name>@<version>", ..., "<integrity>"] の形で、integrity は末尾の要素
export function parseLockIntegrity(lockText: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /^\s*"([^"]+)":\s*\[.*"(sha512-[^"]+)"\s*\],?\s*$/gm;
  for (const match of lockText.matchAll(pattern)) {
    found.set(match[1]!, match[2]!);
  }
  return found;
}

// scoped パッケージの tarball 名からはスコープが落ちる
// （@ccusage/ccusage-linux-x64 -> ccusage-linux-x64-<version>.tgz）
export function tarballUrl(name: string, version: string): string {
  const base = name.startsWith("@") ? name.split("/")[1]! : name;
  return `${REGISTRY}/${name}/-/${base}-${version}.tgz`;
}

export function integrityOf(tarball: Uint8Array): string {
  return `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
}

// プラットフォームキー（"linux-x64"）から native パッケージ名を引く。
// 実行時の解決と同じ表を通すため、キーの綴りがずれれば解決できずに失敗する
export function nativePackageNameForKey(key: string): string {
  const parts = key.split("-");
  if (parts.length !== 2) {
    throw new Error(`プラットフォームキーの形式が不正です: ${key}`);
  }
  const name = ccusageNativePackageName(parts[0]!, parts[1]!);
  if (name === null) {
    throw new Error(`プラットフォームキー ${key} に対応する native パッケージがありません`);
  }
  return name;
}

export function replaceWrapperHash(source: string, hash: string): string {
  const pattern = /(export const CCUSAGE_WRAPPER_SHA256 = ")[0-9a-f]{64}(")/;
  if (!pattern.test(source)) {
    throw new Error("CCUSAGE_WRAPPER_SHA256 の宣言が見つかりません");
  }
  return source.replace(pattern, `$1${hash}$2`);
}

export function replaceNativeTable(source: string, table: Record<string, string>): string {
  const pattern = /(export const CCUSAGE_NATIVE_SHA256_BY_PLATFORM: Record<string, string> = \{\n)[^}]*(\};)/;
  if (!pattern.test(source)) {
    throw new Error("CCUSAGE_NATIVE_SHA256_BY_PLATFORM の宣言が見つかりません");
  }
  const body = Object.keys(table)
    .sort()
    .map((key) => `  "${key}": "${table[key]!}",\n`)
    .join("");
  return source.replace(pattern, `$1${body}$2`);
}

// コメント・ドキュメント中の "ccusage@<版>" を追従させる。版数を伴う表記だけを対象にするため、
// パッケージ名だけの言及や、無関係な文字列は書き換わらない
export function replacePinnedVersion(source: string, to: string): string {
  return source.replace(new RegExp(`${WRAPPER_PACKAGE}@\\d+\\.\\d+\\.\\d+`, "g"), `${WRAPPER_PACKAGE}@${to}`);
}

async function downloadVerifiedPackage(name: string, version: string, expectedIntegrity: string): Promise<Uint8Array> {
  const url = tarballUrl(name, version);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${name}@${version} の取得に失敗しました（${response.status} ${url}）`);
  }
  const tarball = new Uint8Array(await response.arrayBuffer());
  const actual = integrityOf(tarball);
  if (actual !== expectedIntegrity) {
    throw new Error(
      `${name}@${version} の tarball が bun.lock の integrity と一致しません。\n` +
        `  bun.lock: ${expectedIntegrity}\n  registry: ${actual}`,
    );
  }
  return tarball;
}

// tarball を一時ディレクトリへ展開し、node_modules に入るのと同じ配置でハッシュを計算する
// （npm tarball の中身は package/ 配下にあるため 1 段剥がす）
function hashTarball(tarball: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "ccusage-hash-"));
  try {
    execFileSync("tar", ["-xz", "-C", dir, "--strip-components=1"], { input: tarball });
    return hashPackageFiles(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const version = pinnedCcusageVersion(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
  const integrity = parseLockIntegrity(readFileSync(join(REPO_ROOT, "bun.lock"), "utf-8"));

  const integrityFor = (name: string): string => {
    const value = integrity.get(name);
    if (value === undefined) {
      throw new Error(`bun.lock に ${name} の integrity がありません。先に bun install を実行してください`);
    }
    return value;
  };

  console.log(`ccusage@${version} の固定値を再計算します`);

  const wrapperHash = hashTarball(
    await downloadVerifiedPackage(WRAPPER_PACKAGE, version, integrityFor(WRAPPER_PACKAGE)),
  );
  console.log(`  ${"wrapper".padEnd(13)} ${wrapperHash}`);

  // 登録済みのプラットフォームをそのまま再計算する。網羅性は vendor-integrity.test.ts が
  // 全 6 プラットフォームの登録を要求することで担保されている
  const nativeTable: Record<string, string> = {};
  for (const key of Object.keys(CCUSAGE_NATIVE_SHA256_BY_PLATFORM).sort()) {
    const name = nativePackageNameForKey(key);
    const hash = hashTarball(await downloadVerifiedPackage(name, version, integrityFor(name)));
    nativeTable[key] = hash;
    console.log(`  ${key.padEnd(13)} ${hash}`);
  }

  const changed: string[] = [];
  const write = (file: string, source: string, updated: string): void => {
    if (updated === source) {
      return;
    }
    if (!changed.includes(file)) {
      changed.push(file);
    }
    if (!check) {
      writeFileSync(join(REPO_ROOT, file), updated);
    }
  };

  const fetchUsage = readFileSync(join(REPO_ROOT, FETCH_USAGE_FILE), "utf-8");
  write(FETCH_USAGE_FILE, fetchUsage, replaceNativeTable(replaceWrapperHash(fetchUsage, wrapperHash), nativeTable));

  for (const file of VERSION_DOC_FILES) {
    // src/fetch-usage.ts は直前にハッシュを書き戻しているため、版数の置換はディスク上の
    // 最新内容に対して行う（--check では書き戻していないので元の内容のままでよい）
    const source = readFileSync(join(REPO_ROOT, file), "utf-8");
    write(file, source, replacePinnedVersion(source, version));
  }

  if (changed.length === 0) {
    console.log("固定値・版数の記述はすべて最新です");
    return;
  }
  if (check) {
    console.error(`更新が必要です: ${changed.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`更新しました: ${changed.join(", ")}`);
  console.log("bun test で整合性テストが通ることを確認してください");
}

// テストから純粋関数だけを import できるよう、直接実行されたときだけ走らせる
if (import.meta.main) {
  await main();
}
