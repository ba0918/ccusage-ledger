import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// README は npmjs.com のパッケージページにそのまま表示されるが、相対パスの画像・リンクは
// npm 側のドメイン基準で解決されるため 404 になる（例: assets/image.png →
// https://www.npmjs.com/package/assets/image.png）。加えて assets/ は配布物の files に
// 含めていないため tarball にも入らない。README の参照は絶対 URL に統一する
const README = readFileSync(join(import.meta.dir, "..", "README.md"), "utf-8");

// Markdown のリンク・画像参照（[text](target) / ![alt](target)）から target を取り出す
function linkTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g)) {
    targets.push(match[1]!);
  }
  return targets;
}

describe("README の参照は npm ページでも解決できる", () => {
  test("リンク・画像の参照先が絶対 URL（またはページ内アンカー）である", () => {
    const relative = linkTargets(README).filter(
      (target) => !/^https?:\/\//.test(target) && !target.startsWith("#") && !target.startsWith("mailto:"),
    );
    expect(relative, `相対パスの参照は npm ページで 404 になる: ${relative.join(", ")}`).toEqual([]);
  });

  test("参照先の抽出が機能している（テスト自体の空振り防止）", () => {
    // 抽出ロジックが壊れて 0 件になると、上のテストが常に通ってしまう
    expect(linkTargets(README).length).toBeGreaterThan(0);
    expect(linkTargets("![a](x/y.png) と [b](https://example.com)")).toEqual(["x/y.png", "https://example.com"]);
  });
});
