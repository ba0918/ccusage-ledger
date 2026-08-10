# ccusage Dashboard

`bunx ccusage` が出力する JSON を元に、エージェント CLI (Claude Code / Codex / OpenCode 等) の使用量・トークン量・金額を可視化する個人用ダッシュボード。

## 技術スタック

- **サーバ**: Bun + TypeScript (`Bun.serve`)。外部フレームワークなし
- **データ取得**: `bunx ccusage --json` を spawn して全履歴を取得
- **フロント**: 素の TypeScript + Chart.js (vendored)。`bun build` でバンドル

## データフロー

1. サーバ起動時に `bunx ccusage --json` を実行し、そのマシンの全履歴を取得
2. 結果を `data/usage.json` に上書き保存（最新1ファイルキャッシュ方式）
3. サーバが JSON を配信し、フロントがクライアント側で集計して描画

## データ構造（ccusage JSON）

- トップレベルに `daily` / `weekly` / `monthly` などのセクション（`yearly` は無い）
- 各 period エントリ: `period`（日 or 月）、`totalCost`、`totalTokens`、`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheCreationTokens`、`modelsUsed[]`、`modelBreakdowns[]`、`metadata.agents[]`
- `modelBreakdowns[]`: モデル別の `modelName` / `cost` / 各トークン数
- yearly は monthly をクライアントで集計して生成
- スキーマには将来の複数デバイス対応のため `device` フィールドを最初から含める

## 主要コマンド（実装時に確定）

- サーバ起動: `bun run src/server.ts`
- フロントビルド: `bun build`
