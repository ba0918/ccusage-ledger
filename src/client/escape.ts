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
