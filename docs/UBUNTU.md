# Ubuntuへの導入

この手順はAnalytics単一アプリ構成を対象にします。Node.js 24.20.0の固定runtimeを配布物へ含め、UbuntuへGoやnpmを導入しません。systemd user serviceはAnalytics常駐と更新oneshotの2 unitです。

## 配布物の作成

作業ツリーを対象SHAへ固定し、LinuxまたはWindowsで次を実行します。

```text
mise trust
mise install
mise run setup
mise run check
mise run integration
mise run package:ubuntu:amd64
```

`aarch64` Ubuntuには`arm64`を選びます。packageの成功は配布物の内容・checksum・展開後HTTP/SQLite起動を示します。systemd、OS再起動、実Hub接続の成功は示しません。

## 管理者の構築

Ubuntuで配布物とリポジトリーを準備し、通常ユーザーを指定して実行します。

```text
mise run provision:ubuntu
```

このタスクだけがsudoを使います。固定Node、配置ディレクトリー、`tma-analytics.service`、`tma-update.service`、更新runner、user linger、root所有のinfrastructure recordを準備します。Analyticsだけをenableし、update unitはenable/startしません。旧unitや旧配置を検出した場合は、明示的な移行なしに停止・削除・上書きしません。

## 通常ユーザーの設定と発行

```text
mise run configure:ubuntu
mise run publish:ubuntu
mise run status:ubuntu
```

configureはloopbackまたは専用Tailscale addressを選び、`/var/lib/tma-deploy/config/analytics.json`、`analytics.env`、`hub-secrets.json`、空のSQLiteを作成します。Hubは登録せず、管理UIからURL・表示名・Secretを保存します。Tailscale modeでは指定IPがTailscale interfaceに存在しないと起動を拒否します。

publishは署名済みではなく対象SHAとcontent hashを明示的に検証する運用です。deployment lockを取得し、必要な場合だけ現在のAnalyticsを停止してSQLite backupを取り、`current`を切り替え、serviceを再起動します。設定、Hub行、Secret、DB、履歴、publication/update stateを保持します。同じcontentと設定なら再起動しません。

## listenerと閲覧

loopback modeはSSH転送を使います。

```text
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8787:127.0.0.1:8787 USER@UBUNTU
```

Basic modeでは`analytics.env`のviewer credentialを使います。Tailscale modeは専用Tailscale IPの1 listenerだけを使い、Tailscaleを閲覧認証境界とします。LAN wildcard、直接インターネット公開、別のingest socketを設定しません。

## service確認

```text
systemctl --user status tma-analytics.service --no-pager
systemctl --user is-enabled tma-analytics.service
systemctl --user is-enabled tma-update.service   # 常駐enableではないこと
journalctl --user -u tma-analytics.service -n 80 --no-pager
```

`/api/health`はlistenerの生存を確認します。Hubの接続状態、最終観測、履歴取得はWeb UIまたは`/api/state`で別に確認します。serviceの再起動やOS再起動は、実行結果とログを保存してから成功と記録します。

## バックアップと更新

```text
node --experimental-strip-types \
  /opt/token-monitor-analytics/current/analytics/runtime/backup.mjs \
  --config /var/lib/tma-deploy/config/analytics.json \
  --output /var/lib/tma-analytics/backups/analytics-YYYYMMDD.db
```

稼働中SQLiteの単純コピーは使いません。更新はWebまたは対応CLIからoneshot runnerを起動し、candidate SHA・配布物・設定・backup・停止・再起動・health/SSE復帰を検証します。初回の旧環境切替は[移行手順](MIGRATION.md)だけで行います。
