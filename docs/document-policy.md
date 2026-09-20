# 文書方針

<a id="adoption"></a>
## 1. 採用記録

導入状態: 適用済み。判断者: リポジトリ所有者。採用日: 2026-09-20。

| 項目 | 内容 |
| --- | --- |
| 配布元・版 | aidd-project-template / 配布版17 / コミット `a60085b` |
| React拡張 | 0.1.0。同一チェックアウトの共通資材にReact差分とLICENSEを配置 |
| 設計・文書標準 | [版13](standards/design-and-documentation.md) 原文維持 |
| モック標準 | [版15](standards/mock-driven-development.md) 原文維持 |
| 適用範囲 | 現行実装・文書の全面置換、サンプル除去、起動可能な最小基盤の整備。製品要件・最初のユースケースの定義は対象外 |
| 固有差分 | メモ管理・デモ認証・サンプルのテーブルと試験を除去。製品テスト未作成のため、verifyは基盤テスト・Lint・文書・型・ビルドのみ。既存のHub実測資料は参考資料として保全 |
| 依存関係の差分 | npm auditで検出した脆弱性の修正としてFastify 5.12.5、静的配信プラグイン10.1.4、tRPC 11.19.0、Vite 7.3.6、Vitest 4.1.11を固定。サンプル専用のCookieプラグインは除去。詳細な依存版はpackage-lock.jsonが正本 |
| 合意の根拠 | 下記の依頼と、順序1〜3まで進める提案への承認 |

> 現在の実装や文章は一旦すべて破棄し、リンク先のreact-templateを適用して作り直します。

> OK。では進めてください

旧実装・文書は復元用ブランチ `codex/pre-react-rebuild-20260920`（`5573f7d`）で参照できます。旧仕様・旧合意とテンプレートのサンプル仕様を現行製品仕様へ継承しません。標準採用の置換は今回承認された範囲で行い、輸入標準本文への独自改変は行いません。

<a id="mock-scope"></a>
## 2. モック駆動開発の適用範囲

新設・変更する製品の系列へ適用します。今回の基盤整備は製品の系列ではありません。製品仕様、モック、テーブル設計、完成系の合意は未実施です。

<a id="sources"></a>
## 3. 文書の役割

| 正本 | 内容 |
| --- | --- |
| 本書 | 採用範囲・差分・合意の扱い |
| [project.md](project.md) | 目的、UC一覧、確認した事実、運用手順、検証結果 |
| [architecture.md](architecture.md) | 全体構造、実現パターン、テーブルと設計判断 |
| [architecture-react.md](architecture-react.md) | React基盤の責務とテスト分離 |
| usecases/UC-n.md | 確認後に保存する系列・受け入れ条件・合意記録 |
| standards/ | 輸入標準の原文 |
| reference/ | 外部システムの取得済み実測資料 |
| [../README.md](../README.md) | 起動と検証の案内 |
| [../AGENTS.md](../AGENTS.md) | AI作業規範 |

現在地はUC本文の合意・完成系監査記録と [検証結果](project.md#verification) から判断し、再開用の計画文書は設けません。

<a id="agreements"></a>
## 4. 保護する合意

本書の採用範囲と正本の責務、全体設計・系列・テーブル設計の合意を [変更手続き](standards/design-and-documentation.md#agreement-changes) に従って保護します。今回の基盤導入の承認を、未定義の製品仕様や全体設計の合意として扱いません。
