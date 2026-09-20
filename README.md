# Token Monitor Analytics

Reactテンプレートを基盤とするローカルアプリです。設定されたHubからSSEで最新状態を受信し、SQLiteへ保存します。Hubと最新状態を分けて保持するため、未受信のHubも識別できます。画面は起動用のままです。

## 起動

Node.js 24とPython 3を使用します。リポジトリのルートで実行してください。

```sh
npm run setup
npm run dev
```

開発画面は http://127.0.0.1:5173/ です。終了は Ctrl+C。設定はセットアップで生成する `.env`、DBは既定で `data/app.sqlite` です。旧DBは使用しません。

本番形式でのローカル起動:

```sh
npm run build
npm start
```

http://127.0.0.1:3000/ を開きます。バックエンドはループバックで起動し、利用者向けWeb認証は未実装です。Hub接続には `.env` に `HUB_ID`、`HUB_NAME`、`HUB_URL`（HTTP(S) origin）、`HUB_TOKEN` を設定します。全項目未設定なら受信は無効です。認証情報をコミットしないでください。設定・DB確認・停止後の復旧は [運用手順](docs/project.md#commands) を参照してください。

## 検証

```sh
npm run verify
```

Lint、文書検査、設定の基盤テスト、型検査、本番ビルドを実行します。製品の単体・E2Eテストは未作成で、このコマンドの対象に含みません。並列E2Eの構成とインスタンス分離fixtureはテンプレートから継承しています。製品テストは完成系の承認後に追加します。

## 文書

- [プロジェクト定義](docs/project.md): 採用済み基盤、実行手順、検証範囲。
- [アーキテクチャ](docs/architecture.md): 合意済み設計と実装状況。
- [React構成](docs/architecture-react.md): 責務とテスト分離。
- [文書方針](docs/document-policy.md): 採用版と適用範囲。
