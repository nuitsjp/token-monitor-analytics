# Token Monitor Analytics のプロジェクト定義

## 1. 目的と範囲

利用者がHubの最新情報をローカルで利用できるよう、まずUC-1の受信・保存を対象とします。UC-1-Mは実装とローカル手動確認を終え、完成系の承認待ちです。旧製品の機能を暗黙に復元しません。

## 2. 基盤の制約

Node.js 24、React、TypeScript、SQLiteを使用し、ローカルのループバックで起動します。UC-1ではサーバー側の接続設定と認証情報で1つのHubへ接続します。利用者向けWeb認証は未実装です。Hubと最新状態を分離するテーブル設計も合意済みです。

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

設定は `.env`、DBは既定で `data/app.sqlite` です。DB・秘密設定は追跡しません。旧DBは接続しません。Hub受信は以下の4項目をすべて設定すると有効になります。全項目未設定の場合は受信を無効にして基盤のみ起動し、一部だけの設定は起動エラーになります。本番経路に仕様合意用モックはありません。

| 設定 | 内容 |
| --- | --- |
| HUB_ID | 提供元を識別する安定したID。別の提供元には別IDを指定 |
| HUB_NAME | Hubの表示名。起動時に登録・更新 |
| HUB_URL | HubのHTTP(S) origin。パス・認証情報・クエリは含めない |
| HUB_TOKEN | Bearer認証に使う秘密情報 |

Hubへの接続先は `/api/stats/stream` です。接続先URL・認証情報はDBへ保存しません。受信停止時にはログのcause（response、connection、disconnected、invalid-notification、database）を確認し、原因を解消して再起動します。自動再接続はありません。Webの `/health` はWebサーバーの稼働確認であり、Hub受信の正常性を示しません。

DB確認には別の読み取り専用SQLite接続を使い、`SELECT h.hub_id,h.name,s.received_at,s.stats_json FROM hubs h LEFT JOIN hub_states s ON s.hub_id=h.hub_id` を実行します。初回受信前の状態・受信時刻はNULLです。DBの整合性検査は `npm run db:check` で行います。

<a id="verification"></a>
## 6. 検証結果

UC-1-Mは仕様と実現パターンが合意済みで、テーブル設計も合意済みです。段階4の実装とローカル手動確認は完了し、段階5の承認待ちです。実Hub・段階6のE2E・Linux/CIは未検証です。基盤の検証と製品の受け入れ検証は区別します。

| UC・系列 ID | 段階 | 構成 | 実行日 | コマンド | 合否 | 対象コミットまたは CI 参照 |
| --- | --- | --- | --- | --- | --- | --- |

基盤の検証（Windows、Node.js 24.19.0、2026-09-20、対象 `da3125f`）:

- `npm run setup`・`npm run verify`: 合格。設定テスト3件、Lint、文書、型、本番ビルドを確認。
- `npm audit`: 脆弱性0件。
- 本番entryの一時Node検証: health・HTML・静的アセットの200、サンプルAPIの404、空SQLite・WAL・整合性、同じDBでの再起動とIPC通常終了を2回確認。
- `npm run dev`・HTTP取得・`npm run db:check`: 合格。終了後に3000/5173番の停止を確認。
- ブラウザー描画確認: 合格。利用者の「Chromeを利用してください」に従い、`playwright-cli -s=analytics-chrome open http://127.0.0.1:3000/ --browser=chrome` でChrome 153の一時セッションを起動。タイトル・見出し・準備中の文面と再読み込み後の描画を確認。初回にfavicon未配置の404が1件あり、アプリのJavaScriptエラーはなし。LinuxおよびCIは未検証。

製品の単体・E2Eテストは未作成で、現時点の `verify` は設定の基盤テスト、Lint、文書、型、本番ビルドのみを実行します。
