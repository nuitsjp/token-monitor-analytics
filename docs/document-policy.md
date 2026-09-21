# 文書方針

<a id="adoption"></a>
## 1. 適用する標準

導入状態: 適用済み。

| 項目 | 内容 |
| --- | --- |
| 配布元・版 | [aidd-project-template](https://github.com/nuitsjp/aidd-project-template) / 配布版21 |
| 採用元固定コミット | `19c8d289e98b7ff35abef9b91086bcf7220d7dd1` |
| 設計・文書標準 | [版16](standards/design-and-documentation.md) 原文維持 |
| モック標準 | [版19](standards/mock-driven-development.md) 原文維持 |
| React拡張 | 0.2.5。製品固有の実装を維持して、依存関係・Node.js指定・セットアップ・配布・検証設定の差分を適用 |
| 適用範囲 | 共通規則、設計・文書構成とReact基盤。製品の要件・系列・受け入れ条件は各正本で管理 |
| 固有差分 | メモ管理・デモ認証・サンプルのテーブルと試験は使用しない。Hub連携と閲覧の製品実装・テストを使用し、外部Hubの実測資料を保全する。CIはUbuntuで実行 |
| 依存関係の差分 | サンプル認証専用のCookieプラグインは使用しない。直接依存の版は `package.json`、解決済みの依存関係は `package-lock.json` が正本 |

配布元管理の `AGENTS.md`、標準2件、`scripts/doc_check.py` は同じ固定コミットから一組で更新します。その他の文書・実装・設定・依存定義とロック・DB移行は本プロジェクトで管理し、雛形の全文で上書きしません。テンプレートのサンプル仕様や旧製品の仕様を現行製品仕様へ暗黙的に継承しません。

<a id="mock-scope"></a>
## 2. モック駆動開発の適用範囲

新設・変更する製品の系列へ適用します。テンプレートと開発基盤の更新は製品の系列には含みません。UI確認の要否は [ユースケース本文](project.md#usecases)、現在のテーブル定義は [データ設計](design/data.md) を参照します。

<a id="sources"></a>
## 3. 文書の役割

| 正本 | 内容 |
| --- | --- |
| 本書 | 適用する標準、固有差分、文書の責務 |
| [project.md](project.md) | 目的、制約、UC一覧、確認した事実、実行・検証手順 |
| [architecture.md](architecture.md) | 全体構造、実現パターンの適用条件、設計上の制約 |
| `design/UCP-n.md` | 実現パターンごとの役割、実装パス、シーケンス、結果確定点、障害時の動作、モック境界 |
| [design/data.md](design/data.md) | 保存形式、テーブル定義、データ制約 |
| [architecture-react.md](architecture-react.md) | React・Node.js基盤の責務、起動単位、テスト分離 |
| usecases/UC-n.md | 現在の系列、UI確認の要否、受け入れ条件 |
| standards/ | 輸入標準の原文 |
| reference/ | 外部システムの取得済み実測資料 |
| [../README.md](../README.md) | プロジェクト概要と参照案内 |
| [../AGENTS.md](../AGENTS.md) | AI作業規範 |

既存の正本で扱える事項について管理文書を新設しません。自プロジェクトのログ・画像・試験DBは追跡しません。

<a id="agreements"></a>
## 4. 仕様変更の対象

適用する標準・固有差分・正本の責務と、現在の要件・制約・仕様・完了条件・データ設計を変更する場合は、[変更手続き](standards/design-and-documentation.md#agreement-changes) に従います。
