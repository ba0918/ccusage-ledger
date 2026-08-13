import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// GitHub Actions の workflow ファイル一覧。SHA ピンが維持されていることを機械的に検証する
// （F12: Dependabot がタグ参照（actions/checkout@v7 等）の更新 PR を提案するため、
// 再ピン忘れで mutable tag に後退すると CI / npm publish が任意コード実行の受け口になる）
const WORKFLOW_DIR = join(import.meta.dir, "..", ".github", "workflows");
const workflows = readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

// 40 桁の完全 SHA（GitHub が要求する形式。短縮 SHA やタグは mutable のため拒否）
const SHA_REF = /^[0-9a-f]{40}$/;

function usesLines(content: string): { line: number; ref: string; comment: string }[] {
  const lines = content.split("\n");
  const result: { line: number; ref: string; comment: string }[] = [];
  for (const [i, line] of lines.entries()) {
    const match = line.match(/^\s*-\s+uses:\s+([^\s@]+)@([^\s#]+)\s*(#\s*(.*))?$/);
    if (match) {
      result.push({ line: i + 1, ref: match[2]!, comment: match[4] ?? "" });
    }
  }
  return result;
}

describe("GitHub Actions SHA ピン", () => {
  test("workflow ファイルが検出される", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  test("すべての uses: 参照が完全 SHA でピン固定されている（mutable tag の禁止）", () => {
    for (const file of workflows) {
      const content = readFileSync(join(WORKFLOW_DIR, file), "utf-8");
      const uses = usesLines(content);
      expect(uses.length, `${file}: uses: 参照が存在する`).toBeGreaterThan(0);
      for (const u of uses) {
        expect(SHA_REF.test(u.ref), `${file}:${u.line} uses: ${u.ref} は完全 SHA で固定すべき（タグ/短縮 SHA は mutable）`).toBe(true);
      }
    }
  });

  test("SHA ピン参照にバージョンコメントが付いている（更新追跡を可能にする）", () => {
    for (const file of workflows) {
      const content = readFileSync(join(WORKFLOW_DIR, file), "utf-8");
      for (const u of usesLines(content)) {
        expect(u.comment.length, `${file}:${u.line} は # vX 形式のコメント付きであるべき`).toBeGreaterThan(0);
      }
    }
  });

  test("Dependabot 設定が存在し、Actions 更新の自動マージを有効にしていない", () => {
    const dependabotPath = join(import.meta.dir, "..", ".github", "dependabot.yml");
    const content = readFileSync(dependabotPath, "utf-8");
    expect(content).toContain("github-actions");
    // 自動マージ設定（auto-merge 等）は Actions の再ピン確認を飛ばすため禁止
    expect(content.toLowerCase()).not.toContain("auto-merge");
  });
});

// リリースの取り返しがつかない事故（誤ったバージョンの公開・main 外からの公開）を
// 構造的に防ぐガードが publish.yml から失われていないことを固定する
describe("publish ワークフローのリリースガード", () => {
  const publishYml = readFileSync(join(WORKFLOW_DIR, "publish.yml"), "utf-8");

  // 実行順の検証はコメント行を除いた本文で行う。コメントには説明として同じコマンド名が
  // 登場する（例: 9 行目の "npm publish --provenance 用: ..."）ため、生の本文で
  // indexOf すると「コメントの位置」を比較してしまい、ステップを入れ替えても検知できない
  const executableLines = publishYml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  test("タグと package.json の version 一致を検証している", () => {
    // npm は同一バージョンの再公開を拒否するため、不一致のまま publish すると
    // そのバージョン番号を消費して取り返しがつかない
    expect(publishYml).toContain("require('./package.json').version");
    expect(publishYml).toContain("GITHUB_REF_NAME");
  });

  test("タグが main の履歴上にあることを検証している", () => {
    // 作業ブランチのコミットに誤ってタグを打っても公開されないようにする
    expect(publishYml).toContain("merge-base --is-ancestor");
    // 祖先判定には全履歴が必要
    expect(publishYml).toContain("fetch-depth: 0");
  });

  test("GitHub Release の作成は npm publish より後に置く", () => {
    // publish 失敗時に Release だけが残ると、公開済みに見えて実体が無い状態になる
    const publishIndex = executableLines.indexOf("npm publish");
    const releaseIndex = executableLines.indexOf("gh release create");
    expect(publishIndex, "npm publish の実行行が見つからない").toBeGreaterThan(0);
    expect(releaseIndex, "gh release create の実行行が見つからない").toBeGreaterThan(0);
    expect(releaseIndex).toBeGreaterThan(publishIndex);
  });

  test("順序検証はコメントではなく実行行を見ている（テスト自体の回帰防止）", () => {
    // コメント行を残したままステップだけ入れ替えても検知できることを、
    // 実行行だけを対象にしていることの確認として固定する
    const commentOnly = publishYml
      .split("\n")
      .filter((line) => /^\s*#/.test(line))
      .join("\n");
    expect(commentOnly).toContain("npm publish");
    expect(executableLines).not.toContain("# npm publish");
  });

  test("npm レジストリの認証が配線されている", () => {
    // NODE_AUTH_TOKEN は、それを参照する .npmrc が無いと使われない（npm は ENEEDAUTH で落ちる）。
    // .npmrc を生成するのは setup-node の registry-url 指定であり、setup-bun では代替できない
    expect(executableLines).toContain("actions/setup-node@");
    expect(executableLines).toContain("registry-url:");
    const registryIndex = executableLines.indexOf("registry-url:");
    const publishIndex = executableLines.indexOf("npm publish");
    expect(registryIndex).toBeGreaterThan(0);
    expect(registryIndex).toBeLessThan(publishIndex);
  });

  test("Release 作成のために contents: write を job 単位で付与している", () => {
    // workflow 単位は contents: read のまま、必要な job にだけ write を与える
    expect(publishYml).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(publishYml).toContain("contents: write");
  });
});
