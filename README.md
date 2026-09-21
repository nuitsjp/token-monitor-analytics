# Token Monitor Analytics

Reactテンプレートを基盤とするローカルアプリです。設定されたHubからSSEで最新状態を受信し、SQLiteへ保存します。Hubと最新状態を分けて保持するため、未受信のHubも識別できます。保存した最新状態はブラウザーのダッシュボードで閲覧でき、Hubの保存通知で自動更新します。

## 起動

Node.js 24とPython 3を使用します。リポジトリのルートで実行してください。

```sh
npm run setup
npm run dev
```

開発画面は http://127.0.0.1:5173/ です。終了は Ctrl+C。設定はセットアップで生成する `.env`、DBは既定で `data/app.sqlite` です。旧DBは使用しません。

Hub接続設定は [設定例](config/hubs.example.json) を `data/hubs.local.json` へコピーし、2つのHubのID・表示名・HTTP(S) origin・認証トークンを記入します。実ファイルはGit管理対象外です。別の場所に置く場合は `.env` の `HUB_CONFIG_PATH` を変更します。

本番形式でのローカル起動:

```sh
npm run build
npm start
```

http://127.0.0.1:3000/ を開きます。バックエンドはループバックで起動し、利用者向けWeb認証は未実装です。設定ファイルがない、不正、2件以外、またはHub IDが重複する場合は起動しません。認証情報をコミットしないでください。設定・DB確認・停止後の復旧は [運用手順](docs/project.md#commands) を参照してください。

## 検証

```sh
npm run verify
```

Lint、文書検査、設定の基盤テスト、型検査、本番ビルド、UC-1・UC-2の製品E2Eを実行します。E2Eはテストごとに2つのSSE Hub、本番Nodeプロセス、OS自動割当ポート、一時SQLiteを分離します。

## 文書

- [プロジェクト定義](docs/project.md): 採用済み基盤、実行手順、検証範囲。
- [アーキテクチャ](docs/architecture.md): 合意済み設計と実装状況。
- [React構成](docs/architecture-react.md): 責務とテスト分離。
- [文書方針](docs/document-policy.md): 採用版と適用範囲。
