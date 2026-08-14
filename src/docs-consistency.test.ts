import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT, USAGE } from "./server";

// 既定ポートやオプションを変えたときに、コード側だけ直してドキュメントが取り残される
// （あるいはその逆）のを防ぐ。0.1.2 で既定ポートを 3000 → 3737 に変えた際、
// createApp の既定値と --help / README / 仕様書がそれぞれ別々にずれた経緯がある
const ROOT = join(import.meta.dir, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf-8");
const SPEC = readFileSync(join(ROOT, "docs", "spec", "dashboard.md"), "utf-8");

// README の設定表（| `NAME` | ... |）から環境変数名を取り出す。
// 表に載っていない散文中の言及（エクスポート専用の変数など）は対象外
function readmeEnvNames(markdown: string): string[] {
  const names: string[] = [];
  for (const match of markdown.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)) {
    names.push(match[1]!);
  }
  return names;
}

// --help の Environment セクションに並ぶ環境変数名を取り出す
function usageEnvNames(usage: string): string[] {
  const section = usage.slice(usage.indexOf("Environment:"));
  const names: string[] = [];
  for (const match of section.matchAll(/^ {2}([A-Z][A-Z0-9_]*)\s{2,}\S/gm)) {
    names.push(match[1]!);
  }
  return names;
}

describe("ドキュメントとコードの整合性", () => {
  test("--help・README・仕様書が同じ既定ポートを示す", () => {
    expect(USAGE).toContain(`default: ${DEFAULT_PORT}`);
    // 起動時に開く URL と PORT の既定値
    expect(README).toContain(`127.0.0.1:${DEFAULT_PORT}`);
    expect(README).toContain(`| \`PORT\` | \`${DEFAULT_PORT}\` |`);
    expect(SPEC).toContain(`127.0.0.1:${DEFAULT_PORT}`);
  });

  test("README に古い既定ポートが残っていない", () => {
    // 仕様書は「既定を 3000 系にしない理由」を書くため 3000 に言及してよいが、
    // README は利用者向けの手順のみなので古い既定値が残っていてはいけない
    expect(README).not.toContain("3000");
  });

  test("--help と README が同じ環境変数を挙げている", () => {
    expect(usageEnvNames(USAGE).sort()).toEqual(readmeEnvNames(README).sort());
  });

  test("環境変数名の抽出が機能している（テスト自体の空振り防止）", () => {
    // 抽出が壊れて両方 0 件になると、上の比較が常に通ってしまう
    expect(usageEnvNames(USAGE)).toContain("PORT");
    expect(readmeEnvNames(README)).toContain("PORT");
    expect(usageEnvNames(USAGE).length).toBeGreaterThan(1);
  });

  test("README と仕様書が CLI オプションに触れている", () => {
    for (const doc of [README, SPEC]) {
      expect(doc).toContain("--port");
    }
    expect(README).toContain("--help");
  });
});
