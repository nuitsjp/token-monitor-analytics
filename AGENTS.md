# エージェント行動指針

作業着手前に [文書方針](docs/document-policy.md) で適用範囲を確認し、作業内容に応じた正本を参照してください（複数に該当する場合はすべて適用）。

| 作業内容 | 参照する正本 |
| --- | --- |
| すべての変更 | [設計方針](docs/design-policy.md)、[保護する合意](docs/document-policy.md#protected-agreements)、[共通標準 第6節](docs/standards/design-and-documentation.md#agreement-changes) |
| 設計の検討、設計・実装の作成・変更・レビュー | 設計方針、[機能仕様](doc/spec/functional-spec.md)・[連携仕様](doc/spec/interfaces.md)・[設計書](docs/architecture.md)の関係箇所、[共通標準 第2・4・5節](docs/standards/design-and-documentation.md) |
| コード・モック・テスト・実行設定の変更 | [文書方針（モック駆動開発）](docs/document-policy.md#mock-development)、[モック駆動開発](docs/standards/mock-driven-development.md) |
| 文書（`README.md`・`CONTEXT.md`・`PLAN.md`・`AGENTS.md`・`docs/**`・`doc/spec/**`）の作成・変更・レビュー | 文書方針、[共通標準 第3〜5節](docs/standards/design-and-documentation.md) |

※ ファイルの移動・削除や新規作成も含みます。文書のみの作業では、モック駆動開発の規約自体を編集する場合を除き同規約の参照は不要です。

- 未決・未検証事項や作業状況は [PLAN.md](PLAN.md) で確認・更新し、確定した仕様は各正本へ反映します。
- 作業完了前に[共通標準 第6節](docs/standards/design-and-documentation.md#agreement-changes)に基づき、着手時の合意・指示内容と差分を照合し、必須事項の欠落や未決事項の誤った完了扱いがないことを確認します。
