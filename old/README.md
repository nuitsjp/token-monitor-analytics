# 旧実装と旧文書

2026-09-13 に、実装を元の相対パスを維持してここへ退避した。以前の `docs/old/` は、このディレクトリの `docs/` へ移した。現行の設計文書はリポジトリ直下の [docs/](../docs/architecture.md) を参照する。

```text
old/
├─ src/
├─ public/
├─ mock/
├─ tests/
├─ .github/workflows/ci.yml
├─ package.json
├─ package-lock.json
├─ mise.toml
├─ .env.example
└─ docs/
   ├─ architecture.md
   ├─ design-policy.md
   ├─ document-policy.md
   ├─ architecture-process.md
   ├─ functional-design.md
   ├─ requirements.md
   ├─ reference/
   └─ root/
```

ローカルの `.env`、`data/`、`node_modules/`、`.playwright-cli/` も同じ相対位置へ移動した。これらは引き続き Git の追跡対象外である。保存済み DB は初期化・削除していない。退避に先立ち稼働中の旧 Analytics を停止した。

旧実装を手動で起動・検証する場合は、この `old/` を作業ディレクトリとする。[旧起動手順](docs/root/README.md)にある「リポジトリのルート」は `old/` と読み替える。退避した CI は履歴資料であり、GitHub Actions の実行対象ではない。

旧文書の本文は保存したままであり、元の配置に依存する相対リンクや過去の作業指示は変更していない。このディレクトリを現在の仕様や開発の正本として扱わない。
