# Token Monitor Analytics のプロジェクト定義

## 1. 目的と範囲

製品の目的・利用者・対象範囲は未定義です。現在の提供範囲は [採用記録](document-policy.md#adoption) で承認された開発基盤に限ります。旧製品の機能を暗黙に復元しません。

## 2. 基盤の制約

Node.js 24、React、TypeScript、SQLiteを使用し、ローカルのループバックで起動します。認証方式、外部接続、業務データモデルと製品の受け入れ条件は未合意です。

<a id="usecases"></a>
## 3. ユースケース一覧

未定義です。最初のユースケースを含め、案の全文を対話で確認してから本文と一覧へ記録します。

<a id="design"></a>
## 4. 確認した事実

- 配布元 `a60085b` のReact拡張を採用しました。基盤構成は [アーキテクチャ](architecture.md) に記載しています。
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

設定は `.env`、DBは既定で `data/app.sqlite` です。DB・秘密設定は追跡しません。旧DBは接続しません。業務テーブルもモック切り替えも未実装です。

<a id="verification"></a>
## 6. 検証結果

製品の系列は未定義のため、系列の検証完了はありません。基盤の検証と製品の受け入れ検証は区別します。

| UC・系列 ID | 段階 | 構成 | 実行日 | コマンド | 合否 | 対象コミットまたは CI 参照 |
| --- | --- | --- | --- | --- | --- | --- |

基盤の検証（Windows、Node.js 24.19.0、2026-09-20、対象 `da3125f`）:

- `npm run setup`・`npm run verify`: 合格。設定テスト3件、Lint、文書、型、本番ビルドを確認。
- `npm audit`: 脆弱性0件。
- 本番entryの一時Node検証: health・HTML・静的アセットの200、サンプルAPIの404、空SQLite・WAL・整合性、同じDBでの再起動とIPC通常終了を2回確認。
- `npm run dev`・HTTP取得・`npm run db:check`: 合格。終了後に3000/5173番の停止を確認。
- ブラウザー描画確認: 合格。利用者の「Chromeを利用してください」に従い、`playwright-cli -s=analytics-chrome open http://127.0.0.1:3000/ --browser=chrome` でChrome 153の一時セッションを起動。タイトル・見出し・準備中の文面と再読み込み後の描画を確認。初回にfavicon未配置の404が1件あり、アプリのJavaScriptエラーはなし。LinuxおよびCIは未検証。

製品の単体・E2Eテストは未作成で、現時点の `verify` は設定の基盤テスト、Lint、文書、型、本番ビルドのみを実行します。
