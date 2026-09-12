# エージェント行動指針

作業着手前に [文書方針](docs/document-policy.md) で採用版と適用範囲を確認し、該当する正本を参照してください。複数の条件に該当する場合はすべて適用します。

| 作業内容 | 参照する正本 |
| --- | --- |
| すべての変更 | [設計方針](docs/design-policy.md)、[保護する合意](docs/document-policy.md#protected-agreements)、[共通標準](docs/standards/design-and-documentation.md) 第6節 |
| 設計の検討、設計・実装の作成・変更・レビュー | 設計方針、[設計書](docs/architecture.md)の関係箇所、共通標準 第2・4・5節 |
| コード・モック・テスト・実行設定の変更（配置を問わない） | 実装計画の立案前に、[適用状態](docs/document-policy.md#mock-development)と[モック駆動開発](docs/standards/mock-driven-development.md)を確認し、適用の可否を判断する |
| `README.md`・`CONTEXT.md`・`PLAN.md`・`AGENTS.md`・`docs/**` の作成・変更・レビュー | 文書方針、共通標準 第3〜5節 |

※ ファイルの移動・削除、実装に伴う文書更新、新規文書の作成も含みます。文書のみの作業では、モック駆動開発の規約自体を編集する場合を除き、同規約の参照は不要です。

- 未決・未検証事項や作業状況は [PLAN.md](PLAN.md) で確認・更新し、確定した仕様は各正本へ記録する。
- 作業完了前に[共通標準 第6節](docs/standards/design-and-documentation.md#agreement-changes)に従い、着手時点の文書・合意および指示内容と差分を照合する。必須事項の欠落や未決事項の誤った完了扱いがないことを確認する。

