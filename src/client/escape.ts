export function escapeHtml(value: unknown): string {
  // 型が壊れたデータ（period が数値など）でも String 化して描画を継続する。
  // 呼び出し側は escapeHtml の戻り値を HTML に埋め込むため、ここで文字列化する
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
