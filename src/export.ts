import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchUsage } from "./fetch-usage";
import { PACKAGE_DIR } from "./paths";
import type { UsageData } from "./types";

export const CHART_TAG = '<script src="/public/vendor/chart.umd.min.js"></script>';
export const BUNDLE_TAG = '<script src="/dist/bundle.js"></script>';
export const EMBEDDED_TAG = '<script id="embedded-data"></script>';

export const EXPORT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const EXPORT_WARNING_BANNER =
  '<div style="position:sticky;top:0;z-index:30;background:#3a1d1d;color:#ffb4b4;padding:8px 16px;font-size:12px;text-align:center">このファイルには ccusage の使用量データが含まれます。共有・取り扱いに注意してください。</div>';

export function exportOutputPath(cwd: string): string {
  return join(cwd, "dist", "ccusage-ledger.html");
}

export function writeExportedHtml(outputPath: string, html: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  // 個人データ埋め込みファイルを他のローカルユーザーから読めないよう 0600 に制限する
  writeFileSync(outputPath, html, { mode: 0o600 });
}

export function buildExportedHtml(html: string, chartJs: string, bundle: string, data: UsageData): string {
  // CSP・警告バナーの注入が無効な HTML で静かに失われないよう、挿入ポイントの存在を検証する
  if (!html.includes("</head>")) throw new Error("index.html に </head> がありません");
  if (!html.includes("<body>")) throw new Error("index.html に <body> がありません");

  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`;
  return html
    .replace("</head>", `${cspMeta}</head>`)
    .replace("<body>", `<body>${EXPORT_WARNING_BANNER}`)
    .replace(CHART_TAG, `<script>${chartJs}</script>`)
    .replace(BUNDLE_TAG, `<script>${bundle}</script>`)
    .replace(EMBEDDED_TAG, `<script id="embedded-data">window.CCUSAGE_DATA = ${dataJson};</script>`);
}

async function main(): Promise<void> {
  const rootDir = PACKAGE_DIR;
  const usage = await fetchUsage();
  if (usage === null) {
    console.error("ERROR: failed to fetch ccusage data (and no cache exists).");
    process.exit(1);
  }

  const html = readFileSync(join(rootDir, "index.html"), "utf-8");
  const chartJs = readFileSync(join(rootDir, "public", "vendor", "chart.umd.min.js"), "utf-8");
  const bundle = readFileSync(join(rootDir, "dist", "bundle.js"), "utf-8");

  const exported = buildExportedHtml(html, chartJs, bundle, usage.data);
  const outputPath = exportOutputPath(process.cwd());
  writeExportedHtml(outputPath, exported);

  console.log(`exported: ${outputPath}`);
  console.warn("Note: this HTML contains your ccusage usage data. Only export it when sharing with someone you trust.");
}

if (import.meta.main) {
  main();
}
