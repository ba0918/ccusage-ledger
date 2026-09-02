import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  integrityOf,
  nativePackageNameForKey,
  parseLockIntegrity,
  pinnedCcusageVersion,
  replaceNativeTable,
  replacePinnedVersion,
  replaceWrapperHash,
  tarballUrl,
} from "./refresh-ccusage-hashes";
import { CCUSAGE_NATIVE_SHA256_BY_PLATFORM } from "../src/fetch-usage";

const REPO_ROOT = join(import.meta.dir, "..");
const A = "a".repeat(64);
const B = "b".repeat(64);

describe("refresh-ccusage-hashes", () => {
  test("固定した版だけを受け付ける（範囲指定は固定値の根拠にならない）", () => {
    expect(pinnedCcusageVersion(`{"dependencies":{"ccusage":"20.0.20"}}`)).toBe("20.0.20");
    expect(() => pinnedCcusageVersion(`{"dependencies":{"ccusage":"^20.0.20"}}`)).toThrow();
    expect(() => pinnedCcusageVersion(`{"dependencies":{}}`)).toThrow();
  });

  test("bun.lock から integrity を取り出す", () => {
    const lock = [
      "  packages: {",
      `    "ccusage": ["ccusage@20.0.20", "", { "bin": { "ccusage": "./src/cli.js" } }, "sha512-AAA=="],`,
      "",
      `    "hono": ["hono@4.13.5", "", {}, "sha512-BBB=="],`,
      "  }",
    ].join("\n");
    const found = parseLockIntegrity(lock);
    expect(found.get("ccusage")).toBe("sha512-AAA==");
    expect(found.get("hono")).toBe("sha512-BBB==");
  });

  test("実際の bun.lock から ccusage と全 native パッケージを解決できる", () => {
    // 表の綴りや lockfile の書式が変わって解決できなくなると、スクリプトは
    // 「更新なし」ではなく失敗すべきなので、実ファイルに対して確認する
    const found = parseLockIntegrity(readFileSync(join(REPO_ROOT, "bun.lock"), "utf-8"));
    expect(found.get("ccusage")).toMatch(/^sha512-/);
    for (const key of Object.keys(CCUSAGE_NATIVE_SHA256_BY_PLATFORM)) {
      expect(found.get(nativePackageNameForKey(key)), `${key} の integrity が引ける`).toMatch(/^sha512-/);
    }
  });

  test("scoped パッケージの tarball URL はスコープを落とす", () => {
    expect(tarballUrl("ccusage", "20.0.20")).toBe("https://registry.npmjs.org/ccusage/-/ccusage-20.0.20.tgz");
    expect(tarballUrl("@ccusage/ccusage-linux-x64", "20.0.20")).toBe(
      "https://registry.npmjs.org/@ccusage/ccusage-linux-x64/-/ccusage-linux-x64-20.0.20.tgz",
    );
  });

  test("integrity は bun.lock と同じ表記（sha512- + base64）で算出する", () => {
    // 空入力の sha512 は既知の値。base64 化まで含めて bun.lock の書式と一致することを確認する
    expect(integrityOf(new Uint8Array())).toBe(
      "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
    );
  });

  test("プラットフォームキーから native パッケージ名を引く", () => {
    expect(nativePackageNameForKey("linux-x64")).toBe("@ccusage/ccusage-linux-x64");
    expect(() => nativePackageNameForKey("linux")).toThrow();
    expect(() => nativePackageNameForKey("plan9-x64")).toThrow();
  });

  test("wrapper の固定値を置き換える", () => {
    const source = `export const CCUSAGE_WRAPPER_SHA256 = "${A}";\n`;
    expect(replaceWrapperHash(source, B)).toBe(`export const CCUSAGE_WRAPPER_SHA256 = "${B}";\n`);
  });

  test("宣言が見つからない場合は黙って素通しせず失敗する", () => {
    // 置換に失敗したまま「更新なし」で終わると、古い固定値のまま気づかず公開してしまう
    expect(() => replaceWrapperHash("const OTHER = 1;\n", B)).toThrow();
    expect(() => replaceNativeTable("const OTHER = 1;\n", { "linux-x64": B })).toThrow();
  });

  test("native テーブルを丸ごと置き換え、キー順で出力する", () => {
    const source = [
      "export const CCUSAGE_NATIVE_SHA256_BY_PLATFORM: Record<string, string> = {",
      `  "linux-x64": "${A}",`,
      "};",
      "",
      "export const AFTER = 1;",
      "",
    ].join("\n");
    const updated = replaceNativeTable(source, { "linux-x64": B, "darwin-arm64": A });
    expect(updated).toBe(
      [
        "export const CCUSAGE_NATIVE_SHA256_BY_PLATFORM: Record<string, string> = {",
        `  "darwin-arm64": "${A}",`,
        `  "linux-x64": "${B}",`,
        "};",
        "",
        "export const AFTER = 1;",
        "",
      ].join("\n"),
    );
  });

  test("版数の表記だけを追従させる（パッケージ名だけの言及は変えない）", () => {
    const source = "固定した `ccusage@20.0.19` を実行する。ccusage は外部コード。ccusage@20.0.19 の tarball。";
    expect(replacePinnedVersion(source, "20.0.20")).toBe(
      "固定した `ccusage@20.0.20` を実行する。ccusage は外部コード。ccusage@20.0.20 の tarball。",
    );
  });

  test("リポジトリ内に古い版数の表記が残っていない", () => {
    // ハッシュだけ更新して版数が取り残されると、どの版に対する固定値か読み取れなくなる
    const version = pinnedCcusageVersion(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
    for (const file of ["src/fetch-usage.ts", "src/vendor-integrity.test.ts", "README.md", "AGENTS.md", "docs/spec/dashboard.md"]) {
      const source = readFileSync(join(REPO_ROOT, file), "utf-8");
      for (const match of source.matchAll(/ccusage@(\d+\.\d+\.\d+)/g)) {
        expect(match[1], `${file} の ccusage@ 表記が package.json と一致する`).toBe(version);
      }
    }
  });
});
