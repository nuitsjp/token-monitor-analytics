# エージェント行動指針

作業は1本の系列を段階1から段階6まで通す単位とし、セッションをまたぐ場合も同じ系列を継続します。着手・再開前に対象のユースケース・系列と段階を利用者と確認し、自己判断で段階を進めません。初期の記入欄や例示は確定仕様や検証実績ではないため、前提としません。

作業時は下表の正本を参照します。

| 作業 | 参照する正本 |
| --- | --- |
| すべての変更 | [プロジェクト定義](docs/project.md)、[仕様変更の対象](docs/document-policy.md#agreements)、[変更手続き](docs/standards/design-and-documentation.md#agreement-changes) |
| 仕様・設計・実装・テストの作成・変更・レビュー | [設計・実装の原則](docs/standards/design-and-documentation.md#implementation-principles)、対象ユースケースの本文と受け入れ条件 |
| 全体構造・共通方針・設計上の制約の参照と変更 | [アーキテクチャ](docs/architecture.md)、[全体設計と先行してよい成果物](docs/standards/design-and-documentation.md#architecture-method) |
| 対象機能の設計・実装・レビュー | 対象ユースケースから参照する `docs/design/UCP-n.md`。必要な設計だけを読む |
| データ操作・保存設計の参照と変更 | `docs/design/data.md` の関連する定義・制約と対象の実現パターン |
| 層・抽象化・依存関係などの追加 | [仕組みの追加基準](docs/standards/design-and-documentation.md#design-decisions) |
| 系列の追加・変更、次の系列やユースケースへ進む判断 | [適用範囲](docs/document-policy.md#mock-scope)、[モック駆動開発の標準](docs/standards/mock-driven-development.md#workflow)、[ユースケース一覧](docs/project.md#usecases) から参照する本文と受け入れ条件 |
| 文書の作成・変更・移動・削除 | [文書と記録の基準](docs/standards/design-and-documentation.md#document-roles) |
| 導入、規約・標準・文書方針の改訂 | [文書方針](docs/document-policy.md)、[標準の扱い](docs/standards/design-and-documentation.md) |

## 作業原則

- **ユースケースの検討**: 新規・変更とも、案の全文と論点をメッセージ本文で提示して停止し、利用者と議論します。修正時も更新案の全文を提示し、利用者が議論の完了と内容を明示的に確認するまで、ユースケース本文・一覧・関連設計の新規作成・更新・下書き保存は行いません。要約やリンクのみで確認を求めたり、検討依頼や修正指示だけを書き込み許可とみなしたりしません。詳細は [モック標準の提示と保存](docs/standards/mock-driven-development.md#discussion) に従います。
- **テストコード**: 追加・更新の時点と既存テストの維持は [設計・実装の原則](docs/standards/design-and-documentation.md#implementation-principles) に従います。
- **画面確認の準備と依頼**: 段階3・5で利用者に動作確認を依頼する前に、アプリケーションを起動し、依頼対象の手順を自動実行して（Web UI では Playwright CLI）、想定どおり動作することを確認します。事前確認が失敗した状態で依頼せず、依頼文に確認目的、簡潔な操作手順、期待結果、対象画面の URL を記載します。
- **停止点**: 人の確認を待つ停止点は、全体設計の合意、系列ごとの段階1（記述確認）・段階3（動作合意）・段階5（完成系監査）、およびテーブル設計の合意（段階4開始前）です。段階5で承認を得るまで段階6の E2E テスト実装には着手しません。UI 確認を省略しても、必要なテーブル設計の合意は省略しません。停止点では作業を中断して会話で応答を待ち、確定した仕様だけを正本へ反映します。質問は未確定事項に絞り、会話で確認できる合意済み事項の再確認は行いません（合意待ち中の許容作業は [モック標準第2節](docs/standards/mock-driven-development.md#workflow) 参照）。
- **スコープの遵守**: 依頼範囲に必要な作業のみを進め、推測による機能追加や無関係なリファクタリングは行いません。調査・評価の依頼では所見を成果物とし、実装は変更しません。
- **文書管理**: 配布元管理の本書・標準2件・`scripts/doc_check.py` は採用先で改変せず、同じ固定コミットから一組で更新します。文書の更新・整理は [文書と記録の基準](docs/standards/design-and-documentation.md#document-roles) に従い、変更した事実の重複と古い説明を完了前に確認します。規約・標準・文書方針の改訂は実装作業から分離します。
- **完了基準と報告**: 完了前に必要なテストと `scripts/doc_check.py` を実行して会話で出力を報告し、[完了基準](docs/standards/design-and-documentation.md#completion) に照らして確認します。未実施の検証は報告に「未検証」と明記し、段階を進めません。エラー発生時は出力をそのまま提示します。
