# Token Monitor Analytics のプロジェクト定義

## 1. 目的と範囲

設定された2つのHubから最新の利用状況を受信してローカルへ保存し、ブラウザーのダッシュボードで閲覧します。対象範囲は [ユースケース一覧](#usecases)、実装と検証の到達点は [検証結果](#verification) が正本です。トレンドとアクティビティの各欄は固定サンプルで、段階的に実データへ置き換えます。旧製品の機能を暗黙に復元しません。

## 2. 基盤の制約

Node.js 24、React、TypeScript、SQLiteを使用し、ローカルのループバックで起動します。UC-1ではGit管理外の接続設定ファイルから2つのHubへ接続します。利用者向けWeb認証は未実装です。

<a id="usecases"></a>

## 3. ユースケース一覧

| UC ID | 主アクター | 目的 | 実装順序 | 実現パターン | モック適用 |
| --- | --- | --- | --- | --- | --- |
| [UC-1](usecases/UC-1.md) | 利用者 | Hubの最新情報をローカルに保存し、通知する | 1 | [UCP-1](architecture.md#patterns) | 対象外（UI確認不要） |
| [UC-2](usecases/UC-2.md) | 利用者 | 登録Hubの最新利用状況を閲覧する | 2 | [UCP-2](architecture.md#ucp-2) | 対象（UI確認必要） |

<a id="design"></a>

## 4. 確認した事実

- Hubの固定版 `8b6cee22eabb7bf7ce0226655b46907300e14a04` の `src/hub/server.js`、`worker/src/index.js`、`src/shared/hubProtocol.js` と `docs/API.md` を静的に確認しました。初回snapshot、全体置換stats、鮮度更新freshnessが設計の根拠です。現在の実Hubとの相互接続も検証済みです。
- [取得済みのHub実測資料](reference/hub-private/README.md) は保全しています。過去の観測であり、新製品の連携仕様や合意の代用にはしません。

<a id="commands"></a>

## 5. 実行・検証手順

リポジトリルートで `npm run setup` を実行します。依存関係は `package-lock.json` で固定し、セットアップはlockfileがある場合に `npm ci` を使います。

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

設定は `.env`、DBは既定で `data/app.sqlite` です。DB・秘密設定は追跡しません。`.env` の `HUB_CONFIG_PATH` でGit管理外の接続設定JSONを指定します。本番経路に仕様合意用モックはありません。

接続設定JSONは `{ "hubs": [...] }` の形式で、Hubを正確に2件指定します。各要素の `id`、`name`、`url`、`token` は必須です。IDは重複不可、URLはパス・認証情報・クエリを含まないHTTP(S) originで、接続先は `/api/stats/stream` です。形式は [設定例](../config/hubs.example.json) を参照します。アプリケーションは設定ファイルを更新しません。設定ファイルがない、JSONや項目が不正、2件でない、IDが重複する場合は起動しません。

起動後に一方の受信が停止しても、もう一方の受信とWebサーバーは継続します。ログの `cause` が `connection`・`disconnected` の通信断は自動で再接続します。`response`・`invalid-notification`・`database` で停止したHubは、原因を解消してアプリケーションを再起動します。`/health` はWebサーバーの稼働確認であり、Hub受信の正常性を示しません。

<a id="verification"></a>

## 6. 検証結果

記述済みの8系列はすべて段階6まで完了しています。下表は系列ごとの最新の合格記録です。段階2・4の中間実行はgitの履歴に委ね、ここには残しません。基盤の検証と製品の受け入れ検証は区別します。

| UC・系列 ID | 段階 | 構成 | 実行日 | コマンド | 合否 | 対象コミットまたは CI 参照 |
| --- | --- | --- | --- | --- | --- | --- |
| UC-1-M | 6 | Windows / 本番entry・制御可能な2 Hub・独立SQLite | 2026-09-21 | `npm run verify`（基盤3件・E2E全12件）、`npm exec -- playwright test tests/e2e/usage-stream.spec.ts --workers=4 --repeat-each=3`（12件） | 合格 | `dd1a782` |
| UC-1-M | 6 | Windows / 実Hub Private・Work・本番entry・検証専用SQLite | 2026-09-21 | SSEを購読して46通知を観測し、独立DBとの値の一致、秘密非露出、integrity_checkを確認 | 合格 | `35c94f2` |
| UC-1-X1 | 6 | Windows / 本番entry・制御可能な2 Hub・独立SQLite | 2026-09-21 | `npm run verify`（基盤3件・E2E全18件）、受信・通知E2Eの4並列3回反復（27件） | 合格 | `4750533` |
| UC-1-X1 | 6 | Windows / 実Hub Private・Work・本番entry・検証専用SQLite | 2026-09-21 | 再起動後の両Hubのsnapshot再保存と継続更新、秘密非露出、integrity_checkを確認 | 合格 | `4750533` |
| UC-2-M | 6 | Windows / 本番entry・制御可能なHub・独立SQLite / Chromium | 2026-09-21 | `npm run verify`（E2E全8件）、`npx playwright test --workers=4 --repeat-each=3`（24件） | 合格 | `32f75c2` |
| UC-2-M | 6 | Windows / 実Hub・検証専用SQLite・本番ビルド / Chrome | 2026-09-21 | 3期間のSQLite・API・画面の一致、ホスト名、秘密非公開、integrity_check、320〜1440pxの表示を確認 | 合格 | `ed0e180` |
| UC-2-X1 | 6 | Windows / 本番entry・制御可能なHub・独立SQLite / Chromium | 2026-09-21 | `npm run verify`（基盤3件・E2E全15件）、画面E2Eの4並列3回反復（27件） | 合格 | `c2cd933` |
| UC-2-X1 | 6 | Windows / 実Hub Private・Work・既存SQLite・本番ビルド / Chrome | 2026-09-21 | 受信停止と再起動をまたぐ値の保持、再接続表示、再読込なしの数値更新、integrity_checkを確認 | 合格 | `0f9c99a` |
| UC-2-X2 | 6 | Windows / 本番entry・制御可能なHub・独立SQLite / Chromium | 2026-09-21 | `npm run verify`（基盤3件・E2E全20件）、画面E2Eの4並列3回反復（30件） | 合格 | `7e125bc` |
| UC-2-X3 | 6 | Windows / 本番entry・制御可能な2 Hub・独立SQLite / Chromium | 2026-09-21 | `npm run verify`（基盤3件・E2E全21件）、画面E2Eの4並列3回反復（33件）。ツール別の全Hub集計、期間切替、通知更新、取得失敗、合計0を検証 | 合格 | `16791dd` |
| UC-2-X4 | 6 | Windows / 本番entry・制御可能なHub・独立SQLite / Chromium | 2026-09-21 | `npm run verify`（基盤3件・E2E全21件）、画面E2Eの4並列3回反復（33件）。上位9件＋その他、期間切替、通知更新、データなし表示を検証 | 合格 | `16791dd` |
| UC-2-X5 | 6 | Windows / 本番entry・制御可能なHub・独立SQLite / Chromium | 2026-09-21 | `npm run verify`（基盤3件・E2E全24件、Lint・型・ビルド・文書成功） | 合格 | `7e9137d` |
| UC-2-X5 | 6 | Windows / 実Hub Private・Work・検証専用SQLite・本番ビルド / Chrome | 2026-09-21 | アカウント見出し、Weeklyのみを持つCodex Pro 5x、未来時刻のリセット、メール非公開、固定サンプルなしを確認 | 合格 | `7e9137d` |

`npm run verify` はLint、文書検査、設定の基盤テスト、型検査、本番ビルド、UC-1・UC-2の製品E2Eを実行します。CIも同じコマンドを使用します。

基盤の検証（Windows、Node.js 24.19.0、2026-09-20、対象 `da3125f`）は `npm run setup`、`npm run verify`、`npm audit`（脆弱性0件）、`npm run dev`、`npm run db:check`、本番entryの起動とブラウザー描画の確認まで合格しています。

未検証の範囲は、Linuxおよび CI での実行、長時間低速接続の実測、UC-2-X3のツール別集計に対する外部実Hubでの追加確認です。
