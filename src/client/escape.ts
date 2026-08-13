// エスケープは 1 パスの replace で行う（5 連続 replace は文字列ごとに 5 回スキャンする）
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  // 型が壊れたデータ（period が数値など）でも String 化して描画を継続する。
  // 呼び出し側は escapeHtml の戻り値を HTML に埋め込むため、ここで文字列化する
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

// HTML のテキスト文脈へデータ由来の文字列を埋め込む唯一の入口。
// 新しいフィールドを描画する場合は必ずこの関数（または htmlAttr）を通す。
// データ由来の文字列を生のまま innerHTML に繋ぐと stored XSS になる（escapeHtml と同じ実体）。
// サーバー配信時の CSP は inline script を許可しないため、万一エスケープ漏れがあっても
// script 実行はブロックされる（defense-in-depth。エクスポート HTML は nonce ベース CSP のため、
// nonce を持たない注入タグはブロックされるが、このエスケープがデータ文脈の主防衛線になる）
export function htmlText(value: unknown): string {
  return escapeHtml(value);
}

// HTML の属性値（title="" など）へ埋め込むための入口。escapeHtml は " と ' もエスケープするため
// 属性文脈でも同じ実体を使える（on* 属性や javascript: を構築できない）
export function htmlAttr(value: unknown): string {
  return escapeHtml(value);
}

// URL 文脈（href / src / action 属性）へデータ由来の文字列を埋め込むための入口。
// 将来データ由来の URL を描画する場合は必ずこの関数を通す（htmlAttr は javascript: 等の
// スキームをエスケープせずに素通しするため、URL 属性では安全ではない。attack-review F10）。
// 許可するのは http / https / mailto と相対 URL のみ。制御文字やプロトコル相対 URL は
// レンダリング時にスキームが混入・解決されるため全体を拒否する
const ALLOWED_URL_SCHEMES = new Set(["http", "https", "mailto"]);
// 制御文字（タブ・LF 等）は HTML 属性の解析で無視され、スキーム混入に使えるため拒否する。
// biome の noControlCharactersInRegex を避けるため、リテラルにエスケープを含めず動的に構築する
const URL_CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);

export function safeUrl(value: unknown): string {
  // null / undefined は URL として無効なため空文字（escapeHtml と違い「null」という表示文字列
  // を URL 属性に埋め込まない。URL 文脈では空文字が安全な縮退）
  if (value === null || value === undefined) { return ""; }
  const raw = String(value);
  if (URL_CONTROL_CHARS.test(raw)) { return ""; }
  const trimmed = raw.trim();
  if (trimmed === "") { return ""; }
  // プロトコル相対 URL（//host/path）は相対 URL に見せかけたネットワークスキーム遷移のため拒否
  if (trimmed.startsWith("//")) { return ""; }
  const scheme = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme === null) { return trimmed; }
  return ALLOWED_URL_SCHEMES.has(scheme[1]!.toLowerCase()) ? trimmed : "";
}
