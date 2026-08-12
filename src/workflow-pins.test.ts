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
