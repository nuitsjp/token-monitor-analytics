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

## アプリ設定とHub管理

新規環境では次を実行します。Hub URL・SecretのCLI入力は不要です。Hub 0件の管理モードを初期化し、TailscaleのIP・DNSと既定ポート8788を設定します。

```bash
mise run configure:ubuntu
mise run publish:ubuntu
mise run status:ubuntu
```

発行後、表示されたURLの「Hubs」からHub ID・表示名・HTTPS origin・Secretを登録します。管理画面へ到達できる利用者は編集もできるため、Tailscaleの到達範囲は所有者の端末に制限してください。Secretはブラウザーへ再表示せず、通常設定とは別の0600ファイルへ平文で保存します。

既存のCLI登録を破棄して管理画面から登録し直す場合だけ、次を実行します。Hub情報の移行は行いません。

```bash
mise run configure:ubuntu -- --reset-hubs
mise run publish:ubuntu
mise run status:ubuntu
```

`--reset-hubs`はCollectorを停止し、既存Analyticsへ未送信outboxをPOSTして全件のACKを確認してからAnalyticsを停止します。ACKできない場合は登録・未ACKデータを保持して失敗します。Analyticsの可用性を復旧して再実行してください。契約設定がある場合は変更前に拒否します。契約の設定を別途整理してから再実行してください。

削除対象はHub登録とHub Secretです。SQLite履歴、ingest資格情報、送信済み以外のoutboxは消しません。設定完了後はサービスを停止したままにし、`publish:ubuntu`で新版を起動します。リセットを毎回実行しないでください。通常のconfigure/publishはUI登録を保持します。過去の履歴と別のHubを混同しないよう、新しい実体には新しいIDを指定します。

ポート変更は`configure:ubuntu -- --port 8789`で行います。管理モードでは従来のHub入力引数を拒否し、UI以外をHub設定のwriterにしません。旧形式のまま運用する既存環境のみ、旧CLI形式との互換を維持します。

| 配置先 | 内容 |
| --- | --- |
| `/etc/token-monitor-analytics/infrastructure.json` | root所有の構築記録 |
| `/var/lib/tma-deploy/config` | 発行ユーザー所有の接続設定・JSON・env。ディレクトリー0700、ファイル0600 |
| `/opt/token-monitor-analytics` | 発行ユーザー所有の`releases/`・`current`・発行記録 |
| `/var/lib/tma-analytics` | 正式SQLiteとバックアップ、0700 |
| `/var/lib/tma-collector/outbox` | 正式outbox、0700 |
| `~/.config/systemd/user/tma-{analytics,collector}.service` | ユーザーサービス定義 |
| `/var/lib/tma-lock/deploy.lock` | 構築・設定・発行の共通排他ロック |

閲覧資格情報の入力は不要です。契約定義は同じディレクトリーの`analytics.json`を編集します。デモDB・認証を流用しません。

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
