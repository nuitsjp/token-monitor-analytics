# 開発・配置ツール

ルートの`.mise.toml`がNode.js 24.20.0を固定します。

```text
mise trust
mise install
mise run setup
```

`mise run check`はAnalyticsのnative HTTP/SQLite/SSEテスト、publication/provision/updateのテスト、TypeScript型検査を実行します。`mise run integration`はNode mock HubとAnalytics 1 listenerを使った実HTTP/SSE/SQLite結合試験を実行します。

## 配布

`tools/release.mjs`はAnalytics runtime、静的資産、migration、設定例、deployment unit、更新runnerを明示allowlistで選びます。秘密、DB、local config、env、開発依存、Hub submodule、旧構成は除外します。`tools/package-ubuntu.mjs`はarchive、release manifest、content hash、SHA-256 sidecarを作り、`tools/check-package.mjs`が展開後のファイル境界とHTTP/SQLite起動を検査します。

```text
mise run package:ubuntu:amd64
mise run package:ubuntu:arm64
mise run release:ubuntu:amd64
mise run release:ubuntu:arm64
```

## Ubuntu

- `provision:ubuntu`: sudoでNode、配置権限、Analytics常駐unit、更新oneshot、infrastructure recordを準備します。
- `configure:ubuntu`: 通常ユーザーでlistener、DB、Secret、閲覧認証、更新設定を準備します。Hub行は空のままです。
- `publish:ubuntu`: lock、candidate SHA、release identity、backup、配置、health/state/SSEを検査します。変更がない場合は再起動を省略します。
- `status:ubuntu`: infrastructure、Analytics、update oneshot、health、publication、update stateを表示します。

通常発行・通常起動・更新runnerは移行専用コードをimportしません。旧環境の停止、drain、backup、Hub reset、archiveは#27の`tools/migrate.mjs`と手順からだけ実行します。旧サービスが残っている場合、provisionは変更せず移行を要求します。

## 結合と性能

```text
node --experimental-strip-types tools/integration.mjs
node --experimental-strip-types tools/integration-manage.mjs
node --experimental-strip-types tools/integration-update.mjs
TMA_RUN_HISTORY_PERFORMANCE=1 node --experimental-strip-types --test tools/test/history-performance.test.mjs
```

性能試験は256端末×370日行を1つの同期SQLite transactionへ投入し、HTTP本文上限、transaction時間、同時health応答、終了時間を記録します。worker、別DB、transaction分割を追加して測定値を隠しません。未実行のWindows、Ubuntu、systemd、Tailscaleは成功と記載しません。
