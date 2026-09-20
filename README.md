# Token Monitor Analytics

Reactテンプレートを適用した開発開始用の基盤です。トップ画面、Node.jsサーバー、空のSQLiteを起動できます。最初のユースケースであるHub受信・保存の仕様と実現パターンは合意済みです。テーブル設計は合意待ちで、製品機能は未実装です。

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

http://127.0.0.1:3000/ を開きます。バックエンドはループバックで起動し、利用者認証・外部Hub接続は未実装です。

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
