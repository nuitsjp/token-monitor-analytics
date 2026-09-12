# Token Monitor Analytics

Token Monitor Analytics は、複数の [Token Monitor](https://github.com/Javis603/token-monitor) Hub から定額制 AI サービスの利用実績と利用枠を集め、実測増分から利用許容量を米ドル換算の参考値として推定・保存するセルフホスト型ダッシュボードです。

## 現在の状態

現在は設計段階です。実装・テスト・実行設定・CI・ローカルデータは [old/](old/README.md) に退避済みで、旧 Analytics は停止しています。ルートから起動できる現行実装はありません。旧実装を確認・起動する場合は [退避先の案内](old/README.md)を参照してください。

## 初期版の対象機能（未実装を含む）

- 取得した利用枠、消費率、API 換算額と取得状態の表示
- 同じ契約・利用枠・対象期間に属する実測増分による利用許容量の推定と保存
- 日次・月次実績の定期収集、補完、比較
- 複数 Hub の登録、並行収集、状態監視、個別の停止・再開
- Basic 認証、手動更新、失敗原因と復旧情報の表示

## 関連ドキュメント

- [設計方針](docs/design-policy.md): 製品の機能、制約、品質要求、完了条件
- [アーキテクチャ設計書](docs/architecture.md): Hub との契約、構造、識別・状態・保存、重要シナリオ
- [設計・開発計画](PLAN.md): 現在の到達点、作業順序、未決・未検証事項、未実装機能
- [用語定義](CONTEXT.md): ドメイン用語の意味
- [文書方針](docs/document-policy.md)と[共通標準](docs/standards/design-and-documentation.md): 文書の役割と設計・変更の手続き
- [退避した実装・資料](old/README.md): 旧実装の起動方法と保管内容
