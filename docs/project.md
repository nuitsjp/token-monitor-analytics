# Token Monitor Analytics のプロジェクト定義

## 1. 目的と範囲

利用者がHubの最新情報をローカルで利用できるよう、まずUC-1の受信・保存を対象とします。UC-1-Mは実装とローカル手動確認を終え、完成系の承認待ちです。旧製品の機能を暗黙に復元しません。

## 2. 基盤の制約

Node.js 24、React、TypeScript、SQLiteを使用し、ローカルのループバックで起動します。UC-1ではGit管理外の接続設定ファイルから2つのHubへ接続します。利用者向けWeb認証は未実装です。Hubと最新状態を分離するテーブル設計も合意済みです。

<a id="usecases"></a>
## 3. ユースケース一覧

| UC ID | 主アクター | 目的 | 実装順序 | 実現パターン | モック適用 |
| --- | --- | --- | --- | --- | --- |
| [UC-1](usecases/UC-1.md) | 利用者 | Hubの最新情報をローカルに保存する | 1 | [UCP-1](architecture.md#patterns) | 対象外（UI確認不要） |

<a id="design"></a>
## 4. 確認した事実

- 配布元 `a60085b` のReact拡張を採用しました。基盤構成は [アーキテクチャ](architecture.md) に記載しています。
- Hubの固定版 `8b6cee22eabb7bf7ce0226655b46907300e14a04` の `src/hub/server.js`、`worker/src/index.js`、`src/shared/hubProtocol.js` と `docs/API.md` を静的に確認しました。初回snapshot、全体置換stats、鮮度更新freshnessが設計の根拠です。現在の実Hubとの相互接続は未検証です。
- [取得済みのHub実測資料](reference/hub-private/README.md) は保全しています。過去の観測であり、新製品の連携仕様や合意の代用にはしません。

<a id="commands"></a>
## 5. 実行・検証手順

リポジトリルートで `npm run setup` を実行します。依存関係は `package-lock.json` で固定し、セットアップはlockfileがある場合に `npm ci` を使います。

| 操作 | コマンド・確認 |
| --- | --- |
| 開発起動 | `npm run dev`、http://127.0.0.1:5173/ |
| 本番形式での起動 | `npm run build` 後に `npm start`、http://127.0.0.1:3000/ |
| サーバー確認 | `GET /health` が `{"status":"ok"}` を返す |
| 終了 | Ctrl+C |
| 基盤検証 | `npm run verify` |
| 文書検査 | `python scripts/doc_check.py .` |
| DB整合性 | `npm run db:check` |

設定は `.env`、DBは既定で `data/app.sqlite` です。DB・秘密設定は追跡しません。旧DBは接続しません。`.env` の `HUB_CONFIG_PATH` で、Git管理外の接続設定JSONを指定します。本番経路に仕様合意用モックはありません。

設定JSONは `{ "hubs": [...] }` の形式で、Hubを正確に2件指定します。各要素の `id`、`name`、`url`、`token` は必須です。IDは重複不可、URLはパス・認証情報・クエリを含まないHTTP(S) originです。形式は [設定例](../config/hubs.example.json) を参照します。アプリケーションは設定ファイルを更新しません。

Hubへの接続先は `/api/stats/stream` です。接続先URL・認証情報はDBへ保存しません。設定ファイルが存在しない、JSONや項目が不正、2件でない、またはIDが重複する場合は起動しません。起動後に一方の受信が停止しても、もう一方とWebサーバーは継続します。停止したHubはログのcause（response、connection、disconnected、invalid-notification、database）を確認し、原因を解消してアプリケーションを再起動します。自動再接続はありません。Webの `/health` はWebサーバーの稼働確認であり、Hub受信の正常性を示しません。

DB確認には別の読み取り専用SQLite接続を使い、`SELECT h.hub_id,h.name,s.received_at,s.stats_json FROM hubs h LEFT JOIN hub_states s ON s.hub_id=h.hub_id` を実行します。初回受信前の状態・受信時刻はNULLです。DBの整合性検査は `npm run db:check` で行います。

<a id="verification"></a>
## 6. 検証結果

UC-1-Mは2 Hub・設定ファイル対応の実装、完成系承認、段階6 E2E、実際の2 Hubとの相互接続まで完了しました。Linux/CIの実行結果は未検証です。基盤の検証と製品の受け入れ検証は区別します。

| UC・系列 ID | 段階 | 構成 | 実行日 | コマンド | 合否 | 対象コミットまたは CI 参照 |
| --- | --- | --- | --- | --- | --- | --- |
| UC-1-M | 4 | Windows / Node.js 24.19.0 / 2つの外部HubをローカルSSEに置換・本番entry・一時SQLite | 2026-09-20 | Node REPLから本番entryを起動し、2 Hubの通知送信と別の読み取り専用DB接続で手動確認 | 合格 | `3bacaa4` |
| UC-1-M | 4 | 基盤検証 | 2026-09-20 | `npm run verify` | 合格 | `3bacaa4` |
| UC-1-M | 6 | Windows / Node.js 24.19.0 / 制御可能な2 Hub・本番entry・一時SQLite（E2E 2件、反復6件） | 2026-09-20 | `npm run verify`、`npm run test:e2e:repeat` | 合格 | `d736fbf` |
| UC-1-M | 6 | Windows / Node.js 24.19.0 / 実際の2 Hub・本番entry・一時SQLite | 2026-09-20 | Git管理外の接続設定で起動し、別の読み取り専用DB接続でsnapshot・継続更新・秘密情報非保存・通常終了を確認 | 合格 | `d736fbf` |

手動確認では、設定JSONから2つのHubへ正しいトークンとプロトコル版で接続し、Hubごとのsnapshot保存とstats全体置換を確認しました。一方へ不正通知を送って停止させても、もう一方の保存とWeb稼働は継続しました。通常終了、再起動後の両Hubの状態維持、認証情報が保存内容・ログに出ないことも確認しました。設定が2件でない、ID重複、URL不正、未知項目を含む場合は固定メッセージで拒否しました。1 Hub版で確認済みの重複時の非加算、freshness、heartbeat、DB失敗、HTTP 401、通信断、SSE分割処理とDB移行の性質は変更していません。UI確認不要の系列なので、Playwrightによる画面操作は省略しています。段階5の承認後に製品E2Eを追加しました。

基盤の検証（Windows、Node.js 24.19.0、2026-09-20、対象 `da3125f`）:

- `npm run setup`・`npm run verify`: 合格。設定テスト3件、Lint、文書、型、本番ビルドを確認。
- `npm audit`: 脆弱性0件。
- 本番entryの一時Node検証: health・HTML・静的アセットの200、サンプルAPIの404、空SQLite・WAL・整合性、同じDBでの再起動とIPC通常終了を2回確認。
- `npm run dev`・HTTP取得・`npm run db:check`: 合格。終了後に3000/5173番の停止を確認。
- ブラウザー描画確認: 合格。利用者の「Chromeを利用してください」に従い、`playwright-cli -s=analytics-chrome open http://127.0.0.1:3000/ --browser=chrome` でChrome 153の一時セッションを起動。タイトル・見出し・準備中の文面と再読み込み後の描画を確認。初回にfavicon未配置の404が1件あり、アプリのJavaScriptエラーはなし。LinuxおよびCIは未検証。

`verify` は設定の基盤テスト、Lint、文書、型、本番ビルド、UC-1の製品E2Eを実行します。CIも同じコマンドを使用しますが、この変更のCI実行結果は未検証です。
