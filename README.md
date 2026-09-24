# Token Monitor Analytics

設定されたHubからSSEで最新状態を受信し、SQLiteへ保存するローカルアプリです。保存した最新状態はブラウザーのダッシュボードで閲覧でき、Hubの保存通知で自動更新します。

起動、Hub接続設定、検証、配布物の生成は [実行・検証手順](docs/project.md#commands) に従ってください。Node.jsとPythonはmiseで管理し、版の正本は [mise.toml](mise.toml) と [mise.lock](mise.lock) です。

## 文書

- [プロジェクト定義](docs/project.md): 目的、制約、ユースケース一覧、運用手順。
- [アーキテクチャ](docs/architecture.md): 全体構造と設計上の制約。
- [React構成](docs/architecture-react.md): 基盤の責務とテスト分離。
- [文書方針](docs/document-policy.md): 適用する標準と正本の配置。
