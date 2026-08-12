import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchUsage } from "./fetch-usage";
import { PACKAGE_DIR } from "./paths";
import type { UsageData } from "./types";
import { projectUsageData } from "./usage-data";

export const CHART_TAG = '<script src="/public/vendor/chart.umd.min.js"></script>';
export const BUNDLE_TAG = '<script src="/dist/bundle.js"></script>';
export const EMBEDDED_TAG = '<script id="embedded-data"></script>';
export const APP_CSS_TAG = '<link rel="stylesheet" href="/public/app.css" />';

export const EXPORT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const EXPORT_WARNING_BANNER =
  '<div style="position:sticky;top:0;z-index:30;background:#3a1d1d;color:#ffb4b4;padding:8px 16px;font-size:12px;text-align:center" data-i18n="exportWarning">This file contains your ccusage usage data. Be careful when sharing or handling it.</div>';

// ブラウザは <meta> CSP の frame-ancestors を無視するため、フレーム内での表示を JS で防ぐ
// （サーバー配信時は X-Frame-Options: DENY を別途付与すること。AGENTS.md 参照）
export const EXPORT_FRAME_BUSTER =
  '<script>if (window.top !== window.self) { window.top.location = window.location; }</script>';

export function exportOutputPath(cwd: string): string {
  return join(cwd, "dist", "ccusage-ledger.html");
}

export function writeExportedHtml(outputPath: string, html: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  // 個人データ埋め込みファイルを他のローカルユーザーから読めないよう 0600 に制限する。
  // writeFileSync の mode は既存ファイルには適用されないため、書き込み後に chmod で
  // 明示的に 0600 を再適用する（既存ファイルのモードが緩んでいても毎回 0600 に戻す）
  writeFileSync(outputPath, html, { mode: 0o600 });
  chmodSync(outputPath, 0o600);
}

export function buildExportedHtml(html: string, chartJs: string, bundle: string, css: string, data: UsageData): string {
  // CSP・警告バナーの注入が無効な HTML で静かに失われないよう、挿入ポイントの存在を検証する
  if (!html.includes("</head>")) { throw new Error("index.html is missing </head>"); }
  if (!html.includes("<body>")) { throw new Error("index.html is missing <body>"); }
  if (!html.includes(CHART_TAG)) { throw new Error("index.html is missing the Chart.js script tag"); }
  if (!html.includes(BUNDLE_TAG)) { throw new Error("index.html is missing the bundle script tag"); }
  if (!html.includes(EMBEDDED_TAG)) { throw new Error("index.html is missing the embedded data script tag"); }
  if (!html.includes(APP_CSS_TAG)) { throw new Error("index.html is missing the app.css link tag"); }

  // < を \u003c に置換して </script> / <!-- の script 終了を防ぐ。加えて U+2028 / U+2029
  // （ES2019 より前の JS エンジンで文字列リテラルを終端する）をエスケープする
  const dataJson = JSON.stringify(projectUsageData(data))
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16)}`);
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`;
  const out = html
    .replace("</head>", `${cspMeta}${EXPORT_FRAME_BUSTER}</head>`)
    .replace("<body>", `<body>${EXPORT_WARNING_BANNER}`)
    .replace(CHART_TAG, `<script>${chartJs}</script>`)
    .replace(BUNDLE_TAG, `<script>${bundle}</script>`)
    .replace(EMBEDDED_TAG, `<script id="embedded-data">window.CCUSAGE_DATA = ${dataJson};</script>`)
    .replace(APP_CSS_TAG, `<style>${css}</style>`);

  // タグ表記が index.html とずれた場合、replace が効かず壊れた HTML が静かに出力されるのを防ぐ
  for (const tag of [CHART_TAG, BUNDLE_TAG, EMBEDDED_TAG, APP_CSS_TAG]) {
    if (out.includes(tag)) { throw new Error(`failed to replace ${tag} in index.html`); }
  }
  return out;
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
  const css = readFileSync(join(rootDir, "public", "app.css"), "utf-8");

  const exported = buildExportedHtml(html, chartJs, bundle, css, usage.data);
  const outputPath = exportOutputPath(process.cwd());
  writeExportedHtml(outputPath, exported);

  console.log(`exported: ${outputPath}`);
  console.warn("Note: this HTML contains your ccusage usage data. Only export it when sharing with someone you trust.");
}

if (import.meta.main) {
  main().catch((error) => {
    // dist/bundle.js や vendored Chart.js が無い場合はそのまま build を促す
    console.error(`ERROR: export failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Hint: run `bun run build` first to generate dist/bundle.js.");
    process.exit(1);
  });
}
