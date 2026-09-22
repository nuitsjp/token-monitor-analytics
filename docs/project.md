# Token Monitor Analytics のプロジェクト定義

## 1. 目的と範囲

設定された2つのHubから最新の利用状況を受信してローカルへ保存し、ブラウザーのダッシュボードで閲覧します。対象範囲は [ユースケース一覧](#usecases) を参照します。トレンドとアクティビティの各欄は固定サンプルで、段階的に実データへ置き換えます。旧製品の機能を暗黙に復元しません。

## 2. 基盤の制約

Node.js（指定版は [`.nvmrc`](../.nvmrc)）、React、TypeScript、SQLiteを使用し、ローカルのループバックで起動します。「Hubの最新情報を保存して通知する」ではGit管理外の接続設定ファイルから2つのHubへ接続します。利用者向けWeb認証は未実装です。

<a id="usecases"></a>

## 3. ユースケース一覧

| ユースケース | 主アクター | 目的 | 実装順序 | 実現パターン | モック適用 |
| --- | --- | --- | --- | --- | --- |
| [Hubの最新情報を保存して通知する](usecases/Hubの最新情報を保存して通知する/README.md) | 利用者 | Hubの最新情報をローカルに保存し、通知する | 1 | [UCP-1](design/UCP-1.md) | 対象外（UI確認不要） |
| [利用状況を閲覧する](usecases/利用状況を閲覧する/README.md) | 利用者 | 登録Hubの最新利用状況を閲覧する | 2 | [UCP-2](design/UCP-2.md) | 対象（UI確認必要） |

<a id="design"></a>

## 4. 確認した事実

- Hubの固定版 `8b6cee22eabb7bf7ce0226655b46907300e14a04` の `src/hub/server.js`、`worker/src/index.js`、`src/shared/hubProtocol.js` と `docs/API.md` を静的に確認しました。初回snapshot、全体置換stats、鮮度更新freshnessが設計の根拠です。
- [取得済みのHub実測資料](reference/hub-private/README.md) は保全しています。過去の観測であり、新製品の連携仕様や合意の代用にはしません。

<a id="commands"></a>

## 5. 実行・検証手順

リポジトリルートを作業ディレクトリとします。[`.nvmrc`](../.nvmrc) の指定版Node.jsとPython 3を用意し、`npm run setup` を実行します。セットアップはNode.jsの版の一致を確認して、`package-lock.json` に従い `npm ci` を実行します。依存を更新する場合は `package.json` とロックを併せて更新します。

| 操作 | コマンド・確認 |
| --- | --- |
| 開発起動 | `npm run dev`、http://127.0.0.1:5173/ |
| 本番形式での起動 | `npm run build` 後に `npm start`、http://127.0.0.1:3000/ |
| 終了 | Ctrl+C |
| サーバー確認 | `GET /health` が `{"status":"ok"}` を返す |
| 基盤・製品検証 | `npm run verify` |
| 文書検査 | `python scripts/doc_check.py .` |
| DB整合性 | `npm run db:check` |
| 保存後通知の確認 | 起動中に `curl.exe -N http://127.0.0.1:3000/api/usage/stream` を実行し、接続時とHubの保存成功後に `event: update` が届くことを確認する |
| 保存内容の確認 | 読み取り専用の別SQLite接続で `SELECT h.hub_id,h.name,s.received_at,s.stats_json FROM hubs h LEFT JOIN hub_states s ON s.hub_id=h.hub_id` を実行する。初回受信前の状態・受信時刻はNULL |

セットアップは `.env.example` から未作成の `.env` を生成します。[設定例](../config/hubs.example.json) を `data/hubs.local.json` へコピーし、接続する2つのHubの値を記入します。DBは既定で `data/app.sqlite` です。DB・秘密設定は追跡しません。`.env` の `HUB_CONFIG_PATH` でGit管理外の接続設定JSONを指定します。本番経路に仕様合意用モックはありません。

接続設定JSONは `{ "hubs": [...] }` の形式で、Hubを正確に2件指定します。各要素の `id`、`name`、`url`、`token` は必須です。IDは重複不可、URLはパス・認証情報・クエリを含まないHTTP(S) originで、接続先は `/api/stats/stream` です。形式は [設定例](../config/hubs.example.json) を参照します。アプリケーションは設定ファイルを更新しません。設定ファイルがない、JSONや項目が不正、2件でない、IDが重複する場合は起動しません。

起動後に一方の受信が停止しても、もう一方の受信とWebサーバーは継続します。ログの `cause` が `connection`・`disconnected` の通信断は自動で再接続します。`response`・`invalid-notification`・`database` で停止したHubは、原因を解消してアプリケーションを再起動します。`/health` はWebサーバーの稼働確認であり、Hub受信の正常性を示しません。

### ブラウザーと検証

初回は `npm exec -- playwright install --only-shell chromium` で、導入したPlaywrightに対応するHeadless Shellを取得します。Linuxでは `--with-deps` も指定します。組織のプロキシを経由する環境では、実行前に端末の `HTTPS_PROXY` を設定し、値はリポジトリへ保存しません。

ブラウザー実体を指定する場合は `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` を使います。その環境で `--disable-extensions` による起動失敗を確認した場合だけ、`PLAYWRIGHT_IGNORE_DISABLE_EXTENSIONS=1` を指定して同引数を除外します。自動で別のブラウザーへ切り替えません。

`npm run verify` はLint、文書検査、設定の基盤テスト、型検査、本番ビルド、Hub受信・通知と利用状況閲覧の製品E2Eを実行します。CIも同じコマンドを使用します。`npm run test:e2e:repeat` はビルド後にE2Eを4並列で3回実行します。各テストの分離は [検証基盤](architecture-react.md#3-検証基盤) を参照します。

| 検証対象 | 条件・期待結果 |
| --- | --- |
| 受信・保存・通知 | 制御可能な2つのSSE Hub、本番Nodeプロセス、独立した読み取り専用SQLite接続を使い、通知内容と保存値、通信断・再接続、秘密情報が公開されないことを確認する |
| ダッシュボード | 同じ構成のHubとブラウザーを使い、期間別のSQLite・API・画面の値、通知後の更新、取得失敗、データなし表示、ツール・モデル・利用枠の表示を各系列の受け入れ条件と照合する |
| 実Hubとの接続 | Git管理外の接続設定と検証専用SQLiteを使い、両Hubのsnapshot保存、継続更新、再起動後の値、保存後通知、秘密情報の非公開を確認する |
| 保存と画面 | `npm run db:check` の整合性確認に加え、受信停止と再起動をまたぐ値の保持、320〜1440pxでの画面表示、長時間の低速接続に対する配信を確認する |

### 配布物の生成

`npm run package` は全体検証後に `release/app` を生成し、ビルド成果物、`package.json`、`package-lock.json`、`.nvmrc`、設定例を配置します。配布先でも指定版Node.jsを使用し、`npm ci --omit=dev` を実行して `.env` とHub接続設定を用意してから `npm start` で起動します。DBは配布ディレクトリの外に置きます。
