import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchUsage } from "./fetch-usage";
import type { UsageData } from "./types";

export const CHART_TAG = '<script src="/public/vendor/chart.umd.min.js"></script>';
export const BUNDLE_TAG = '<script src="/dist/bundle.js"></script>';
export const EMBEDDED_TAG = '<script id="embedded-data"></script>';

export function buildExportedHtml(html: string, chartJs: string, bundle: string, data: UsageData): string {
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  return html
    .replace(CHART_TAG, `<script>${chartJs}</script>`)
    .replace(BUNDLE_TAG, `<script>${bundle}</script>`)
    .replace(EMBEDDED_TAG, `<script id="embedded-data">window.CCUSAGE_DATA = ${dataJson};</script>`);
}

function main(): void {
  const rootDir = process.cwd();
  const usage = fetchUsage();
  if (usage === null) {
    console.error("ERROR: ccusage データを取得できませんでした（キャッシュもありません）。");
    process.exit(1);
  }

  const html = readFileSync(join(rootDir, "index.html"), "utf-8");
  const chartJs = readFileSync(join(rootDir, "public", "vendor", "chart.umd.min.js"), "utf-8");
  const bundle = readFileSync(join(rootDir, "dist", "bundle.js"), "utf-8");

  const exported = buildExportedHtml(html, chartJs, bundle, usage.data);
  mkdirSync(join(rootDir, "dist"), { recursive: true });
  writeFileSync(join(rootDir, "dist", "ccusage-ledger.html"), exported);

  console.log("exported: dist/ccusage-ledger.html");
  console.warn("注意: この HTML には ccusage の使用量データが含まれます。共有相手に合わせて実行してください。");
}

if (import.meta.main) {
  main();
}
