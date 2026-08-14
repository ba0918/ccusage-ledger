# ccusage Ledger

`ccusage`（依存として固定した `ccusage@20.0.19`）が出力する JSON を元に、エージェント CLI (Claude Code / Codex / OpenCode 等) の使用量・トークン量・金額を可視化する個人用ダッシュボード。

## 技術スタック

- **サーバ**: Bun + TypeScript。HTTP レイヤーは Hono（`hono`）を使用し、Bun 実行時は `Bun.serve`、Node 実行時は `@hono/node-server` で起動する
- **データ取得**: dependencies で固定した `ccusage@20.0.19`（bun.lock で integrity 固定）の `node_modules/ccusage/src/cli.js` を、実行中ランタイムの `process.execPath`（Bun / Node）で直接 spawn して `--json --sections daily,monthly --by-agent` で全履歴を取得（`bunx` や `bun run` は使わない。PATH ハイジャック対策としてランタイムを直接指定する）
- **フロント**: 素の TypeScript + Chart.js (vendored)。`bun run build` でバンドル

## データフロー

1. サーバ起動時に依存の `ccusage@20.0.19` を直接実行し、そのマシンの全履歴を取得（子プロセスには許可リストの環境変数のみ渡す。API キー等の秘密は渡さない。HOME は渡さず空の一時ディレクトリを設定し、データソースは各エージェントのデータディレクトリ env（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_DATA_DIR` / `OPENCODE_DATA_DIR`）だけを渡す。ccusage がデフォルト探索で `~/.ssh` 等のエージェント以外の秘密に触れるのを防ぐ。ただし実行ユーザーが同じであるため、改ざんされたバイナリがファイルシステムを直接探索することは防げない。post-install の改ざん検出として、起動ごとに `node_modules/ccusage` ラッパーの sha256 を固定値（`CCUSAGE_WRAPPER_SHA256`）と照合する。ラッパーはプラットフォーム非依存のため全プラットフォームで検証される。実行プラットフォームの native バイナリ（`@ccusage/ccusage-<platform>-<arch>`）はプラットフォーム別テーブル（`CCUSAGE_NATIVE_SHA256_BY_PLATFORM`）と照合する（ccusage@20.0.19 が提供する全 6 プラットフォームを npm tarball から計算して登録済み。登録は各プラットフォームで再計算する）。将来の新プラットフォームで未登録の場合は検証不可として実行を拒否する（fail-closed。`CCUSAGE_LEDGER_ALLOW_UNVERIFIED_NATIVE=1` で明示オプトインすると WARN のみで続行）。照合ハッシュは同一成果物内に同梱されるため、固定版そのものの悪意ある publish や同一ユーザーの改ざんは検知できない（自己参照の限界。検知対象はローカル/レジストリ上の post-install 改ざん））
2. 結果を `~/.cache/ccusage-ledger/usage.json` に上書き保存（最新1ファイルキャッシュ方式。`XDG_CACHE_HOME` があればそれを基準。キャッシュディレクトリが自分所有かつ 0700 であることを確認できない場合は読み書きとも行わない（fail-closed。書込みは 0700 へ修復を試み、読込みはキャッシュなし扱いになる）。Windows は `statSync().mode` が POSIX 権限を持たず `process.getuid` も無いため所有者・権限のどちらも Node から検証できない。代わりに「ユーザープロファイル配下か」で判定し、`XDG_CACHE_HOME` 等でプロファイル外を指した場合は検証不能として拒否する（NTFS ACL 自体は検証していない。プロファイルの ACL が緩められている場合は守れないのが残余リスク））
3. サーバが JSON を配信し、フロントがクライアント側で集計して描画

## データ構造（ccusage JSON）

- トップレベルに `daily` / `weekly` / `monthly` などのセクション（`yearly` は無い）
- 各 period エントリ: `period`（日 or 月）、`totalCost`、`totalTokens`、`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheCreationTokens`、`modelsUsed[]`、`modelBreakdowns[]`、`metadata.agents[]`、`agents[]`（エージェント別内訳。`--by-agent` で取得）
- `modelBreakdowns[]`: モデル別の `modelName` / `cost` / 各トークン数
- yearly は monthly をクライアントで集計して生成
- スキーマ・検証には将来の複数デバイス対応のため `device` フィールドを最初から含める（白リスト投影（`projectUsageData`）からは落とすため、配信・描画では常に undefined。将来描画するときに投影へ追加する）

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

- リポジトリ内でのサーバ起動: `bun run dev`（フロントのビルド後に起動。`bun run src/cli.ts` のみの起動でも可）
- npm 配布版の起動: `npx ccusage-ledger` / `bunx ccusage-ledger`（bin は `dist/ccusage-ledger.js` のバンドルで Node / Bun のどちらでも動く。ローカル対話環境では起動時にブラウザを自動で開く）
- サーバはデフォルトで `127.0.0.1:3737` に bind する。既定を 3000 にしないのは、React / Next / Rails 等の開発サーバーと競合して初回起動が EADDRINUSE になりやすいため（Windows の動的ポート範囲 49152-65535 も避ける）
- ポートは `--port` / `-p` / `PORT`、bind アドレスは `--host` / `HOST` で変更できる（`--name=value` 形式も可）。優先順位はどちらも CLI オプション > 環境変数 > 既定値で、解決規則は `resolveSetting` に共通化する（host / port で別々に書いた結果、`HOST=""` は起動不能・`PORT=""` は既定値、という非対称が実際に生まれた）。既定値以外で決まった場合は起動ログに決定元（`(host from --host)` / `(port from PORT)` 等）を表示する（環境変数の残存で「既定値が効かない」と誤解する事例が実際に起きたため）
- `--host` に短縮形は与えない（`-h` は help。紛らわしい短縮形は取り違えて意図せず LAN 公開する事故につながる）。LAN 公開のガードは解決後の bind アドレスだけで判定し、`--host` が環境変数より緩い抜け道にならないようにする（`cli.test.ts` が両者のポリシー一致を固定している）
- bind アドレスは IP リテラルまたはホスト名のみ受け付ける（`parseHostname` が検証。値が `browserUrl` → `openBrowser` に流れるため、シェルメタ文字等は起動時に拒否する）
- 認証は意図的に実装しない。フロントが全データを受信して描画する設計のため、ダッシュボード画面が見える相手＝全データが見える相手であり、認証は対症療法になる。境界は「画面に届ける人」の制限で担保する
- ループバック TCP ポートは同一マシンの全ローカルユーザーから閲覧できる（共有マシンではリスク。単一ユーザー前提の設計。起動時にその旨の警告を出す）
- `/api/usage` は接続元 IP がループバックの場合のみ配信する（bind ホスト名ではなく接続の実 source IP で判定。判定はパスをデコードした後に行うため、パーセントエンコード（`/%61pi/usage` 等）でゲートを迂回できない）。さらに `/api/*` は Host ヘッダもループバックを要求する（bind モードに関係なく適用。LAN モードで Host 検証が無効化されるため、DNS rebinding ページが 127.0.0.1 への同一オリジン fetch で全履歴を読めるのを防ぐ）。非ループバック bind（LAN 公開）でも SSH トンネル経由のループバック接続は配信される。403 ボディは generic な文言のみで、エンドポイント名・ポート・トンネルコマンドを含めない（トンネル案内は起動時コンソール出力と LAN 案内ページで行う）。rate limit は Host 検証・`/api` ゲートより後に適用する（Host 拒否・403 になるリクエストが rate limit の予算を消費しない。悪意ある Web ページの DNS-rebinding ループで被害者自身の予算を枯渇させてダッシュボードを 429 にするドライブバイ自己 DoS を防ぐ）。rate limit のキーは (source IP, Host) のペアで、Host 別のリクエストは別バケットになる（Host: 127.0.0.1 の img ループによる共有バケット枯渇はループバック共有の残余リスクとして許容）
- ローカルリバースプロキシ（nginx の `proxy_pass` 等）で `127.0.0.1:3737` に転送すると、すべての接続がループバック発に見え、`/api/usage` がプロキシの届く範囲へ配信される（LAN bind の警告・案内ページを経由しない）。LAN 向けリバースプロキシの背後にこのダッシュボードを置くのは意図しない限り避ける（README にも明記）
- 非ループバック bind（例: `--host 0.0.0.0`）では、非ループバック接続には「SSH トンネルを使え」という静的な案内ページのみを配信し、bundle.js 等のクライアント資産をネットワークに配信しない（平文 HTTP 上で on-path 攻撃者が改ざん・注入できる JS の攻撃面をなくす）。ループバック接続には通常のダッシュボードを配信する
- 静的配信は固定 allowlist（`/` → index.html、`/dist/bundle.js`、`/public/app.css`、`/public/vendor/chart.umd.min.js`）のみ。サーバ CLI バンドル（`/dist/ccusage-ledger.js`）やエクスポート成果物、それ以外のファイルは配信しない（hardlink / symlink による漏出と未知パスへの同期 FS アクセスを構造的に防ぐ）
- 非ループバック bind は起動時に警告を表示し、TTY では確認プロンプトを出す。非 TTY 環境では `CCUSAGE_LEDGER_ALLOW_LAN=1` を設定しない限り起動を拒否する（fail-closed）。`CCUSAGE_LEDGER_ALLOW_LAN=1` を設定すると確認なしで起動できる（警告のみ）
- LAN 上の別端末から見る場合は `ssh -L 3737:127.0.0.1:3737` による SSH トンネルを推奨する（トンネル自体がアクセス制限になり、接続元はループバックになるため `/api/usage` も利用できる）
- `/api/usage` は空データ（キャッシュ無し）と実データでレスポンスボディが異なるため、サーバーに到達できる相手は「利用者がエージェント CLI を使っているか」を判定できる（存在オラクル）。データ本体は設計上配信するため、この 1 ビットだけを隠すことはしない
- HTML エクスポート: `bun run export` → 実行時カレントの `dist/ccusage-ledger.html` に単一 HTML を出力。出力先が ccusage-ledger 以外の git リポジトリ内の場合は、個人データ入り HTML の誤コミットを防ぐためデフォルトで書き込みを拒否する（`CCUSAGE_LEDGER_EXPORT_ALLOW_FOREIGN=1` で明示オプトイン）
- エクスポート HTML の CSP は `<meta>` タグで注入し、script は生成時にランダム nonce を付与して `script-src 'unsafe-inline'` を避ける（エスケープ漏れがあっても nonce を持たない注入タグは CSP でブロックされる。style 属性のみ `style-src-attr 'unsafe-inline'` を許す）。ブラウザは `<meta>` の `frame-ancestors` を無視するため、フレーム検出 JS（frame buster）を注入して iframe 埋め込み時の表示を防ぎ、JS 無効環境には `<noscript>` 警告を注入する。ただし、JS を無効化した環境や CSP 無効化時は防げないため、外部配信する場合はサーバーのレスポンスヘッダで `X-Frame-Options: DENY` を付与すること
- 公開: `npm publish`（publish 直前に `bun run build` が実行される。`files` は明示 allowlist（bun.lock / index.html / dist/bundle.js / dist/ccusage-ledger.js / public/app.css / public/vendor/chart.umd.min.js）のため、エクスポート成果物や dist/ に置いた未知のファイルはリスト外としてそもそもパックされず、publish.yml の pack 検証でも混入を確認する。データ・シークレットはパッケージに含まれない）
- CI の GitHub Actions 参照は完全 SHA ピン + バージョンコメント必須で、`workflow-pins.test.ts` が機械的に検証する。Actions の更新は dependabot が提案するが auto-merge は無効（手動で再ピン確認する）
- 既定ポートなど「コードとドキュメントの両方に現れる値」は `docs-consistency.test.ts` が突き合わせる（`--help` / README / `docs/spec` が同じ既定ポート・既定 bind アドレスを示すこと、README と仕様書が CLI オプションに触れていること、`--help` と README の環境変数一覧が一致すること）。既定ポートを 3000 → 3737 に変えた際に片側だけ直して取り残した経緯があるため、機械的に固定する

## リリース手順

タグ push をトリガにする。`main` にマージ済みの内容だけを公開する。

1. `main` を最新にして、`bun test` / `bunx tsc --noEmit` / `bun run lint` が通ることを確認する
2. `package.json` の `version` を上げて commit し、`main` へマージする（例: `0.1.0` → `0.1.1`）
3. マージ後の `main` に注釈付きタグを打って push する

```sh
git checkout main && git pull
git tag -a "v$(node -p "require('./package.json').version")" -m "Release v$(node -p "require('./package.json').version")"
git push origin "v$(node -p "require('./package.json').version")"
```

publish ワークフロー（`.github/workflows/publish.yml`）が以下の順で実行する。前段のガードはいずれも
「取り返しがつかない公開事故」を構造的に防ぐためのもので、`workflow-pins.test.ts` が存在を固定している。

- タグ名と `package.json` の `version` の一致を検証（不一致で publish するとそのバージョン番号を消費して復旧できない。npm は同一バージョンの再公開を拒否する）
- タグのコミットが `main` の履歴に含まれることを検証（作業ブランチへの誤タグで公開されない）
- `bun audit` と `npm pack --dry-run` の配布物検証（秘密ファイル・個人データ入り HTML の混入拒否）
- `prepublishOnly`（テスト・型チェック・lint・build）を経て `npm publish --provenance`
- publish 成功後に `gh release create --generate-notes` で GitHub Release を作成（失敗時に Release だけが残らないよう publish の後に置く）

補足:

- 公開は npm の Trusted Publishing（OIDC）で行う。**長期トークンは使わず、GitHub の secret に npm トークンを置かない**（npmjs.com のパッケージ設定でこのリポジトリとワークフローファイルを信頼するよう登録済みであることが前提）。トークンが存在しないため、漏洩・失効・2FA の OTP 要求（`EOTP`）が構造的に起こらない
- Trusted Publishing は npm CLI 11.5.1 以上・Node 22.14.0 以上を要求するため、publish ワークフローで npm を明示的に入れ直している。`registry-url` は指定しない（指定すると空の `NODE_AUTH_TOKEN` を参照する `.npmrc` が生成され、トークン認証扱いになって OIDC の経路に入らない）
- provenance は Trusted Publishing では自動付与されるため、`--provenance` は指定しない
- Trusted Publishing は**既に存在するパッケージにしか設定できない**（名前乗っ取り防止）。新しいパッケージ名で公開を始める場合、初回だけはローカルから `npm publish` する必要がある
- バージョンを間違えてタグを打った場合は、push 前ならタグを消してやり直す。既に publish まで通った場合はそのバージョンは再利用できないため、次の番号で出し直す
- `CHANGELOG.md` は持たず、GitHub Release の自動生成ノート（マージされた PR の一覧）を変更履歴とする

## 主要コマンド

- フロントビルド: `bun run build`
- テスト: `bun test`
- 型チェック: `bunx tsc --noEmit`
- リント: `bun run lint`（biome。`noNonNullAssertion` は `noUncheckedIndexedAccess` との併用慣用のため biome.jsonc で無効化している）
