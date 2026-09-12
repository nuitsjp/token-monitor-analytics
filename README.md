# Token Monitor Analytics

Token Monitor Analytics は、複数の [Token Monitor](https://github.com/Javis603/token-monitor) Hub から定額制 AI サービスの利用実績や利用枠を収集し、実測増分に基づいて利用許容量（米ドル換算の参考値）を推定・保存するセルフホスト型ダッシュボードです。

## プロジェクトの現状

現在は**設計段階**です。過去の実装資産はすべて [old/](old/README.md) へ退避済みであり、現行コードの実装は未着手です。旧実装の確認や動作検証は [退避先の案内](old/README.md) を参照してください。

## 初期版の計画機能

- 取得した利用枠・消費率・API 換算額および取得状態の可視化
- 同一契約・利用枠・対象期間の実測増分に基づく利用許容量の推定と保存
- 日次・月次実績の定期収集、過去データの補完、推移比較
- 複数 Hub の一括管理（登録、並行収集、状態監視、個別停止・再開）
- Basic 認証、安全な手動更新、障害発生時の復旧情報提示

## 関連ドキュメント

- [設計方針](docs/design-policy.md): 製品要件、制約事項、品質要求、完了条件
- [機能仕様](doc/spec/functional-spec.md): 推定・表示・履歴・管理の動作、S1〜S9 の期待結果と検証条件
- [Hub 連携仕様](doc/spec/interfaces.md): API の取得項目・意味・制約、調査根拠
- [アーキテクチャ設計書](docs/architecture.md): システム構造、識別・状態・保存の責務、S1〜S9 の処理境界
- [設計・開発計画 (PLAN.md)](PLAN.md): 到達点、作業順序、未決・未検証事項、未実装機能
- [用語定義 (CONTEXT.md)](CONTEXT.md): ドメイン用語の定義
- [文書方針](docs/document-policy.md) / [共通標準](docs/standards/design-and-documentation.md): 文書の正本管理と設計・変更手続き
- [退避資料 (old/)](old/README.md): 旧実装の起動方法と保管内容の案内
