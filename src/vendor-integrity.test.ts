import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CCUSAGE_WRAPPER_SHA256,
  computeWrapperHash,
  toPosixRelPath,
  computeNativeHash,
  ccusageNativePackageDir,
  expectedNativeCcusageHash,
} from "./fetch-usage";

// vendored Chart.js（public/vendor/chart.umd.min.js）の固定ハッシュ。
// バージョン: Chart.js v4.4.3（2026-08-12 時点）。vendored ファイルは bun.lock の監査対象外のため、
// 更新時は以下の対応が必須:
//   1. この CHART_SHA256 を再計算して更新する
//   2. 上記のバージョン表記を更新する
//   3. 既知 CVE（例: 旧 2.x の CVE-2020-36411 のような prototype pollution）がないか OSV / GitHub
//      Advisory で確認する（bun audit は vendored ファイルを検査しない）
const CHART_SHA256 = "473ee39a9f53b54448837634192b17bce499078fe13229b458e8d4461ea1c003";

describe("vendored assets integrity", () => {
  test("Chart.js の sha256 が固定値と一致する（更新時は明示的にハッシュを更新する）", () => {
    const buffer = readFileSync(join(import.meta.dir, "..", "public", "vendor", "chart.umd.min.js"));
    const hash = createHash("sha256").update(buffer).digest("hex");
    expect(hash).toBe(CHART_SHA256);
  });

  test("ccusage ラッパー（プラットフォーム非依存）の sha256 が固定値と一致する", () => {
    // fetch-usage の computeWrapperHash は固定値 CCUSAGE_WRAPPER_SHA256 と起動時に照合する。
    // ラッパー（node_modules/ccusage）は cli.js + config-schema.json のみでプラットフォームに
    // 依存しないため、全プラットフォームで同一の固定値を検証できる（F4）
    expect(computeWrapperHash()).toBe(CCUSAGE_WRAPPER_SHA256);
  });

  test("ハッシュ対象の相対パスは区切り文字を / に正規化する（Windows で固定値と一致しなくなるのを防ぐ）", () => {
    // Windows の readdirSync は入れ子を "\" 区切りで返す。相対パス自体をダイジェストに
    // 含めるため、正規化しないと改ざんが無くても整合性チェックが常に失敗し、
    // ダッシュボードが古いキャッシュか空表示に落ちる
    expect(toPosixRelPath("src\\cli.js", "\\")).toBe("src/cli.js");
    expect(toPosixRelPath("src/cli.js", "/")).toBe("src/cli.js");
    // 既に POSIX 形式のパスは、どの区切り文字設定でも変わらない
    expect(toPosixRelPath("config-schema.json", "\\")).toBe("config-schema.json");
  });

  test("ccusage のソースは cli.js 単体でなくパッケージ全体をハッシュ対象にする（内部モジュール改ざんの検出）", () => {
    const root = join(import.meta.dir, "..", "node_modules", "ccusage");
    const files = (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[]).filter((name) => statSync(join(root, name)).isFile());
    expect(files.length).toBeGreaterThan(1);
  });

  test("native バイナリの sha256 が現在プラットフォームの固定値と一致する（登録済みプラットフォームのみ）", () => {
    // native バイナリはプラットフォームごとに内容が異なるため、プラットフォーム別テーブルで
    // 検証する。現在のプラットフォームがテーブルに登録されていて native が存在する場合にのみ
    // 照合する（未登録プラットフォームは検証不可として WARN 扱いになる。F4）
    const expected = expectedNativeCcusageHash();
    const nativeDir = ccusageNativePackageDir();
    if (nativeDir === null || expected === null) { return; }
    expect(computeNativeHash()).toBe(expected);
  });

  test("native プラットフォーム別テーブルは現在のプラットフォームを解決できる（linux-x64 開発環境）", () => {
    // 開発環境（linux-x64）の native ハッシュがテーブルに登録されていることを確認する。
    // CI（ubuntu-latest）でも同じ値で検証が走る
    const expected = expectedNativeCcusageHash();
    expect(expected).not.toBeNull();
    expect(computeNativeHash()).toBe(expected);
  });
});
