# 文書方針 (Document Policy)

本プロジェクトでは、共通標準 `design-and-documentation`（版1・全節）を採用します。本書は、文書の配置、適用範囲、および保護すべき合意事項を定める正本です。

<a id="document-structure"></a>
## 1. 文書の役割と配置

各文書の正本と責務は以下のとおりです。決定事項の正本を一元化し、重複定義を避けます。

| ファイル | 正本とする内容 |
| --- | --- |
| [standards/design-and-documentation.md](standards/design-and-documentation.md) | プロジェクト横断で再利用する設計・文書作成の共通ルール |
| [standards/mock-driven-development.md](standards/mock-driven-development.md) | モック駆動開発の共通実施手順（プロジェクトでの適用状態は後述） |
| [document-policy.md](document-policy.md) | 採用標準、文書構造、必須ダイアグラム、設計・完了基準 |
| [design-policy.md](design-policy.md) | 製品の目標、機能要件、制約事項、品質要求、変更境界、受け入れ条件 |
| [architecture.md](architecture.md) | API 連携仕様、システム構造、識別・状態・保存設計、シナリオ、検証条件 |
| [mock-tooling.md](mock-tooling.md) | モック開発用ツールの選定候補、導入状況、使用手順 |
| [CONTEXT.md](../CONTEXT.md) | ドメイン用語の定義（仕様や識別キーは設計書に記載） |
| [PLAN.md](../PLAN.md) | 到達点、作業順序、未決・未検証事項（根拠・影響・解消条件）、未実装機能 |
| [README.md](../README.md) | 製品概要、現在のステータス、主要機能、各種ドキュメントへの案内 |
| [AGENTS.md](../AGENTS.md) | エージェント作業時の正本参照マッピングと完了前チェック項目 |
| `docs/ard/0001-xxxxx.md` | 重大な設計判断を記録する ADR（4桁連番＋識別名） |

※ [old/](../old/README.md) は退避済みの旧実装・データ・旧文書の保管先であり、現行の仕様・指示には適用しません。  
※ `upstream/token-monitor/` は外部仕様の調査対象リポジトリであり、確認したリビジョンと調査結果を設計書に記録します。

### アーキテクチャ設計書の章構成

設計書の構成は以下の9節とし、目標・制約は設計方針、用語は CONTEXT.md、未決事項は PLAN.md を参照します。

| 節 | 記載内容 |
| :---: | --- |
| 1 | 目標・制約への参照、合意済みスコープと実装の到達点 |
| 2 | システム境界、C4 Context、Hub API の仕様と調査根拠 |
| 3 | アーキテクチャ解決方針 |
| 4 | C4 Container / Component、責務と依存関係 |
| 5 | 識別・推定・保存モデル、状態管理、排他制御とトランザクション |
| 6 | 重要実行時シナリオ（S1〜S9）の担当、確定点、状態遷移、検証条件 |
| 7 | システム配置と運用 |
| 8 | 設計判断と ADR 参照 |
| 9 | 品質確認、検証根拠、未検証範囲とリスク |

<a id="mock-development"></a>
### モック駆動開発の統合

共通標準 `mock-driven-development`（版1）の既定適用は[提案中（U10）](../PLAN.md#u10)であり、ツール採否（[U11](../PLAN.md#u11)）と併せて個別に判断します。個別の作業で明示的に選択された場合にのみ適用します。

機能仕様は設計書 第6節（S1〜S9）を正本とし、モックによる UI 合意を行う場合もシナリオ記述へ記録を追加します。モックによる画面合意は、API 仕様確認や保存・障害設計、実機検証を代替するものではありません。

## 2. C4 モデルと必須ダイアグラム

[共通標準 第4節](standards/design-and-documentation.md#architecture-method) に従い、Mermaid を用いて以下の3つの視点を定義します。

- **Context 図**: 利用者、Analytics、外部 Hub 間の関係とシステム境界。
- **Container 図**: Node.js（Web・API）、ブラウザ、SQLite の実行・保存境界と通信。単一プロセス構成でも境界を明示する。
- **Component 図**: Node.js 内部の主要コンポーネントの責務と依存関係。

※ Context および Container には認証境界を明示します。

## 3. 設計の進め方

共通標準の手順に基づき、Hub API のデータ構造と取得値の調査事実から進めます。Hub、端末、契約、利用枠、対象期間の対応関係を精査してコンポーネント責務を定めます。

Hub 接続、収集設定、データ保存、推定可否は独立した状態として管理し、S1〜S9（通常受信、補完、再接続、リセット、停止、保存失敗、再起動、認証・管理、手動更新）の各シナリオで振る舞いと画面通知を明確化します。

<a id="initial-design-completion"></a>
## 4. 判断の記録と初期設計の完了基準

設計判断の理由説明（4点）および ADR 作成条件は [共通標準 第2・5節](standards/design-and-documentation.md#completion) に従います。

**初期設計の完了基準**:  
重要シナリオ S1〜S9 のすべてについて、[共通標準 第5節の5項目](standards/design-and-documentation.md#completion)（同一性判定、更新担当、結果確定と通知の契機、異常時の停止・継続範囲、検証条件）を具体的に説明できることとします。未決事項に依存するシナリオが残る間は設計未完了として扱い、製品初期版の完了は [設計方針 第6節](design-policy.md#product-completion) で判断します。

<a id="protected-agreements"></a>
## 5. このプロジェクトで保護する合意

本書の文書構造、必須ダイアグラム、設計手順、完了基準、および設計方針の内容は、[共通標準 第6節](standards/design-and-documentation.md#agreement-changes) に基づき保護されます。採用版の変更、正本の分離方針、保護規則自体の改定も含め、明示的な合意なく変更・削除・緩和することはできません。

