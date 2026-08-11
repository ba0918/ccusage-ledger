import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchUsage } from "./fetch-usage";
import { PACKAGE_DIR } from "./paths";
import type { UsageData } from "./types";

export const CHART_TAG = '<script src="/public/vendor/chart.umd.min.js"></script>';
export const BUNDLE_TAG = '<script src="/dist/bundle.js"></script>';
export const EMBEDDED_TAG = '<script id="embedded-data"></script>';

export const EXPORT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

export function exportOutputPath(cwd: string): string {
  return join(cwd, "dist", "ccusage-ledger.html");
}

export function buildExportedHtml(html: string, chartJs: string, bundle: string, data: UsageData): string {
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`;
  return html
    .replace("</head>", `${cspMeta}</head>`)
    .replace(CHART_TAG, `<script>${chartJs}</script>`)
    .replace(BUNDLE_TAG, `<script>${bundle}</script>`)
    .replace(EMBEDDED_TAG, `<script id="embedded-data">window.CCUSAGE_DATA = ${dataJson};</script>`);
}

function main(): void {
  const rootDir = PACKAGE_DIR;
  const usage = fetchUsage();
  if (usage === null) {
    console.error("ERROR: ccusage データを取得できませんでした（キャッシュもありません）。");
    process.exit(1);
  }

  const html = readFileSync(join(rootDir, "index.html"), "utf-8");
  const chartJs = readFileSync(join(rootDir, "public", "vendor", "chart.umd.min.js"), "utf-8");
  const bundle = readFileSync(join(rootDir, "dist", "bundle.js"), "utf-8");

  const exported = buildExportedHtml(html, chartJs, bundle, usage.data);
  const outputPath = exportOutputPath(process.cwd());
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, exported);

  console.log(`exported: ${outputPath}`);
  console.warn("注意: この HTML には ccusage の使用量データが含まれます。共有相手に合わせて実行してください。");
}

if (import.meta.main) {
  main();
}
