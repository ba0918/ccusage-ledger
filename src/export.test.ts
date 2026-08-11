import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageData } from "./types";
import { buildExportedHtml, exportOutputPath, writeExportedHtml } from "./export";

const HTML = [
  "<!doctype html><html><head><title>ccusage</title></head><body>",
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
});

describe("buildExportedHtml", () => {
  test("Chart.js の script タグをインライン内容に置換する", () => {
    const out = buildExportedHtml(HTML, "var CHART = 1;", "bundle", DATA);
    expect(out).toContain("<script>var CHART = 1;</script>");
    expect(out).not.toContain('<script src="/public/vendor/chart.umd.min.js"></script>');
  });

  test("bundle の script タグをインライン内容に置換する", () => {
    const out = buildExportedHtml(HTML, "chart", "var BUNDLE = 2;", DATA);
    expect(out).toContain("<script>var BUNDLE = 2;</script>");
    expect(out).not.toContain('<script src="/dist/bundle.js"></script>');
  });

  test("データを window.CCUSAGE_DATA に JSON として埋め込む", () => {
    const out = buildExportedHtml(HTML, "chart", "bundle", DATA);
    const json = extractEmbeddedJson(out);
    expect(JSON.parse(json)).toEqual(DATA);
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
    const out = buildExportedHtml(HTML, "chart", "bundle", data);
    expect(embeddedScriptContent(out)).not.toContain("</script>");
    expect(JSON.parse(extractEmbeddedJson(out))).toEqual(data);
  });

  test("エクスポート HTML に CSP を注入する（ネットワーク送信を遮断）", () => {
    const out = buildExportedHtml(HTML, "chart", "bundle", DATA);
    expect(out).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain("script-src 'unsafe-inline'");
    expect(out).toContain("frame-ancestors 'none'");
  });

  test("エクスポート HTML にデータ取り扱いの警告バナーを注入する", () => {
    const out = buildExportedHtml(HTML, "chart", "bundle", DATA);
    expect(out).toContain("このファイルには ccusage の使用量データが含まれます");
  });

  test("</head> が無い HTML では例外を投げる（CSP 注入が静かに失われない）", () => {
    expect(() => buildExportedHtml("<html><body></body></html>", "chart", "bundle", DATA)).toThrow();
  });

  test("<body> が無い HTML では例外を投げる（バナー注入が静かに失われない）", () => {
    expect(() => buildExportedHtml("<html><head></head></html>", "chart", "bundle", DATA)).toThrow();
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
    const out = buildExportedHtml(HTML, "chart", "bundle", data);
    expect(embeddedScriptContent(out)).not.toContain("<");
    expect(JSON.parse(extractEmbeddedJson(out))).toEqual(data);
  });
});
