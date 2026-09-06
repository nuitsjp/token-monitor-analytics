# Ubuntuの環境構築と通常ユーザーによる発行

Tailscaleに接続した端末からHTTPで閲覧します。Analyticsはloopbackの取込み用待受と、Tailscale IPv4だけの閲覧用待受を持ち、同じSQLiteとSSEを共有します。閲覧側の`/api/ingest`は遮断し、閲覧はTailscaleを認証境界とし、アプリのID・パスワードを要求しません。通信経路はTailscaleで暗号化されます。一般インターネットへの匿名公開ではありません。

| タスク | 権限・役割 |
| --- | --- |
| `provision:ubuntu` | sudoによる不足OS依存・Tailscale導入、配置権限、ユーザーsystemd定義、lingerの準備 |
| `configure:ubuntu` | 通常ユーザーによる接続先・Hub・認証設定 |
| `publish:ubuntu` | 通常ユーザーによるテスト・成果物作成・DBバックアップ・配置・サービス起動・疎通検証 |
| `status:ubuntu` | 読取り専用の構築・サービス・接続状態確認 |
| `release:ubuntu:*` | 配布アーカイブ作成のみ |

nginx・証明書・Tailscale Serveの設定は不要です。既存Jellyfin、Serve、デモサービスを変更しません。通常の発行ではsudoを呼びません。rootでの発行は拒否します。

## 新規Ubuntuからの準備

systemdが動くUbuntu amd64/arm64と通常ユーザーを用意し、このリポジトリーを取得して実行します。

```bash
bash scripts/bootstrap-ubuntu.sh
```

ブートストラップは不足時だけmiseを導入し、固定Node/Goを取得して`provision:ubuntu`へ移ります。既にmiseがある場合は次を実行できます。

```bash
mise run provision:ubuntu
```

このタスクはsudo認証を必要とします。既に満たした依存や同一内容のファイル配置はスキップし、アプリ本体は発行しません。Tailscale未認証の新規ホストでは、案内に従い`sudo tailscale up`でログインします。ユーザーを指定する場合は`TMA_DEPLOY_USER=ubuntu`を設定します。既存のシステム用アプリサービスや別所有者のデータがある場合は、自動移行せず停止します。

以前の`deploy/config.local.json`、`TMA_PUBLISH_CONFIG`は使用しません。構築時にアプリ設定JSONやHub Secretを要求しません。

## アプリ設定

以下は現在のCLI手順です。[Hub管理UIの実装計画](HUB_MANAGEMENT_PLAN.md)では、初回移行後のHub更新をAnalyticsに集約し、通常設定とSecretを別ファイルへ分離します。まだ移行機能はありません。計画のファイルを手作業で配置しても現行プログラムは読み込みません。

Hub Secretは`--hub-secret`引数で渡せます。タスクは値をログへ表示せず、`/var/lib/tma-deploy/config/collector.env`へ0600で保存します。同じ入力で再実行しても認証を再生成しません。引数は実行中のプロセス一覧から見える可能性があります。シェル履歴への値の保存とmiseのコマンド表示を避けるには、Bashで次のように入力します。

```bash
read -r -s -p 'Hub Secret: ' TMA_INPUT_SECRET
printf '\n'
mise --quiet run configure:ubuntu -- --hub-url https://YOUR-HUB.example --hub-id hub-a --hub-secret "$TMA_INPUT_SECRET"
unset TMA_INPUT_SECRET
```

既存の`--hub-secret-file /absolute/private/hub-secret`も利用できます。この場合は発行ユーザーだけが読める通常ファイル（0600）にSecretを保存してください。秘密値をGitやチャットへ貼りません。

URLは実HubのHTTPS originに置き換えます。複数Hubの場合は0600のJSONファイルに`[{"id":"hub-a","url":"https://YOUR-HUB.example","secretFile":"/absolute/private/hub-secret"}]`の形式で記載し、`--hubs-file /absolute/private/hubs.json`で渡します。

TailscaleのIPとDNS名を検出し、既定ポート8788を使います。変更には`--port 8789`などを指定します。取込みトークンは再実行時に保持します。閲覧モードは`tailscale`に揃えます。以前の閲覧資格情報がenvに残っていても使用しません。Hub未指定でもネットワーク・認証の準備を保存しますが、Hub設定が完成するまで非ゼロで終了します。Hubを差し替える場合、既存契約が参照するHubの削除は拒否します。

| 配置先 | 内容 |
| --- | --- |
| `/etc/token-monitor-analytics/infrastructure.json` | root所有の構築記録 |
| `/var/lib/tma-deploy/config` | 発行ユーザー所有の接続設定・JSON・env。ディレクトリー0700、ファイル0600 |
| `/opt/token-monitor-analytics` | 発行ユーザー所有の`releases/`・`current`・発行記録 |
| `/var/lib/tma-analytics` | 正式SQLiteとバックアップ、0700 |
| `/var/lib/tma-collector/outbox` | 正式outbox、0700 |
| `~/.config/systemd/user/tma-{analytics,collector}.service` | ユーザーサービス定義 |
| `/var/lib/tma-lock/deploy.lock` | 構築・設定・発行の共通排他ロック |

閲覧資格情報の入力は不要です。契約定義などは同じディレクトリーの`analytics.json`を編集します。デモDB・認証を流用しません。

## 発行と確認

```bash
mise run publish:ubuntu
mise run status:ubuntu
```

発行タスクは構築記録と設定を確認し、排他ロックの中でGo・Analytics・型検査・結合試験、ホストCPU向けアーカイブ作成を実行します。検査したアーカイブを展開し、固定Nodeもリリースへ格納します。

変更があればCollector→Analyticsの順で停止し、既存SQLiteをバックアップして内容ハッシュ付きリリースへ`current`を原子的に交換します。設定・DB・outboxを保持します。同一内容ならコード交換・バックアップ・稼働中アプリの再起動をスキップします。停止中サービスは復旧します。

active/enabled、正式DBモード、Tailscale DNS経由のHTTP、認証入力なしでの閲覧、閲覧側ingest遮断、SSEを確認して成功を記録します。失敗時は非ゼロで終了し、成功記録を更新しません。DB移行後のコードだけの自動ロールバックは行いません。

`status:ubuntu`は実際に疎通したURLだけをVerifiedとして表示します。このホストで発行・疎通確認済みのURLは`http://home-ubuntu.tail1bf795.ts.net:8788`です。別のTailscale端末での到達性と実Hubの受信も確認してください。OS再起動試験は別途実施し、linger/enable検査だけで再起動試験成功とは扱いません。

更新自動化は同じ発行ユーザーで`mise run publish:ubuntu`を実行します。各タスクはユーザーsystemdバスの環境変数を未設定時に補います。サービス定義変更やOS環境の修復時だけ`provision:ubuntu`を再実行します。
