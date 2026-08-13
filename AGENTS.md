# ccusage Ledger

`ccusage`（依存として固定した `ccusage@20.0.19`）が出力する JSON を元に、エージェント CLI (Claude Code / Codex / OpenCode 等) の使用量・トークン量・金額を可視化する個人用ダッシュボード。

## 技術スタック

- **サーバ**: Bun + TypeScript。HTTP レイヤーは Hono（`hono`）を使用し、Bun 実行時は `Bun.serve`、Node 実行時は `@hono/node-server` で起動する
- **データ取得**: dependencies で固定した `ccusage@20.0.19`（bun.lock で integrity 固定）の `node_modules/ccusage/src/cli.js` を、実行中ランタイムの `process.execPath`（Bun / Node）で直接 spawn して `--json --sections daily,monthly --by-agent` で全履歴を取得（`bunx` や `bun run` は使わない。PATH ハイジャック対策としてランタイムを直接指定する）
- **フロント**: 素の TypeScript + Chart.js (vendored)。`bun run build` でバンドル

## データフロー

1. サーバ起動時に依存の `ccusage@20.0.19` を直接実行し、そのマシンの全履歴を取得（子プロセスには許可リストの環境変数のみ渡す。API キー等の秘密は渡さない。HOME は渡さず空の一時ディレクトリを設定し、データソースは各エージェントのデータディレクトリ env（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_DATA_DIR` / `OPENCODE_DATA_DIR`）だけを渡す。ccusage がデフォルト探索で `~/.ssh` 等のエージェント以外の秘密に触れるのを防ぐ。ただし実行ユーザーが同じであるため、改ざんされたバイナリがファイルシステムを直接探索することは防げない。post-install の改ざん検出として、起動ごとに `node_modules/ccusage` ラッパーの sha256 を固定値（`CCUSAGE_WRAPPER_SHA256`）と照合する。ラッパーはプラットフォーム非依存のため全プラットフォームで検証される。実行プラットフォームの native バイナリ（`@ccusage/ccusage-<platform>-<arch>`）はプラットフォーム別テーブル（`CCUSAGE_NATIVE_SHA256_BY_PLATFORM`）と照合し、未登録プラットフォームでは検証不可として WARN を出す（単一固定値では他プラットフォームが常に不一致になりダッシュボードが空になるため。登録は各プラットフォームで再計算する）。照合ハッシュは同一成果物内に同梱されるため、固定版そのものの悪意ある publish や同一ユーザーの改ざんは検知できない（自己参照の限界。検知対象はローカル/レジストリ上の post-install 改ざん））
2. 結果を `~/.cache/ccusage-ledger/usage.json` に上書き保存（最新1ファイルキャッシュ方式。`XDG_CACHE_HOME` があればそれを基準。キャッシュディレクトリが自分所有かつ 0700 であることを確認できない場合は読み書きとも行わない（fail-closed。書込みは 0700 へ修復を試み、読込みはキャッシュなし扱いになる））
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

## 積み上げグラフ

- モデル別の積み上げ棒グラフは Cost / Tokens トグルで費用とトークン使用量を切り替えられる（初期は Cost。選択はフィルタ変更後も維持、再読み込みで Cost に戻る）
- 棒（日・月・年）をクリックすると、その期間に利用実績のある全モデルを実効単価（$/MTok）の高い順で右側パネルに表示し、任意の 2 モデルをカード型で比較できる（詳細仕様は `docs/spec/dashboard.md`「期間クリックによるモデル実効単価比較」節）

## 多言語対応

- 言語切替: ヘッダー右上の ja / en トグル（表示層のみ。初期言語は英語、選択は localStorage キー `ccusage-ledger:lang` に永続化）
- 切替はリロードなしで即時反映され、`<html lang>` も同期する。ちらつきを防ぐため、バンドル冒頭で保存済み言語を同期的に適用する
- サーバ側・CLI の文言と `/api/usage` 応答は英語に統一し、ローカライズしない
- 対象文言: `index.html` 静的文言 / `main.ts`・`charts.ts`・`detail-panel.ts` 動的文言（チャート軸・tooltip・ステータス・空データ・期間詳細パネル・比較カード）/ `aggregate.ts` 系列ビルダーへ注入する表示ラベル / export 警告バナー。数値表記は言語で変えない（金額 USD 固定・桁区切り共通）

## 起動・配布

- リポジトリ内でのサーバ起動: `bun run dev`（フロントのビルド後に起動。`bun run src/server.ts` のみの起動でも可）
- npm 配布版の起動: `npx ccusage-ledger` / `bunx ccusage-ledger`（bin は `dist/ccusage-ledger.js` のバンドルで Node / Bun のどちらでも動く。ローカル対話環境では起動時にブラウザを自動で開く）
- サーバはデフォルトで `127.0.0.1:3000` に bind する。`HOST` / `PORT` 環境変数で変更可（例: `HOST=0.0.0.0` で LAN 公開）。`HOST` は IP リテラルまたはホスト名のみ受け付ける（`parseHostname` が検証。シェルメタ文字等は起動時に拒否）
- 認証は意図的に実装しない。フロントが全データを受信して描画する設計のため、ダッシュボード画面が見える相手＝全データが見える相手であり、認証は対症療法になる。境界は「画面に届ける人」の制限で担保する
- ループバック TCP ポートは同一マシンの全ローカルユーザーから閲覧できる（共有マシンではリスク。単一ユーザー前提の設計。起動時にその旨の警告を出す）
- `/api/usage` は接続元 IP がループバックの場合のみ配信する（bind ホスト名ではなく接続の実 source IP で判定。判定はパスをデコードした後に行うため、パーセントエンコード（`/%61pi/usage` 等）でゲートを迂回できない）。非ループバック bind（LAN 公開）でも SSH トンネル経由のループバック接続は配信される。403 ボディは generic な文言のみで、ポートやトンネルコマンドを含めない（トンネル案内は起動時コンソール出力と LAN 案内ページで行う）。rate limit は Host 検証・`/api` ゲートより後に適用する（Host 拒否・403 になるリクエストが rate limit の予算を消費しない。悪意ある Web ページの DNS-rebinding ループで被害者自身の予算を枯渇させてダッシュボードを 429 にするドライブバイ自己 DoS を防ぐ）
- ローカルリバースプロキシ（nginx の `proxy_pass` 等）で `127.0.0.1:3000` に転送すると、すべての接続がループバック発に見え、`/api/usage` がプロキシの届く範囲へ配信される（LAN bind の警告・案内ページを経由しない）。LAN 向けリバースプロキシの背後にこのダッシュボードを置くのは意図しない限り避ける（README にも明記）
- 非ループバック bind（例: `HOST=0.0.0.0`）では、非ループバック接続には「SSH トンネルを使え」という静的な案内ページのみを配信し、bundle.js 等のクライアント資産をネットワークに配信しない（平文 HTTP 上で on-path 攻撃者が改ざん・注入できる JS の攻撃面をなくす）。ループバック接続には通常のダッシュボードを配信する
- 静的配信は固定 allowlist（`/` → index.html、`/dist/bundle.js`、`/public/app.css`、`/public/vendor/chart.umd.min.js`）のみ。サーバ CLI バンドル（`/dist/ccusage-ledger.js`）やエクスポート成果物、それ以外のファイルは配信しない（hardlink / symlink による漏出と未知パスへの同期 FS アクセスを構造的に防ぐ）
- 非ループバック bind は起動時に警告を表示し、TTY では確認プロンプトを出す。非 TTY 環境では `CCUSAGE_LEDGER_ALLOW_LAN=1` を設定しない限り起動を拒否する（fail-closed）。`CCUSAGE_LEDGER_ALLOW_LAN=1` を設定すると確認なしで起動できる（警告のみ）
- LAN 上の別端末から見る場合は `ssh -L 3000:127.0.0.1:3000` による SSH トンネルを推奨する（トンネル自体がアクセス制限になり、接続元はループバックになるため `/api/usage` も利用できる）
- `/api/usage` は空データ（キャッシュ無し）と実データでレスポンスボディが異なるため、サーバーに到達できる相手は「利用者がエージェント CLI を使っているか」を判定できる（存在オラクル）。データ本体は設計上配信するため、この 1 ビットだけを隠すことはしない
- HTML エクスポート: `bun run export` → 実行時カレントの `dist/ccusage-ledger.html` に単一 HTML を出力。出力先が ccusage-ledger 以外の git リポジトリ内の場合は、個人データ入り HTML の誤コミットを防ぐため警告を出す
- エクスポート HTML の CSP は `<meta>` タグで注入し、script は生成時にランダム nonce を付与して `script-src 'unsafe-inline'` を避ける（エスケープ漏れがあっても nonce を持たない注入タグは CSP でブロックされる。style 属性のみ `style-src-attr 'unsafe-inline'` を許す）。ブラウザは `<meta>` の `frame-ancestors` を無視するため、フレーム検出 JS（frame buster）を注入して iframe 埋め込み時の表示を防ぎ、JS 無効環境には `<noscript>` 警告を注入する。ただし、JS を無効化した環境や CSP 無効化時は防げないため、外部配信する場合はサーバーのレスポンスヘッダで `X-Frame-Options: DENY` を付与すること
- 公開: `npm publish`（publish 直前に `bun run build` が実行される。`files` は明示 allowlist（bun.lock / index.html / dist/bundle.js / dist/ccusage-ledger.js / public/app.css / public/vendor/chart.umd.min.js）のため、エクスポート成果物や dist/ に置いた未知のファイルはリスト外としてそもそもパックされず、publish.yml の pack 検証でも混入を確認する。データ・シークレットはパッケージに含まれない）
- CI の GitHub Actions 参照は完全 SHA ピン + バージョンコメント必須で、`workflow-pins.test.ts` が機械的に検証する。Actions の更新は dependabot が提案するが auto-merge は無効（手動で再ピン確認する）

## 主要コマンド

- フロントビルド: `bun run build`
- テスト: `bun test`
- 型チェック: `bunx tsc --noEmit`
- リント: `bun run lint`（biome。`noNonNullAssertion` は `noUncheckedIndexedAccess` との併用慣用のため biome.jsonc で無効化している）
