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

  test("Trusted Publishing（OIDC）で公開し、長期トークンを持たない", () => {
    // registry-url を指定すると NODE_AUTH_TOKEN を参照する .npmrc が生成され、
    // 値が空のトークン認証として扱われて OIDC の経路に入らない
    expect(executableLines).not.toContain("registry-url:");
    expect(executableLines).not.toContain("NODE_AUTH_TOKEN");
    expect(executableLines).not.toContain("secrets.NPM_TOKEN");
  });

  test("Trusted Publishing に必要な npm CLI を publish より前に用意している", () => {
    // Trusted Publishing は npm 11.5.1 以上が必要だが、Node 22 の同梱は 10 系
    expect(executableLines).toContain("actions/setup-node@");
    const npmInstallIndex = executableLines.indexOf("npm install -g npm@");
    const publishIndex = executableLines.indexOf("npm publish");
    expect(npmInstallIndex).toBeGreaterThan(0);
    expect(npmInstallIndex).toBeLessThan(publishIndex);

    // 固定したバージョンが最低要件を満たすことを確認する（更新時の取り違え防止）
    const pinned = executableLines.match(/npm install -g npm@(\d+)\.(\d+)\.(\d+)/);
    expect(pinned).not.toBeNull();
    const [major, minor, patch] = [Number(pinned![1]), Number(pinned![2]), Number(pinned![3])];
    const meetsMinimum = major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
    expect(meetsMinimum, `npm@${major}.${minor}.${patch} は Trusted Publishing の最低要件 11.5.1 を満たさない`).toBe(true);
  });

  // job 単位の permissions は workflow 単位の指定を「置き換える」。したがって
  // workflow 全体を対象に toContain するだけでは、job 側の 1 行を消しても
  // workflow 側の同じ行に一致してテストが通ってしまう（実際には権限を失う）。
  // job の permissions ブロックだけを取り出して検証する
  function jobPermissions(yml: string): string[] {
    const lines = yml.split("\n");
    // workflow 単位は列 0、job 単位は job キー（2）配下の 4 スペース
    const start = lines.findIndex((line) => /^ {4}permissions:\s*$/.test(line));
    if (start === -1) { return []; }
    const baseIndent = lines[start]!.search(/\S/);
    const entries: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) { continue; }
      if (line.search(/\S/) <= baseIndent) { break; }
      entries.push(line.trim());
    }
    return entries;
  }

  test("publish job の permissions に OIDC 発行と Release 作成の権限がある", () => {
    // id-token: write が欠けると Trusted Publishing が OIDC トークンを受け取れず publish できない。
    // contents: write が欠けると publish 後の Release 作成に失敗する
    const permissions = jobPermissions(publishYml);
    expect(permissions.length, "publish job の permissions ブロックが見つからない").toBeGreaterThan(0);
    expect(permissions).toContain("id-token: write");
    expect(permissions).toContain("contents: write");
  });

  test("workflow 単位の permissions は contents: read に絞っている", () => {
    // 必要な job にだけ write を与え、既定は最小権限にする
    expect(publishYml).toMatch(/^permissions:\n {2}contents: read$/m);
  });
});
