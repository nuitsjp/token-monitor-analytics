# 文書方針 (Document Policy)

本書は、標準の採用記録、モック駆動開発の適用範囲、文書の配置、および保護すべき合意事項を定める正本です。

<a id="adoption"></a>
## 採用記録

導入状態: **適用済み**（2026-09-14、配布版 4 の試験適用）。

| 項目 | 内容 |
| --- | --- |
| 配布元・版 | [aidd-project-template](https://github.com/nuitsjp/aidd-project-template) / 版4 |
| 設計・文書標準 | [project-template-design-and-documentation / 版3](standards/design-and-documentation.md) |
| モック標準 | [project-template-mock-driven-development / 版3](standards/mock-driven-development.md) |
| 採用日・判断者・合意の根拠 | 2026-09-14。判断者: リポジトリ所有者。配布版 4 の試験適用先として本プロジェクトを選び、次のユースケース（Hub 管理）から適用する判断に基づく |
| プロジェクト固有の差分と理由 | 既存の文書体系（設計方針、機能仕様、連携仕様、設計書、CONTEXT.md）を維持し、`project.md` はユースケースと合意記録、合否表だけを持つ。実装済みのシナリオ S1〜S9 はユースケースへ遡及して書き直さない。設計書は既存の 9 節に第10節（実現パターン）を加える。`PLAN.md` は既存の節に「ユースケース進捗」と「再開情報」を加える。設計書は第5〜7節の詳細（識別・保存モデル、S1〜S9 の処理境界、運用手順）を `architecture/` 配下の 3 文書へ分け、`architecture.md` には要約と既存アンカーを残す。設計書 `architecture.md` の行数上限は標準の 200 行に代えて 300 行とする。理由: 必須の C4 図 3 本と実現パターンのシーケンス図（Mermaid 約 70 行）、保護する合意である第8節の決定表 D-1 以降を要約と同じ文書に置くため、要約後も約 240 行になる（2026-09-14 計測）。`scripts/doc_check.py` の判定 7 は標準の 200 行で報告し続けるので、設計書の行数はこの欄の上限で人が判定する |

`standards/` の本文は編集せず、固有の差分は上の表に理由付きで書きます。テンプレートの新版は自動適用しません。`scripts/doc_check.py` を変更ごとに実行し、出力を報告に含めます。

<a id="document-structure"></a>
## 1. 文書の役割と配置

各文書の正本と責務は以下のとおりです。決定事項の正本を一元化し、重複定義を避けます。

| ファイル | 正本とする内容 |
| --- | --- |
| [standards/design-and-documentation.md](standards/design-and-documentation.md) | 設計・文書作成の共通標準（配布元からの輸入物） |
| [standards/mock-driven-development.md](standards/mock-driven-development.md) | ユースケースごとの段階とゲート条件、仕掛かりの上限、モックの境界（配布元からの輸入物） |
| [document-policy.md](document-policy.md) | 採用記録、文書構造、必須ダイアグラム、初期設計の完了基準、保護する合意 |
| [design-policy.md](design-policy.md) | 製品目標、機能要件、制約事項、品質要求、完了条件 |
| [../doc/spec/functional-spec.md](../doc/spec/functional-spec.md) | 詳細な動作仕様、推定・表示・履歴の規則、S1〜S9 の期待結果と検証条件 |
| [../doc/spec/interfaces.md](../doc/spec/interfaces.md) | Hub API の経路・取得項目・制約、調査根拠 |
| [project.md](project.md) | ユースケースと合意記録、検証結果の合否表 |
| [architecture.md](architecture.md) | 全体設計の合意、システム境界、構造、識別・保存・状態管理と S1〜S9 の要約、配置、設計判断、品質確認、実現パターン |
| [architecture/crosscutting.md](architecture/crosscutting.md) | 設計書 第5節の詳細: 同一性の判定表、比較基準の管理、保存モデルと確定点、状態管理、排他制御と通知 |
| [architecture/runtime-view.md](architecture/runtime-view.md) | 設計書 第6節の詳細: S1〜S9 の処理境界、永続化トランザクション、通知契機 |
| [architecture/operations.md](architecture/operations.md) | 設計書 第7節の詳細: 設定ファイルの形、初期設定・起動・終了、別端末からの接続、状態確認と復旧、自動検証 |
| [reference/hub-private/README.md](reference/hub-private/README.md) | 実 Hub の取得済みサンプル、取得条件と確認範囲（外部システムの実測応答） |
| [CONTEXT.md](../CONTEXT.md) | ドメイン用語の定義 |
| [PLAN.md](../PLAN.md) | 現在地、作業順序、未決・未検証事項、ユースケース進捗、再開情報 |
| [README.md](../README.md) | 製品概要、現在のステータス、計画機能、文書案内 |
| [AGENTS.md](../AGENTS.md) | エージェント作業時の正本参照と作業原則 |
| [ard/0001-serial-processing-queue.md](ard/0001-serial-processing-queue.md) | 設計判断の表の1行では足りない決定の記録（ADR） |

※ `upstream/token-monitor/` は外部仕様の調査対象リポジトリ（git submodule）であり、確認リビジョンと調査結果は連携仕様に記録します。

- **新設の禁止**: 本表にない規約・方針・プロセス文書を新設しません。プロジェクト固有の規則は採用記録の差分欄、[設計方針](design-policy.md) の制約、または該当する実現パターンに書きます。
- **図の形式**: 図は Mermaid で書きます。システムコンテキストとコンテナは flowchart または C4 専用構文、系列は sequenceDiagram を使います。

動作仕様および API 仕様は `doc/spec/` を正本とし、設計書には責務と保存境界を記録します。同一規則の重複定義を避け、未決事項は PLAN.md で管理します。

### アーキテクチャ設計書の章構成

| 節 | 記載内容 |
| :---: | --- |
| 冒頭 | 全体設計の合意（提示コミット、対象節、利用者の応答の原文） |
| 1 | 目標・制約への参照、合意済みスコープと到達点 |
| 2 | システム境界、C4 Context、Hub 連携仕様への参照 |
| 3 | アーキテクチャ解決方針 |
| 4 | C4 Container / Component、責務と依存関係 |
| 5 | 識別規則、比較基準の管理責務、保存モデル、状態管理、排他制御 |
| 6 | 重要実行時シナリオ（S1〜S9）の担当、保存・通知の確定点、機能仕様の動作・検証条件への参照 |
| 7 | システム配置と運用 |
| 8 | 設計判断の決定表（ID、決定、根拠とした事実と出所、影響する範囲）と ADR 参照 |
| 9 | 品質確認の現状、未検証範囲とリスク |
| 10 | 実現パターン（役割表、シーケンス図、整合性、モック境界） |

第5〜7節は要約と既存のアンカーを設計書に置き、詳細は `architecture/` 配下の対応する文書を正本とします。

<a id="mock-development"></a>
<a id="mock-scope"></a>
### モック駆動開発の適用範囲

ユースケースの主成功系列または拡張系列を新設・変更する作業は対象です。ユースケースの文面を変えない作業（確定済み仕様の不具合修正、振る舞いを変えない内部変更、文書修正）と、実装済みのシナリオ S1〜S9 に対する変更は対象外です。各ユースケースの適用可否は [project.md 第3節](project.md#usecases) のカタログ表に記します。モックの境界は外部 Hub（`mock/hub.js`）で、合成点は `src/runtime.js` の起動モード分岐1箇所です。

## 2. C4 モデルと必須ダイアグラム

[共通標準 第4節](standards/design-and-documentation.md#architecture-method) に従い、Mermaid で以下の3視点を定義します（Context 図と Container 図には、初期版の Web は利用者認証なし、Hub 接続は共有シークレット認証であることを明示）。

- **Context 図**: 利用者、Analytics、外部 Hub 間の関係とシステム境界。
- **Container 図**: Node.js（Web・API）、ブラウザ、SQLite の実行・保存境界と通信。単一プロセス構成でも境界を明示する。
- **Component 図**: Node.js 内部の主要コンポーネントの責務と依存関係。

## 3. 設計の進め方

Hub API のデータ構造と取得値の調査事実を起点とし、各状態（Hub 接続、収集設定、データ保存、推定可否）は独立して管理します。新しいユースケースは [モック標準 第2節](standards/mock-driven-development.md#workflow) の段階で進め、全体設計の合意欄が埋まるまで実処理接続に入りません。

<a id="initial-design-completion"></a>
## 4. 判断の記録と初期設計の完了基準

設計判断は設計書 第8節の決定表に出所付きで記録し、ADR は表の1行で足りない場合のみ作成します（[共通標準 第5節](standards/design-and-documentation.md#completion)）。

**初期設計の完了基準**: 初期版の重要シナリオ S1〜S9 のすべてについて、機能仕様と設計書を合わせて同一性判定、更新担当、結果確定と通知契機、異常時の停止・継続範囲、検証方法を具体的に説明できる状態とします。製品初期版の完了は [設計方針 第6節](design-policy.md#product-completion) で判定します。後続の利用者認証（[U12](../PLAN.md#u12)）は初期版の完了条件に含めません。

<a id="protected-agreements"></a>
## 5. このプロジェクトで保護する合意

本書の文書構造、必須ダイアグラム、設計手順、完了基準、設計方針の内容、[設計書](architecture.md) の全体設計の合意欄と第8節の設計判断 ID、および [project.md](project.md) の合意記録は、[共通標準 第6節](standards/design-and-documentation.md#agreement-changes) に基づき保護されます。採用版の変更、正本の分離方針、保護規則自体の改定を含め、明示的な合意なく変更・削除・緩和することはできません。設計判断は、実装の破棄や文書の再編でも削除しません。
