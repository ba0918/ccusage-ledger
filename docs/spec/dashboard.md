# ccusage Dashboard

## 概要

エージェント CLI（Claude Code、Codex、OpenCode などのコーディングエージェント）の使用量・トークン量・コストを可視化する個人用 Web ダッシュボード。データは `ccusage` コマンドが出力する JSON を使用する。

## ゴールと非ゴール

### ゴール
- 使用量（トークン）、コスト（金額）、モデル構成をグラフィカルに確認できる
- daily / monthly / yearly の期間単位で集計を切り替えられる
- モデル別・エージェント別にフィルタリングできる

### 非ゴール
- 複数デバイスのデータ統合（将来対応。`device` フィールドのみ先に確保）
- リアルタイム更新（起動時キャッシュで十分）
- 履歴スナップショットの蓄積（まずは最新データの可視化を優先）

## アーキテクチャ

```
bunx ccusage --json  （サーバ起動時に1回実行）
        │
        ▼
data/usage.json      （最新1ファイルキャッシュ）
        │
        ▼
Bun.serve            （ローカルサーバ）
        │
        ▼
ブラウザ             （素の TypeScript + Chart.js）
```

- サーバ: Bun + TypeScript。`Bun.serve` で静的ファイルと JSON を配信
- フロント: 素の TypeScript + Chart.js（vendored）。`bun build` でバンドル
- 外部 UI フレームワークは使わない（状態がフィルタと期間切替のみのため）

## データ取得

1. サーバ起動時に `bunx ccusage --json` を子プロセスとして実行
2. 標準出力の JSON を `data/usage.json` に上書き保存
3. サーバはこのキャッシュファイルを API 経由で配信

## データ構造（ccusage JSON）

ccusage の JSON はトップレベルに `daily` / `weekly` / `monthly` のセクションを持つ。`yearly` は無いため、monthly をクライアントで集計して生成する。

各 period エントリ:

- `period`: 期間（日: `YYYY-MM-DD`、月: `YYYY-MM`）
- `totalCost`: 期間の合計コスト
- `totalTokens`: 期間の合計トークン数
- `inputTokens` / `outputTokens`: 入力・出力トークン
- `cacheReadTokens` / `cacheCreationTokens`: キャッシュ読み取り・作成トークン
- `modelsUsed[]`: 使用モデル名のリスト
- `modelBreakdowns[]`: モデル別の `modelName` / `cost` / 各トークン数
- `metadata.agents[]`: エージェント名のリスト（claude, codex, opencode など）

スキーマには将来の複数デバイス対応のため `device` フィールドを最初から含める。

## ビュー（グラフ）

1 画面に複数のグラフを並べる:

- **日別コスト積み上げ（モデル別）**: daily をモデル別に積み上げた棒グラフ
- **月別コスト**: monthly のコスト棒グラフ
- **モデル構成（model-mix）比率トレンド**: 期間ごとのモデル別コスト比率。コスト増が単価上昇なのかモデル構成の変化なのかを判別できる
- **単価（$/MTok）推移**: モデル別の 1M トークンあたりコスト
- **キャッシュヒット率推移**: キャッシュ読み取りの割合（定義は実装時に確定）

## フィルタ

- 期間単位: daily / monthly / yearly
- 表示範囲: 全期間 / 直近90日 / 直近30日 / 直近7日（すべてのグラフに適用。daily は日付、monthly は月、yearly は年単位で絞る）
- モデル別: 使用モデルで絞り込み
- エージェント別: エージェントで絞り込み（データ出所は実装時に確定）

## 将来拡張

- 複数デバイス対応: `device` フィールドを使ったマージ
- 日次スナップショットの蓄積（ログ消滅への耐性）
- フィルタ状態の URL 保存
