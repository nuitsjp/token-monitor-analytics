# リライト前の文書と調査資料

2026-09-12 の全面リライト開始時点で、`docs/` 配下の全15ファイルを、ディレクトリ構造と内容を維持してこの場所へ移動した。移動前後の SHA-256 が一致することを確認した。開始時のリポジトリのコミットは `6463019` である。

現在の仕様は [設計方針](../design-policy.md)、[アーキテクチャ設計書](../architecture.md)、[文書方針](../document-policy.md) を参照する。未決事項は [TODO.md](../../TODO.md) で管理する。

## 退避した文書

- [旧設計方針](design-policy.md)
- [旧文書方針](document-policy.md)
- [旧設計手法](architecture-process.md)
- [旧アーキテクチャ設計書](architecture.md)
- [旧機能要件](requirements.md)
- [旧機能詳細設計](functional-design.md)
- [Private Hub の取得資料](reference/hub-private/README.md)

ルートで更新する文書の変更前の内容も [CONTEXT.md](root/CONTEXT.md)、[PLAN.md](root/PLAN.md)、[README.md](root/README.md)、[AGENTS.md](root/AGENTS.md) に保存した。

原文を保存するため、退避文書内の相対リンクは変更していない。旧 `docs/` 内の文書から `../` で参照していたルートや上流リポジトリへのリンク、および `root/` 内のコピーの相対リンクは、移動前の配置を前提としている。これらの文書にある作業指示・計画・完了報告を現在の方針として適用しない。
