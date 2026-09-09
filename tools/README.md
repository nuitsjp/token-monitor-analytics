# 開発・検証ツール

ランタイムは `.mise.toml` で Node.js 24.20.0 に固定します。初回はリポジトリー直下で次を実行します。

```text
mise trust
mise install
mise run setup
```

`mise run check` は Analytics の native HTTP/SQLite/SSE テスト、publication tools テスト、TypeScript 型検査を実行します。`mise run integration` は Node mock Hub と単一 Analytics listener の実 HTTP 検査を実行します。`demo:hub` と `demo:analytics` は本番 DB・Secret と分離したデモ用プロセスです。

`package:ubuntu:amd64` / `package:ubuntu:arm64` は、Collector や Hub submodule を含めない明示 allowlist から archive、content hash、SHA-256 sidecar、release manifest を作成し、展開後の実 HTTP/SQLite 起動を検査します。`release:ubuntu:*` は全チェック後に同じ検査を行います。

Ubuntu の導入は役割を分けます。

- `provision:ubuntu` は sudo で固定 Node、常駐 `tma-analytics.service`、更新時だけ動く `tma-update.service`、root 所有の構築記録を準備します。更新 unit は常駐有効化しません。
- `configure:ubuntu` は通常ユーザーで単一 listener、空の SQLite、mode 0600 の Hub Secret ファイルを準備します。Hub 行は UI と SQLite が正本です。
- `publish:ubuntu` は共通の検証済み archive API と deployment lock を使い、対象 SHA・content hash・起動設定を再確認してから停止、バックアップ、配置、health/state/SSE 検査を行います。同一 content/configuration の再発行は再起動しません。
- `status:ubuntu` は構築記録、Analytics unit、更新 oneshot、選択された listener を読み取り検査します。

`tools/reset-hubs.mjs`、旧 Collector service/config は一回限りの移行専用資産です。通常の package、configure、publish、CI では読み込みません。
