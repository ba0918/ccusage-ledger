import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { UsageData } from "./types";
import { buildExportedHtml, exportOutputPath } from "./export";

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
  });
});
