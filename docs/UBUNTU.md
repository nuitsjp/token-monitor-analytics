# UbuntuでCollector＋Analyticsを常駐運用

Tailscale経由の閲覧と冪等な自動配置は[環境構築・発行タスク](PUBLICATION.md)の`provision:ubuntu`（管理者）と`publish:ubuntu`（通常ユーザー）を使います。以下はSSH転送を使う手動配置手順です。

systemdを利用できるUbuntuを対象にします。配布パッケージのAnalyticsは、miseの開発用Nodeではなく**システムにインストールしたNode.js 24 LTS**で起動します。unitの`ExecStart`は`/usr/bin/node`という絶対パスを使います。

systemd unitには`ProtectHome=true`が設定されています。`/home`配下はサービスから見えないため、miseの`~/.local/share/mise/installs/node/...`やnvmのNodeをサービスの実行Nodeに使えません。miseはWindows/Linuxの開発・パッケージ作成に使い、Ubuntuの常駐サービスには`/usr/bin/node`などのシステムパスに置いたNodeを使います。`/usr/local/bin/node`へ配置する場合は、初回配置後に下記のsystemd drop-inで実行パスを変更します。ホーム配下へのシンボリックリンクも使いません。

Ubuntuで初回配置する前に、NodeのパスとCPUアーキテクチャを確認します。

```bash
/usr/bin/node --version
command -v node
uname -m
```

シェルの`command -v node`だけではサービス用Nodeの確認になりません。実際にunitで使う絶対パスのNodeが24系であることを確認します。以下の`/usr/bin/node`は、別のシステムパスを選んだ場合はそのパスへ読み替えてください。Collectorは配布済みのLinux用Goバイナリーで動くため、Ubuntu側にGo、npm、TypeScriptコンパイラーは必要ありません。

## 1. パッケージを作成する

リポジトリーのルートで、miseを公式手順で導入してから設定を信頼し、固定ツールを取得します。WindowsのPowerShellとLinuxのBashで同じタスク名を使えます。シェルの`mise activate`は必要ありません。作成端末にはOSの`tar`も必要です（Windows標準の`tar.exe`、Ubuntuの`tar`）。mise導入とLinuxのraceテスト用Cコンパイラーの準備は[README](../README.md)を参照してください。

```text
mise trust
mise install
```

対象アーキテクチャに応じて、次のいずれかを実行します。

```text
# リリース用: setup → check → integration → パッケージ作成 → SHA-256
mise run release:ubuntu:amd64
mise run release:ubuntu:arm64

# パッケージ作成と内容検査だけを確認する場合（setup/check/integrationは実行しない）
mise run package:ubuntu:amd64
mise run package:ubuntu:arm64
```

`uname -m`が`x86_64`なら`amd64`、`aarch64`なら`arm64`を選びます。タスクは次の成果物を`dist/`へ作成します（amd64の例）。

```text
dist/tma-ubuntu-amd64.tar.gz
dist/tma-ubuntu-amd64.tar.gz.sha256
```

SHA-256ファイルは同じディレクトリーに置かれ、チェック行はアーカイブのファイル名を参照します。`package:*`はアーカイブ作成後にチェックサム、私有ファイル・旧Workerの混入、CollectorのLinux ELFターゲット、展開したAnalyticsのHTTP/SQLite起動を検査します。`release:*`は環境確認、Go/Nodeのテスト・型検査、結合試験がすべて成功した後にパッケージを作成します。いずれかの検査が失敗した場合、`release:*`はそこで停止します。`package:*`の成功は全テスト・結合試験の合格を意味しません。arm64バイナリー自体の実行試験も含みません。同名の成果物は再作成時に置き換わります。releaseの事前チェックが失敗した場合は既存成果物が残るため、以前のファイルを今回のリリース成功と取り違えないでください。

## 2. 転送してUbuntuでハッシュを検証する

作成したアーカイブと`.sha256`を、リポジトリールートからUbuntuの一時ディレクトリーへ転送します。`scp`の呼び出しはWindowsとLinuxで共通です。

```text
scp dist/tma-ubuntu-amd64.tar.gz USER@UBUNTU:/tmp/
scp dist/tma-ubuntu-amd64.tar.gz.sha256 USER@UBUNTU:/tmp/
```

Ubuntu上では展開前に検証します。

```bash
cd /tmp
sha256sum --check --strict tma-ubuntu-amd64.tar.gz.sha256
```

`tma-ubuntu-amd64.tar.gz: OK`を確認してから配置へ進みます。`FAILED`、`no properly formatted checksum lines found`、ファイル名の不一致が出た場合は展開せず、成果物と`.sha256`を同じリリースから再転送してください。arm64の場合はファイル名の`amd64`を`arm64`へ置き換えます。

## 3. Ubuntuへ初回配置する

初回配置ではサービスをまだ有効化していないため、停止・バックアップ操作は不要です。以下はamd64の例です。ハッシュ検証済みのアーカイブだけを使います。

```bash
(
set -euo pipefail
TMA_RELEASE_ARCH=amd64
TMA_RELEASE_STAGE=$(mktemp -d /tmp/token-monitor-analytics.XXXXXX)
trap 'rm -rf "$TMA_RELEASE_STAGE"' EXIT
tar -xzf "/tmp/tma-ubuntu-${TMA_RELEASE_ARCH}.tar.gz" -C "$TMA_RELEASE_STAGE"

id tma-analytics >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/tma-analytics --shell /usr/sbin/nologin tma-analytics
id tma-collector >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/tma-collector --shell /usr/sbin/nologin tma-collector

sudo install -d -m 0755 /opt/token-monitor-analytics/analytics
sudo cp -R "$TMA_RELEASE_STAGE/analytics/." /opt/token-monitor-analytics/analytics/
sudo chmod -R a+rX /opt/token-monitor-analytics/analytics
sudo install -m 0755 "$TMA_RELEASE_STAGE/tma-collector" /opt/token-monitor-analytics/tma-collector

sudo install -d -m 0755 /etc/token-monitor-analytics
sudo install -d -m 0700 -o tma-analytics -g tma-analytics /var/lib/tma-analytics
sudo install -d -m 0700 -o tma-analytics -g tma-analytics /var/lib/tma-analytics/backups
sudo install -d -m 0700 -o tma-collector -g tma-collector /var/lib/tma-collector
sudo install -d -m 0700 -o tma-collector -g tma-collector /var/lib/tma-collector/outbox

# 次の4ファイルは初回だけ配置する。更新時は既存ファイルを上書きしない。
sudo install -m 0640 -o root -g tma-analytics "$TMA_RELEASE_STAGE/deploy/analytics.ubuntu.json" /etc/token-monitor-analytics/analytics.json
sudo install -m 0640 -o root -g tma-collector "$TMA_RELEASE_STAGE/deploy/collector.ubuntu.json" /etc/token-monitor-analytics/collector.json
sudo install -m 0600 -o root -g root "$TMA_RELEASE_STAGE/deploy/analytics.env.example" /etc/token-monitor-analytics/analytics.env
sudo install -m 0600 -o root -g root "$TMA_RELEASE_STAGE/deploy/collector.env.example" /etc/token-monitor-analytics/collector.env

sudo install -m 0644 "$TMA_RELEASE_STAGE/deploy/tma-analytics.service" /etc/systemd/system/tma-analytics.service
sudo install -m 0644 "$TMA_RELEASE_STAGE/deploy/tma-collector.service" /etc/systemd/system/tma-collector.service
)
```

`/usr/bin/node`以外を使う場合は、unit配置後に`sudo systemctl edit tma-analytics.service`で次のdrop-inを保存します（例は`/usr/local/bin/node`）。この上書き設定はunit本体の更新後も保持されます。

```ini
[Service]
ExecStart=
ExecStart=/usr/local/bin/node --experimental-strip-types /opt/token-monitor-analytics/analytics/runtime/server.mjs --config /etc/token-monitor-analytics/analytics.json
```

初回配置後に、`/etc/token-monitor-analytics`の設定と認証を編集します。

## 4. 設定と認証を編集する

```bash
sudoedit /etc/token-monitor-analytics/analytics.json
sudoedit /etc/token-monitor-analytics/collector.json
sudoedit /etc/token-monitor-analytics/analytics.env
sudoedit /etc/token-monitor-analytics/collector.env
```

- `collector.json`: HubのURL。`analytics_url`は`http://127.0.0.1:8787`を維持します。Hubが1つならHub Bを削除します。
- `analytics.json`: `collector.json`と同じHub ID、必要な契約定義、タイムゾーンを設定します。最初は`contracts: []`で受信・保存を確認できます。
- `analytics.env`: `TMA_INGEST_TOKEN`、閲覧用の`TMA_VIEWER_USER`、`TMA_VIEWER_PASSWORD`を設定します。
- `collector.env`: `analytics.env`と**同じ**`TMA_INGEST_TOKEN`、Hub A/Bそれぞれの共有シークレットを設定します。閲覧パスワードは設定しません。

ランダム値はシステムNodeの絶対パスで生成します。出力をログやリポジトリーへ保存しないでください。

```bash
/usr/bin/node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

送信トークンと閲覧パスワードは別々に生成します。送信トークンは32文字以上、閲覧パスワードは16文字以上にします。`REPLACE_`で始まる例示値は使用しません。EnvironmentFileはシェルスクリプトではないため、`export`やコマンド置換を書かないでください。Hub Secretに特殊文字がある場合はsystemdのEnvironmentFileの引用規則に従います。[S7](SOURCES.md)

## 5. 初回起動と確認

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tma-analytics.service tma-collector.service
sudo systemctl status tma-analytics.service tma-collector.service --no-pager
sudo journalctl -u tma-analytics.service -u tma-collector.service -n 80 --no-pager
curl -fsS http://127.0.0.1:8787/api/health
```

ログの`Analytics ready`、Collectorの`SSE connected`と`uploaded`、`/api/health`の成功を確認します。Nodeの実行パス、設定、認証に問題があれば修正してから再起動します。短時間に起動失敗を繰り返してstart-limitへ到達した場合は、修正後に次を実行します。

```bash
sudo systemctl reset-failed tma-analytics.service tma-collector.service
sudo systemctl restart tma-analytics.service tma-collector.service
```

Collector unitはAnalytics起動後に起動を試みますが、**Analyticsの実際の起動完了を依存関係だけでは保証しません**。一時的な接続失敗はoutboxと再試行で処理します。Analyticsが停止してもCollectorを連動停止させる`Requires`/`PartOf`は設けていません。

## 6. Windowsから閲覧する

WindowsでローカルAnalyticsを停止し、SSH転送を開始します。

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8787:127.0.0.1:8787 USER@UBUNTU
```

`http://127.0.0.1:8787`を開き、閲覧用認証を入力します。SSHサーバーがポート転送を許可している必要があります。SSHを閉じてもUbuntuの2サービスは動き続けます。[S8](SOURCES.md)

初期設定では`http://UBUNTU_IP:8787`からアクセスできません。Analyticsはloopbackだけへbindします。LANへ直接開放する前に[SECURITY](SECURITY.md)を確認してください。

## 7. 更新する

更新では、設定・環境ファイル・SQLite DB・Collectorのoutboxを保持します。停止前にバックアップを採ると実行中のDBを整合したコピーにできますが、コード交換のための更新手順では**サービス停止後にバックアップを採る順序**に統一します。これにより、バックアップ完了後に古いプロセスが書き込むことがありません。

ハッシュ検証済みの新しいアーカイブを`/tmp`へ置いた状態で、次を実行します。

```bash
(
set -euo pipefail
TMA_RELEASE_ARCH=amd64
TMA_RELEASE_STAMP=$(date +%Y%m%d-%H%M%S)
sudo systemctl stop tma-collector.service
sudo systemctl stop tma-analytics.service

# 停止後に、更新前のSQLiteをバックアップする。
sudo install -d -m 0700 -o tma-analytics -g tma-analytics /var/lib/tma-analytics/backups
sudo -u tma-analytics /usr/bin/node --experimental-strip-types \
  /opt/token-monitor-analytics/analytics/runtime/backup.mjs \
  --config /etc/token-monitor-analytics/analytics.json \
  --output "/var/lib/tma-analytics/backups/analytics-${TMA_RELEASE_STAMP}.db"

TMA_RELEASE_STAGE=$(mktemp -d /tmp/token-monitor-analytics.XXXXXX)
trap 'rm -rf "$TMA_RELEASE_STAGE"' EXIT
tar -xzf "/tmp/tma-ubuntu-${TMA_RELEASE_ARCH}.tar.gz" -C "$TMA_RELEASE_STAGE"

# 旧コードを残し、新しいディレクトリーへ交換する（削除済みファイルを混在させない）。
sudo mv /opt/token-monitor-analytics/analytics "/opt/token-monitor-analytics/analytics.previous-${TMA_RELEASE_STAMP}"
sudo cp -p /opt/token-monitor-analytics/tma-collector "/opt/token-monitor-analytics/tma-collector.previous-${TMA_RELEASE_STAMP}"
sudo install -d -m 0755 /opt/token-monitor-analytics/analytics
sudo cp -R "$TMA_RELEASE_STAGE/analytics/." /opt/token-monitor-analytics/analytics/
sudo chmod -R a+rX /opt/token-monitor-analytics/analytics
sudo install -m 0755 "$TMA_RELEASE_STAGE/tma-collector" /opt/token-monitor-analytics/tma-collector

# unitは更新する。設定・env・DB・outboxはここではコピーしない。
sudo install -m 0644 "$TMA_RELEASE_STAGE/deploy/tma-analytics.service" /etc/systemd/system/tma-analytics.service
sudo install -m 0644 "$TMA_RELEASE_STAGE/deploy/tma-collector.service" /etc/systemd/system/tma-collector.service

sudo systemctl daemon-reload
sudo systemctl start tma-analytics.service
sudo systemctl start tma-collector.service
sudo systemctl status tma-analytics.service tma-collector.service --no-pager
sudo journalctl -u tma-analytics.service -u tma-collector.service -n 80 --no-pager
curl -fsS http://127.0.0.1:8787/api/health
)
```

途中で失敗した場合は後続の起動を行わず、原因を確認してください。保存した旧コードとDBバックアップは受入確認が終わるまで保持します。マイグレーション後のDBを旧コードでそのまま開けるとは限らないため、コードだけ戻す自動ロールバックは行いません。

`/etc/token-monitor-analytics/analytics.json`、`collector.json`、`analytics.env`、`collector.env`、`/var/lib/tma-analytics/analytics.db`、`/var/lib/tma-analytics/backups/`、`/var/lib/tma-collector/outbox/`は更新時に上書き・削除しません。`analytics/migrations`は起動時に適用されるため、適用済みSQLファイルを変更せず、新しいマイグレーションを追加します。起動後は初回と同じログ、ヘルス、Hub接続、送信状態を確認します。

## 8. 受入確認と範囲

この手順はUbuntu/systemd実機での受入試験を代替しません。停止・起動、OS再起動、24時間連続、実Hubの料金・利用率対応、バックアップからの復元は、利用者のUbuntuで実行して結果を記録してください。今回の作業ではリモートUbuntuへの`scp`、サービス操作、systemd常駐を実行していません。

`mise run package:ubuntu:*`でアーカイブとハッシュの作成だけを検証できても、Ubuntu上のサービス起動成功や実Hub接続成功とは記録しません。[S7](SOURCES.md)
