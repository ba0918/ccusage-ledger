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
// script 実行はブロックされる（defense-in-depth。エクスポート HTML は unsafe-inline のため
// このエスケープが唯一の防衛線になる）
export function htmlText(value: unknown): string {
  return escapeHtml(value);
}

// HTML の属性値（title="" など）へ埋め込むための入口。escapeHtml は " と ' もエスケープするため
// 属性文脈でも同じ実体を使える（on* 属性や javascript: を構築できない）
export function htmlAttr(value: unknown): string {
  return escapeHtml(value);
}
