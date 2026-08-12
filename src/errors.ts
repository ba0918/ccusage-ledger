// エラーオブジェクトからユーザー向けメッセージを取り出す共通ヘルパー。
// `error instanceof Error ? error.message : String(error)` の三項を 4 ファイルに
// 重複させず、ログ・ステータス表示の文言組み立てを 1 箇所に集約する
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
