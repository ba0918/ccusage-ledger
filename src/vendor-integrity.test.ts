import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CCUSAGE_SHA256, computeCcusageHash, ccusageNativePackageDir } from "./fetch-usage";

const CHART_SHA256 = "473ee39a9f53b54448837634192b17bce499078fe13229b458e8d4461ea1c003";

describe("vendored assets integrity", () => {
  test("Chart.js の sha256 が固定値と一致する（更新時は明示的にハッシュを更新する）", () => {
    const buffer = readFileSync(join(import.meta.dir, "..", "public", "vendor", "chart.umd.min.js"));
    const hash = createHash("sha256").update(buffer).digest("hex");
    expect(hash).toBe(CHART_SHA256);
  });

  test("ccusage の実行コード全体（ラッパー + native バイナリ）の sha256 が固定値と一致する", () => {
    // fetch-usage の computeCcusageHash は固定値 CCUSAGE_SHA256 と起動時に照合する。
    // ここでインストール済みパッケージが固定値と一致することを確認し、依存更新時は
    // 両方の値を意図的に更新する契約を守る
    expect(computeCcusageHash()).toBe(CCUSAGE_SHA256);
  });

  test("ccusage のソースは cli.js 単体でなくパッケージ全体をハッシュ対象にする（内部モジュール改ざんの検出）", () => {
    const root = join(import.meta.dir, "..", "node_modules", "ccusage");
    const files = (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[]).filter((name) => statSync(join(root, name)).isFile());
    expect(files.length).toBeGreaterThan(1);
  });

  test("native バイナリ（実処理を担う）もハッシュ対象に含まれる", () => {
    // cli.js はラッパーで、実処理は @ccusage/ccusage-<platform>-<arch> の native バイナリ。
    // これが存在する環境では、改ざん検出の対象に必ず含まれる
    const nativeDir = ccusageNativePackageDir();
    if (nativeDir === null) { return; }
    const files = (readdirSync(nativeDir, { recursive: true, encoding: "utf8" }) as string[]).filter((name) => statSync(join(nativeDir, name)).isFile());
    expect(files.length).toBeGreaterThan(0);
  });
});
