# Token Monitor Analytics のプロジェクト定義

## 1. 目的と範囲

UC-1の受信・保存・保存後通知と、UC-2-Mの初回取得ダッシュボードは完了しています。自動更新のUC-2-X1は段階4の実SSE接続・手動確認を完了し、段階5の完成系監査の承認待ちです。他のパーツは固定サンプルから段階的に実装します。旧製品の機能を暗黙に復元しません。

## 2. 基盤の制約

Node.js 24、React、TypeScript、SQLiteを使用し、ローカルのループバックで起動します。UC-1ではGit管理外の接続設定ファイルから2つのHubへ接続します。利用者向けWeb認証は未実装です。Hubと最新状態を分離するテーブル設計も合意済みです。

<a id="usecases"></a>
## 3. ユースケース一覧

| UC ID | 主アクター | 目的 | 実装順序 | 実現パターン | モック適用 |
| --- | --- | --- | --- | --- | --- |
| [UC-1](usecases/UC-1.md) | 利用者 | Hubの最新情報をローカルに保存し、通知する | 1 | [UCP-1](architecture.md#patterns) | 対象外（UI確認不要） |
| [UC-2](usecases/UC-2.md) | 利用者 | 登録Hubの最新利用状況を閲覧する | 2 | [UCP-2](architecture.md#ucp-2) | 対象（UI確認必要） |

<a id="design"></a>
## 4. 確認した事実

- 配布元 `a60085b` のReact拡張を採用しました。基盤構成は [アーキテクチャ](architecture.md) に記載しています。
- Hubの固定版 `8b6cee22eabb7bf7ce0226655b46907300e14a04` の `src/hub/server.js`、`worker/src/index.js`、`src/shared/hubProtocol.js` と `docs/API.md` を静的に確認しました。初回snapshot、全体置換stats、鮮度更新freshnessが設計の根拠です。現在の実Hubとの相互接続も検証済みです。
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

UC-2-X1の実接続確認では、画面を開いてTODAY・MONTH・TOTALのいずれかを選び、Hubの保存後通知で数値・構成比・受信済み数が自動更新されることを確認します。切断中は最後の値と「再接続中」を表示し、再接続後に最新保存値へ追いつきます。仕様合意用モックは削除済みで、通常起動だけを使用します。固定サンプルの他パーツは実データ化の対象外です。

設定JSONは `{ "hubs": [...] }` の形式で、Hubを正確に2件指定します。各要素の `id`、`name`、`url`、`token` は必須です。IDは重複不可、URLはパス・認証情報・クエリを含まないHTTP(S) originです。形式は [設定例](../config/hubs.example.json) を参照します。アプリケーションは設定ファイルを更新しません。

Hubへの接続先は `/api/stats/stream` です。接続先URL・認証情報はDBへ保存しません。設定ファイルが存在しない、JSONや項目が不正、2件でない、またはIDが重複する場合は起動しません。起動後に一方の受信が停止しても、もう一方とWebサーバーは継続します。停止したHubはログのcause（response、connection、disconnected、invalid-notification、database）を確認し、原因を解消してアプリケーションを再起動します。自動再接続はありません。Webの `/health` はWebサーバーの稼働確認であり、Hub受信の正常性を示しません。

DB確認には別の読み取り専用SQLite接続を使い、`SELECT h.hub_id,h.name,s.received_at,s.stats_json FROM hubs h LEFT JOIN hub_states s ON s.hub_id=h.hub_id` を実行します。初回受信前の状態・受信時刻はNULLです。DBの整合性検査は `npm run db:check` で行います。

UC-1の保存後通知は、起動中に `curl.exe -N http://127.0.0.1:3000/api/usage/stream` で確認します（PORT変更時は読み替えます）。接続時とHubの保存成功後に `event: update` と閲覧用全体状態のJSONが届きます。Ctrl+Cで閲覧接続だけを閉じ、再実行すると最新保存値から再開します。UC-1の通知はHTTPで、UC-2-X1の画面への自動反映はPlaywright CLIで確認します。

<a id="verification"></a>
## 6. 検証結果

UC-1-Mは保存後通知の改訂を含め、完成系承認、段階6 E2E、実際の2 Hubとの相互接続まで完了しました。長時間低速接続の実測とLinux/CIは未検証です。基盤の検証と製品の受け入れ検証は区別します。

UC-2-Mも完成系承認、段階6 E2E、実Hubの保存値をChromeで閲覧する実環境検証まで完了しました。

| UC・系列 ID | 段階 | 構成 | 実行日 | コマンド | 合否 | 対象コミットまたは CI 参照 |
| --- | --- | --- | --- | --- | --- | --- |
| UC-2-X1 | 4 | Windows / Chrome 153 / 本番ビルド・制御可能な2 Hub・独立SQLite | 2026-09-21 | `npm run build`、`npm run lint`、`python scripts/doc_check.py .`（NG 0件）。Playwright CLIとNode REPLで未受信からの反映、複数Hubの合計・台数更新、TODAY維持、同時SSE最大1本、切断と503中の値保持・復旧後の最新値反映、初回API応答遅延中の保存反映、初回取得失敗時のSSE未開始、DB整合性を確認。意図した障害中のみ通信エラーを観測 | 合格 | 本行を含む提示コミット |
| UC-2-X1 | 4 | Windows / Chrome 153 / 実Hub Private・Work・本番ビルド | 2026-09-21 | 3001番で起動し、ブラウザー自身のSSEで10秒間に8通知を観測。再読み込みなしの取得時刻更新、SQLiteと表示の数値一致、DB整合性、通常時console error 0件。観測中の数値自体の増加はなし | 合格 | 本行を含む提示コミット |
| UC-2-X1 | 2 | Windows / Chrome 153 / 固定通知・共有Queryキャッシュ | 2026-09-21 | `npm run typecheck`、`npm run lint`、`python scripts/doc_check.py .`（NG 0件）、Playwright CLIで0・5・10・15秒のTODAY表示と期間維持、受信済み数・デバイス数、切断中の保持と再接続表示解除、MONTH・TOTAL切替、390px表示、console error 0件を確認。テストコードは未変更 | 合格 | 本行を含む提示コミット |
| UC-1-M（保存後通知） | 6 | Windows / 本番entry・制御可能な2 Hub・独立SQLite・HTTP SSE | 2026-09-21 | `npm run verify`（基盤3件、通知4件を含むE2E全12件、Lint・型・ビルド・文書成功）、`npm exec -- playwright test tests/e2e/usage-stream.spec.ts --workers=4 --repeat-each=3`（12件成功） | 合格 | `dd1a782` |
| UC-1-M（保存後通知） | 6 | Windows / Node.js 24.19.0 / 実Hub Private・Work・本番entry・検証専用SQLite | 2026-09-21 | Node REPLでSSEを購読し46通知を観測。両Hubの複数回更新、全期間のトークン数・コスト・両日時と独立DBの一致、秘密非露出、integrity_check、再接続後23通知、購読中の通常終了code 0を確認 | 合格 | `35c94f2` |
| UC-1-M（保存後通知） | 4 | Windows / Node.js 24.19.0 / 制御可能な2 Hub・本番entry・一時SQLite・複数HTTP購読 | 2026-09-21 | Node REPLで手動送信し別DB接続と照合。初回・全体置換・鮮度・heartbeat抑止、複数配信、切断と再接続、不正入力・保存失敗の通知抑止、配信読出失敗中の保存継続と復旧、秘密非露出、通常終了・再起動を確認 | 合格 | `a1cf846` |
| UC-1-M（保存後通知） | 4 | 既存の基盤・製品回帰検証。テスト追加・変更なし | 2026-09-21 | `npm run verify`（Lint、型、ビルド、文書NG 0件、基盤3件・既存E2E 8件成功） | 合格 | `a1cf846` |
| UC-1-M | 4 | Windows / Node.js 24.19.0 / 2つの外部HubをローカルSSEに置換・本番entry・一時SQLite | 2026-09-20 | Node REPLから本番entryを起動し、2 Hubの通知送信と別の読み取り専用DB接続で手動確認 | 合格 | `3bacaa4` |
| UC-1-M | 4 | 基盤検証 | 2026-09-20 | `npm run verify` | 合格 | `3bacaa4` |
| UC-1-M | 6 | Windows / Node.js 24.19.0 / 制御可能な2 Hub・本番entry・一時SQLite（E2E 2件、反復6件） | 2026-09-20 | `npm run verify`、`npm run test:e2e:repeat` | 合格 | `d736fbf` |
| UC-1-M | 6 | Windows / Node.js 24.19.0 / 実際の2 Hub・本番entry・一時SQLite | 2026-09-20 | Git管理外の接続設定で起動し、別の読み取り専用DB接続でsnapshot・継続更新・秘密情報非保存・通常終了を確認 | 合格 | `d736fbf` |
| UC-2-M | 4 | Windows / Node.js 24.19.0 / Chrome / 2 Hub・3デバイスの検証用SQLite | 2026-09-21 | `npm run verify`、本番ビルドを起動して受信前・受信後・API失敗・期間切替・390px表示を確認 | 合格 | `8b37f6a` |
| UC-2-M | 6 | Windows / 本番entry・制御可能なHub・独立SQLite / Chromium。UC-2 6件、全体8件、反復24件 | 2026-09-21 | `npm run verify`、`npx playwright test --workers=4 --repeat-each=3` | 合格 | `32f75c2` |
| UC-2-M | 6 | Windows / 実Hub・検証専用SQLite・本番ビルド / Chrome | 2026-09-21 | 3期間のSQLite・API・画面一致、ホスト名、秘密非公開、integrity_check、320〜1440pxの表示を確認 | 合格 | `ed0e180` |

手動確認では、設定JSONから2つのHubへ正しいトークンとプロトコル版で接続し、Hubごとのsnapshot保存とstats全体置換を確認しました。一方へ不正通知を送って停止させても、もう一方の保存とWeb稼働は継続しました。通常終了、再起動後の両Hubの状態維持、認証情報が保存内容・ログに出ないことも確認しました。設定が2件でない、ID重複、URL不正、未知項目を含む場合は固定メッセージで拒否しました。1 Hub版で確認済みの重複時の非加算、freshness、heartbeat、DB失敗、HTTP 401、通信断、SSE分割処理とDB移行の性質は変更していません。UI確認不要の系列なので、Playwrightによる画面操作は省略しています。段階5の承認後に製品E2Eを追加しました。

基盤の検証（Windows、Node.js 24.19.0、2026-09-20、対象 `da3125f`）:

- `npm run setup`・`npm run verify`: 合格。設定テスト3件、Lint、文書、型、本番ビルドを確認。
- `npm audit`: 脆弱性0件。
- 本番entryの一時Node検証: health・HTML・静的アセットの200、サンプルAPIの404、空SQLite・WAL・整合性、同じDBでの再起動とIPC通常終了を2回確認。
- `npm run dev`・HTTP取得・`npm run db:check`: 合格。終了後に3000/5173番の停止を確認。
- ブラウザー描画確認: 合格。利用者の「Chromeを利用してください」に従い、`playwright-cli -s=analytics-chrome open http://127.0.0.1:3000/ --browser=chrome` でChrome 153の一時セッションを起動。タイトル・見出し・準備中の文面と再読み込み後の描画を確認。初回にfavicon未配置の404が1件あり、アプリのJavaScriptエラーはなし。LinuxおよびCIは未検証。

`verify` は設定の基盤テスト、Lint、文書、型、本番ビルド、UC-1・UC-2の製品E2Eを実行します。通知E2Eは複数購読と保存値の一致、数値更新と鮮度更新、再接続、heartbeat・不正通知・保存失敗の通知抑止、保存値維持と他Hub継続、読出失敗時の503・接続終了と復旧、購読中の再起動を検証します。CIも同じコマンドを使用しますが、この変更のCI実行結果は未検証です。

UC-2-Mの既存E2Eには「自動更新なし」の旧仕様が残っています。UC-2-X1の段階4ではテストコードを変更・実行せず、段階5の承認後に段階6で自動更新の受け入れ条件へ更新します。UC-2-Mの実Hub検証は既存DBと別の検証用DBで実施しました。ツール・モデル・利用枠・トレンド等は固定サンプルで、受け入れ範囲はHub・デバイスです。
