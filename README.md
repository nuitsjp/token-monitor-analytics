# Token Monitor Analytics

Token Monitor Analytics は、複数の [Token Monitor](https://github.com/Javis603/token-monitor) Hub から定額制 AI サービスの利用実績や利用枠を収集し、実測増分に基づいて利用許容量（米ドル換算の参考値）を推定・保存するセルフホスト型ダッシュボードです。

## プロジェクトの現状

現在は**設計段階**です。[PLAN.md](PLAN.md) の計画に沿って、現在値の受信・保存・表示および検証環境の構築から順次進めます。

なお、初期版は限定された安全なネットワーク環境での利用を想定しており、ダッシュボード自体の利用者認証は後続実装とします（Hub への接続には共有シークレットを使用）。

## 初期版の提供機能

- 利用枠・消費率・API 換算額および取得状態の可視化
- 同一契約・利用枠・対象期間の実測増分に基づく利用許容量の推定と保存
- 日次・月次実績の定期収集、過去データの補完、推移の比較表示
- 複数 Hub の一括管理（登録、並行収集、状態監視、個別停止・再開）
- 手動更新機能、管理操作の入力検証・CSRF 対策、障害時の復旧情報提示

## 関連ドキュメント

- [設計方針](docs/design-policy.md): 製品要件、制約事項、品質要求、受け入れ条件
- [機能仕様](doc/spec/functional-spec.md): 推定・表示・履歴・管理の動作仕様、重要シナリオ（S1〜S9）の期待結果と検証条件
- [Hub 連携仕様](doc/spec/interfaces.md): Hub API の仕様、取得項目、制約事項
- [アーキテクチャ設計書](docs/architecture.md): システム構造、コンポーネント責務、状態管理、保存・処理境界
- [設計・開発計画 (PLAN.md)](PLAN.md): 開発計画、作業順序、未決・未検証事項、未実装機能一覧
- [用語定義 (CONTEXT.md)](CONTEXT.md): ドメイン用語の定義
- [文書方針](docs/document-policy.md) / [設計・文書作成の共通標準](docs/standards/design-and-documentation.md): 文書体系、正本管理、設計変更の手続き
- [外部プロジェクトテンプレート](https://github.com/nuitsjp/aidd-project-template): 設計・文書管理およびモック駆動開発を導入するための汎用ひな形
- [Private Hub 実データ資料](docs/reference/hub-private/README.md): API 調査時に取得した応答サンプルと確認範囲
