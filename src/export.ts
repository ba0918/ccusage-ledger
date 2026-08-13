import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { messageOf } from "./errors";
import { fetchUsage } from "./fetch-usage";
import { PACKAGE_DIR } from "./paths";
import type { UsageData } from "./types";
import { projectUsageData } from "./usage-data";

export const CHART_TAG = '<script src="/public/vendor/chart.umd.min.js"></script>';
export const BUNDLE_TAG = '<script src="/dist/bundle.js"></script>';
export const EMBEDDED_TAG = '<script id="embedded-data"></script>';
export const APP_CSS_TAG = '<link rel="stylesheet" href="/public/app.css" />';

// エクスポート HTML の CSP は nonce ベースにする（F3）。単一ファイル HTML はインライン script を
// 避けられないが、script-src に 'unsafe-inline' を使うと、エスケープ回帰で注入された <script> や
// インラインイベントハンドラ（onerror 等）が実行されてしまう。生成したランダム nonce を
// script-src と全インライン script/style タグに付与し、'unsafe-inline' を除去することで、
// nonce を持たない注入タグは CSP でブロックされる（エスケープが唯一の防衛線にならない）
export function exportCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

export function generateNonce(): string {
  return randomBytes(16).toString("base64");
}

export const EXPORT_WARNING_BANNER =
  '<div style="position:sticky;top:0;z-index:30;background:#3a1d1d;color:#ffb4b4;padding:8px 16px;font-size:12px;text-align:center" data-i18n="exportWarning">This file contains your ccusage usage data. Be careful when sharing or handling it.</div>';

// ブラウザは <meta> CSP の frame-ancestors を無視するため、フレーム内での表示を JS で防ぐ
// （サーバー配信時は X-Frame-Options: DENY を別途付与すること。AGENTS.md 参照）。
// nonce ベース CSP 下で実行させるため、nonce 属性を付与する。
//
// fail-closed にするため「既定で非表示 → トップレベルだと確認できたときだけ表示」にする。
// sandbox 付き iframe やクロスオリジンのトップナビゲーション制限下では
// window.top.location への代入が例外になる / 黙って無視されるため、
// 脱出に頼るだけだとフレーム内に個人データが表示されたままになる。
// JS 無効時は script が動かず何も表示されなくなるため、<noscript> で表示に戻す
// （この場合フレーム保護は効かないが、その旨は EXPORT_NOSCRIPT_FRAME_WARNING で警告する）
export function exportFrameBuster(nonce: string): string {
  return (
    `<style nonce="${nonce}">html{display:none}</style>` +
    `<script nonce="${nonce}">` +
    "if (window.top === window.self) { document.documentElement.style.display = \"block\"; }" +
    " else { try { window.top.location = window.location; } catch (e) { /* 脱出できない場合は非表示のまま維持する */ } }" +
    "</script>" +
    `<noscript><style nonce="${nonce}">html{display:block}</style></noscript>`
  );
}

// JS を無効化した環境では frame buster が動かない（<meta> CSP の frame-ancestors も無視される）ため、
// フレーム保護が無効になることをユーザーに明示する noscript 警告を注入する（F14）
export const EXPORT_NOSCRIPT_FRAME_WARNING =
  '<noscript><div style="background:#3a1d1d;color:#ffb4b4;padding:8px 16px;font-size:12px;text-align:center">Warning: JavaScript is disabled, so iframe embedding protection is inactive. Do not load this file inside a frame.</div></noscript>';

export function exportOutputPath(cwd: string): string {
  return join(cwd, "dist", "ccusage-ledger.html");
}

// 起点から親へ遡って .git（ディレクトリ or worktree 用ファイル）を見つけ、git リポジトリの
// ルートを返す。見つからなければ null。worktree / submodule は .git がファイルになるため
// existsSync でディレクトリ・ファイルの両方を拾う
export function findGitRoot(startDir: string): string | null {
  let current = startDir;
  for (;;) {
    if (existsSync(join(current, ".git"))) { return current; }
    const parent = dirname(current);
    if (parent === current) { return null; }
    current = parent;
  }
}

// エクスポート出力先が「ccusage-ledger 自身の git リポジトリとは異なる git リポジトリ内」かどうか。
// export は実行時カレントに dist/ccusage-ledger.html を書くため、他プロジェクトの checkout 内で
// 実行すると個人データ埋め込み HTML が誤ってコミット・共有される（F8）。ただし
// パッケージ自身が git 管理下にない場合（npm インストール先）は比較できないため false を返す
export function isForeignGitWorktree(outputDir: string, packageDir: string): boolean {
  const outputRoot = findGitRoot(outputDir);
  const packageRoot = findGitRoot(packageDir);
  if (outputRoot === null || packageRoot === null) { return false; }
  return outputRoot !== packageRoot;
}

// 外部の git リポジトリ内への書き込み方針。警告だけで続行すると誤コミットが起き得るため、
// デフォルトでは書き込みを拒否し、CCUSAGE_LEDGER_EXPORT_ALLOW_FOREIGN=1（または true）でのみ
// 明示オプトインする（attack-review F12）
export function exportForeignWorktreePolicy(
  env: Record<string, string | undefined>,
  outputDir: string,
  packageDir: string,
): "ok" | "refuse" {
  if (!isForeignGitWorktree(outputDir, packageDir)) { return "ok"; }
  const allow = env.CCUSAGE_LEDGER_EXPORT_ALLOW_FOREIGN;
  if (allow === "1" || allow === "true") { return "ok"; }
  return "refuse";
}

export interface ExportFileOperations {
  rename?: (oldPath: string, newPath: string) => void;
  write?: (fd: number, data: Uint8Array, offset: number, length: number) => number;
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { return false; }
    throw error;
  }
}

export function writeExportedHtml(outputPath: string, html: string, operations: ExportFileOperations = {}): void {
  const outputDir = dirname(outputPath);
  mkdirSync(outputDir, { recursive: true });
  if (isSymbolicLink(outputPath)) {
    throw new Error(`refusing to replace symbolic link: ${outputPath}`);
  }

  const temporaryPath = `${outputPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  let fd: number | null = null;
  try {
    fd = openSync(temporaryPath, "wx", 0o600);
    const data = Buffer.from(html);
    const write = operations.write ?? ((targetFd, bytes, offset, length) => writeSync(targetFd, bytes, offset, length));
    let offset = 0;
    while (offset < data.byteLength) {
      const written = write(fd, data, offset, data.byteLength - offset);
      if (written <= 0) { throw new Error("failed to write exported HTML"); }
      offset += written;
    }
    closeSync(fd);
    fd = null;

    // 既存ファイルを先に削除しない。rename に失敗しても以前の export を保持するため。
    // 再検証により、最初の確認後に置かれた symlink もリンク先ごと上書きしない。
    if (isSymbolicLink(outputPath)) {
      throw new Error(`refusing to replace symbolic link: ${outputPath}`);
    }
    (operations.rename ?? renameSync)(temporaryPath, outputPath);
  } finally {
    if (fd !== null) { closeSync(fd); }
    rmSync(temporaryPath, { force: true });
  }
}

export function buildExportedHtml(html: string, chartJs: string, bundle: string, css: string, data: UsageData, nonce: string = generateNonce()): string {
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
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${exportCsp(nonce)}">`;
  // 置換値は必ず関数形式で渡す。文字列で渡すと $$ / $& / $` / $' / $1 が特殊置換パターンとして
  // 解釈され、埋め込む JS・CSS・データが黙って書き換わる（実際に bundle の `$${cost.toFixed(2)}` が
  // `${cost.toFixed(2)}` になり、エクスポート HTML の金額から通貨記号が消えていた）。
  // 関数形式なら戻り値がそのまま挿入され、特殊パターンは解釈されない
  const out = html
    .replace("</head>", () => `${cspMeta}${exportFrameBuster(nonce)}${EXPORT_NOSCRIPT_FRAME_WARNING}</head>`)
    .replace("<body>", () => `<body>${EXPORT_WARNING_BANNER}`)
    .replace(CHART_TAG, () => `<script nonce="${nonce}">${chartJs}</script>`)
    .replace(BUNDLE_TAG, () => `<script nonce="${nonce}">${bundle}</script>`)
    .replace(EMBEDDED_TAG, () => `<script id="embedded-data" nonce="${nonce}">window.CCUSAGE_DATA = ${dataJson};</script>`)
    .replace(APP_CSS_TAG, () => `<style nonce="${nonce}">${css}</style>`);

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

  // 他プロジェクトの git リポジトリ内への書き込みは、個人データ入り HTML の誤コミットを防ぐため
  // デフォルトで拒否する（CCUSAGE_LEDGER_EXPORT_ALLOW_FOREIGN=1 で明示オプトイン。attack-review F12）
  if (exportForeignWorktreePolicy(process.env, dirname(outputPath), PACKAGE_DIR) === "refuse") {
    console.error(
      `ERROR: refusing to export into a git repository that is not ccusage-ledger (${findGitRoot(dirname(outputPath))}). ` +
        "This file contains your ccusage usage data. Set CCUSAGE_LEDGER_EXPORT_ALLOW_FOREIGN=1 to export anyway.",
    );
    process.exit(1);
  }

  writeExportedHtml(outputPath, exported);

  console.log(`exported: ${outputPath}`);
  console.warn("Note: this HTML contains your ccusage usage data. Only export it when sharing with someone you trust.");
}

if (import.meta.main) {
  main().catch((error) => {
    // dist/bundle.js や vendored Chart.js が無い場合はそのまま build を促す
    console.error(`ERROR: export failed: ${messageOf(error)}`);
    console.error("Hint: run `bun run build` first to generate dist/bundle.js.");
    process.exit(1);
  });
}
