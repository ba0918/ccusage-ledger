# ccusage Ledger

`ccusage`（依存として固定した `ccusage@20.0.19`）が出力する JSON を元に、エージェント CLI (Claude Code / Codex / OpenCode 等) の使用量・トークン量・金額を可視化する個人用ダッシュボード。

## 技術スタック

- **サーバ**: Bun + TypeScript (`Bun.serve`)。外部フレームワークなし
- **データ取得**: dependencies で固定した `ccusage@20.0.19`（bun.lock で integrity 固定）を `bun run node_modules/ccusage/src/cli.js --json --sections daily,monthly --by-agent` で spawn して全履歴を取得
- **フロント**: 素の TypeScript + Chart.js (vendored)。`bun run build` でバンドル

## データフロー

1. サーバ起動時に依存の `ccusage@20.0.19` を直接実行し、そのマシンの全履歴を取得（子プロセスには許可リストの環境変数のみ渡す。API キー等の秘密は渡さない）
2. 結果を `~/.cache/ccusage-ledger/usage.json` に上書き保存（最新1ファイルキャッシュ方式。`XDG_CACHE_HOME` があればそれを基準）
3. サーバが JSON を配信し、フロントがクライアント側で集計して描画

## データ構造（ccusage JSON）

- トップレベルに `daily` / `weekly` / `monthly` などのセクション（`yearly` は無い）
- 各 period エントリ: `period`（日 or 月）、`totalCost`、`totalTokens`、`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheCreationTokens`、`modelsUsed[]`、`modelBreakdowns[]`、`metadata.agents[]`、`agents[]`（エージェント別内訳。`--by-agent` で取得）
- `modelBreakdowns[]`: モデル別の `modelName` / `cost` / 各トークン数
- yearly は monthly をクライアントで集計して生成
- スキーマには将来の複数デバイス対応のため `device` フィールドを最初から含める

## フィルタ

- 期間単位: daily / monthly / yearly
- 期間ナビ: 全期間表示 または ◀▶ で特定の月・年を選択（日次/月次=月、年次=年）
- モデル別 / エージェント別

## 起動・配布

- リポジトリ内でのサーバ起動: `bun run dev`（フロントのビルド後に起動。`bun run src/server.ts` のみの起動でも可）
- npm 配布版の起動: `bunx ccusage-ledger`（ローカル対話環境では起動時にブラウザを自動で開く）
- サーバはデフォルトで `127.0.0.1:3000` に bind する。`HOST` / `PORT` 環境変数で変更可（例: `HOST=0.0.0.0` で LAN 公開）
- 認証は意図的に実装しない。フロントが全データを受信して描画する設計のため、ダッシュボード画面が見える相手＝全データが見える相手であり、認証は対症療法になる。境界は「画面に届ける人」の制限で担保する
- ループバック TCP ポートは同一マシンの全ローカルユーザーから閲覧できる（共有マシンではリスク。単一ユーザー前提の設計）
- 非ループバック bind（例: `HOST=0.0.0.0`）はネットワーク上の誰でも画面と `/api/usage` を閲覧できる状態になる。起動時に警告を表示し、TTY では確認プロンプトを出す。`CCUSAGE_LEDGER_ALLOW_LAN=1` を設定すると確認なしで起動できる（警告のみ）
- LAN 上の別端末から見る場合は `ssh -L 3000:127.0.0.1:3000` による SSH トンネルを推奨する（トンネル自体がアクセス制限になる）
- HTML エクスポート: `bun run export` → 実行時カレントの `dist/ccusage-ledger.html` に単一 HTML を出力
- エクスポート HTML の CSP は `<meta>` タグで注入する。ブラウザは `<meta>` の `frame-ancestors` を無視するため、エクスポート HTML は iframe 埋め込み（クリックジャッキング）を防げない。外部配信する場合はサーバーのレスポンスヘッダで `X-Frame-Options: DENY` を付与すること
- 公開: `npm publish`（publish 直前に `bun run build` が実行される。データ・シークレットはパッケージに含まれない）

## 主要コマンド

- フロントビルド: `bun run build`
- テスト: `bun test`
- 型チェック: `bunx tsc --noEmit`
