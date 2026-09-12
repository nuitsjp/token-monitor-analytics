# 文書方針 (Document Policy)

本プロジェクトでは、共通標準 `design-and-documentation`（版1）を採用します。本書は、文書の配置、適用範囲、保護すべき合意事項を定める正本です。

<a id="document-structure"></a>
## 1. 文書の役割と配置

各文書の正本と責務は以下のとおりです。決定事項の正本を一元化し、重複定義を避けます。

| ファイル | 正本とする内容 |
| --- | --- |
| [standards/design-and-documentation.md](standards/design-and-documentation.md) | プロジェクト横断で再利用する設計・文書作成の共通標準 |
| [standards/mock-driven-development.md](standards/mock-driven-development.md) | モック駆動開発の共通実施手順 |
| [document-policy.md](document-policy.md) | 採用標準、文書構造、必須ダイアグラム、初期設計の完了基準 |
| [design-policy.md](design-policy.md) | 製品目標、機能要件、制約事項、品質要求、完了条件 |
| [../doc/spec/functional-spec.md](../doc/spec/functional-spec.md) | 詳細な動作仕様、推定・表示・履歴の規則、S1〜S9 の期待結果と検証条件、機能ごとの合意記録 |
| [../doc/spec/interfaces.md](../doc/spec/interfaces.md) | Hub API の経路・取得項目・意味・制約、調査版と確認根拠 |
| [architecture.md](architecture.md) | システム境界、構造、識別・保存モデル、状態の更新責務、S1〜S9 の処理・保存・通知境界 |
| [mock-tooling.md](mock-tooling.md) | モック開発ツールの選定候補と運用ルール |
| [CONTEXT.md](../CONTEXT.md) | ドメイン用語の定義 |
| [PLAN.md](../PLAN.md) | 到達点、作業順序、未決・未検証事項、確定済み未実装機能 |
| [README.md](../README.md) | 製品概要、現在のステータス、計画機能、文書案内 |
| [AGENTS.md](../AGENTS.md) | エージェント作業時の正本参照マッピングと完了前チェック項目 |
| `docs/ard/0001-xxxxx.md` | 重大な設計判断を記録する ADR（4桁連番＋識別名） |

※ `old/` は退避済みの旧実装・データ等の保管先であり、現行の仕様・指示には適用しません。

※ `upstream/token-monitor/` は外部仕様の調査対象リポジトリであり、確認リビジョンと調査結果を連携仕様に記録します。

詳細仕様は `doc/spec/` に置きます。2026-09-13 の文書統合で、設計書にあった動作仕様と API の事実を上記2文書へ移しました。設計書には責務と保存境界を残し、動作仕様は参照します。同じ規則を複数の正本へ重複定義しません。未決事項の詳細と状況は PLAN.md に残します。

### アーキテクチャ設計書の章構成

設計書の構成は以下の9節とし、詳細仕様は `doc/spec/`、目標・制約は設計方針、用語は CONTEXT.md、未決事項は PLAN.md を参照します。

| 節 | 記載内容 |
| :---: | --- |
| 1 | 目標・制約への参照、合意済みスコープと到達点 |
| 2 | システム境界、C4 Context、Hub 連携仕様への参照 |
| 3 | アーキテクチャ解決方針 |
| 4 | C4 Container / Component、責務と依存関係 |
| 5 | 識別規則、比較基準の管理責務、保存モデル、状態管理、排他制御 |
| 6 | 重要実行時シナリオ（S1〜S9）の担当、保存・通知の確定点、未決の処理境界、機能仕様の動作・検証条件への参照 |
| 7 | システム配置と運用 |
| 8 | 設計判断と ADR 参照 |
| 9 | 品質確認、検証実績、未検証範囲とリスク |

<a id="mock-development"></a>
### モック駆動開発の統合

共通標準 `mock-driven-development`（版1）の既定適用は[提案中（U10）](../PLAN.md#u10)であり、ツール採否（[U11](../PLAN.md#u11)）とともに個別に判断します。個別の作業で明示指定された場合のみ適用します。

機能仕様は [機能仕様書 第4節](../doc/spec/functional-spec.md#scenarios) の S1〜S9 を正本とし、モックによる確認方法・画面合意・承認記録も該当シナリオへ集約します。設計書は同じ ID で処理責務を対応付けます。画面合意は、API 仕様確認や保存・障害設計、実機検証を代替するものではありません。

## 2. C4 モデルと必須ダイアグラム

[共通標準 第4節](standards/design-and-documentation.md#architecture-method) に従い、Mermaid で以下の3視点を定義します（Context 図と Container 図には認証境界を明示）。

- **Context 図**: 利用者、Analytics、外部 Hub 間の関係とシステム境界。
- **Container 図**: Node.js（Web・API）、ブラウザ、SQLite の実行・保存境界と通信。単一プロセス構成でも境界を明示する。
- **Component 図**: Node.js 内部の主要コンポーネントの責務と依存関係。

## 3. 設計の進め方

共通標準の手順に基づき、Hub API のデータ構造と取得値の調査事実を起点とします。Hub、端末、契約、利用枠、対象期間の対応関係を精査してコンポーネント責務を定めます。

各状態（Hub 接続、収集設定、データ保存、推定可否）は独立して管理し、重要シナリオ S1〜S9 における振る舞いと画面通知を明確化します。

<a id="initial-design-completion"></a>
## 4. 判断の記録と初期設計の完了基準

設計判断の理由説明（4点）および ADR 作成条件は [共通標準 第2・5節](standards/design-and-documentation.md#completion) に従います。

**初期設計の完了基準**:  
重要シナリオ S1〜S9 のすべてについて、機能仕様と設計書を合わせて [共通標準 第5節の5項目](standards/design-and-documentation.md#completion)（同一性判定、更新担当、結果確定と通知契機、異常時の停止・継続範囲、検証方法）を具体的に説明できる状態とします。未決事項に依存するシナリオが残る間は未完了とし、製品初期版の完了は [設計方針 第6節](design-policy.md#product-completion) で判定します。

<a id="protected-agreements"></a>
## 5. このプロジェクトで保護する合意

本書の文書構造、必須ダイアグラム、設計手順、完了基準、および設計方針の内容は、[共通標準 第6節](standards/design-and-documentation.md#agreement-changes) に基づき保護されます。採用版の変更、正本の分離方針、保護規則自体の改定を含め、明示的な合意なく変更・削除・緩和することはできません。
