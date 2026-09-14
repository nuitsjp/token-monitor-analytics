# エージェント行動指針

作業の現在地は [PLAN.md](PLAN.md) 第1節が唯一の正本です。着手前に現在のユースケースと段階を確認し、段階を自分の判断で進めません。

作業時は下表の正本を参照します。

| 作業 | 参照する正本 |
| --- | --- |
| すべての変更 | [設計方針](docs/design-policy.md)、[保護する合意](docs/document-policy.md#protected-agreements)、[変更手続き](docs/standards/design-and-documentation.md#agreement-changes) |
| 仕様・設計・実装・テストの作成・変更・レビュー | [設計・実装の原則](docs/standards/design-and-documentation.md#implementation-principles)、[機能仕様](doc/spec/functional-spec.md)、[連携仕様](doc/spec/interfaces.md)、対象ユースケースの本文と受け入れ条件（[プロジェクト定義](docs/project.md#usecases)） |
| 全体構造・実現パターン・設計判断の参照と変更 | [設計書](docs/architecture.md)、[全体設計と先行してよい成果物](docs/standards/design-and-documentation.md#architecture-method) |
| 層・抽象化・依存関係などの追加 | [仕組みの追加基準](docs/standards/design-and-documentation.md#design-decisions) |
| モック対象となるユースケースの変更、次のユースケースへ進む判断 | [適用範囲](docs/document-policy.md#mock-development)、[モック駆動開発の標準](docs/standards/mock-driven-development.md#workflow)、[PLAN.md](PLAN.md) のユースケース進捗の状態語 |
| 文書の作成・変更・移動・削除 | [文書と記録の基準](docs/standards/design-and-documentation.md#document-roles)、[文書の役割と配置](docs/document-policy.md#document-structure) |
| 導入、規約・標準・文書方針の改訂 | [文書方針](docs/document-policy.md)、[標準の扱い](docs/standards/design-and-documentation.md) |

## 作業原則

- **停止点**: 人の確認を待つのは、全体設計の合意と、ユースケースごとの動作合意（段階3）の2箇所です。停止点では作業を止めて応答を待ち、応答の原文を合意記録に引用します。質問は未確定事項に限り、合意済み事項の再確認は求めません。合意待ちの間に進めてよい作業は [モック標準第2節](docs/standards/mock-driven-development.md#workflow) に従います。
- **スコープの遵守**: 依頼範囲に必要な作業のみを進め、推測による機能追加や無関係なリファクタリングは行いません。調査や評価の依頼では所見を成果物とし、実装は変更しません。
- **文書**: `docs/standards/` は編集しません。文書には現在の状態だけを書き、経緯は git、証跡はテストと CI に置きます。規約・標準・文書方針の改訂は実装作業と別の変更にします。
- **完了基準と報告**: 完了前に `scripts/doc_check.py` を実行して出力を報告に含め、[完了基準](docs/standards/design-and-documentation.md#completion) に照らします。未実施の検証は「未検証」と明記し、未検証のまま状態語を進めません。失敗時はエラー出力を提示します。
