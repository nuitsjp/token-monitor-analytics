# UbuntuでCollector＋Analyticsを常駐運用

systemdを利用できるUbuntuが対象。**Node.js 24 LTSの最新パッチをシステム上へ導入済み**であることを前提にします。標準APTのnodejsが古い場合、そのまま使用しません。公式配布は[SOURCES](SOURCES.md)のS5を参照してください。

```bash
node --version
command -v node
uname -m
```

unitは`/usr/bin/node`を想定。`/usr/local/bin/node`等へ配置した場合は、配置前に`deploy/tma-analytics.service`のExecStartを変更します。ホームディレクトリー内のnvm用Nodeは`ProtectHome=true`のサービスから利用できないので、システム用のパスへインストールしてください。

## 1. Windowsで運用パッケージを作り、転送

```powershell
.\scripts\package-ubuntu.ps1 -Architecture amd64
scp .\dist\tma-ubuntu-amd64.tar.gz USER@UBUNTU:/tmp/
```

Ubuntuがaarch64ならarm64を選びます。WindowsでGoバイナリーをクロスビルドし、Analyticsのソースと静的ファイルを同梱します。UbuntuにGo/npm/TypeScriptコンパイラーは不要です。

## 2. Ubuntuに配置（初回）

以下のファイル名はamd64の例です。既存版を更新する場合は先に両サービスを停止し、バックアップを作成してください。

```bash
STAGE=$(mktemp -d)
tar -xzf /tmp/tma-ubuntu-amd64.tar.gz -C "$STAGE"

id tma-analytics >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/tma-analytics --shell /usr/sbin/nologin tma-analytics
id tma-collector >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/tma-collector --shell /usr/sbin/nologin tma-collector

sudo install -d -m 0755 /opt/token-monitor-analytics/analytics
sudo cp -R "$STAGE/analytics/." /opt/token-monitor-analytics/analytics/
sudo chmod -R a+rX /opt/token-monitor-analytics/analytics
sudo install -m 0755 "$STAGE/tma-collector" /opt/token-monitor-analytics/tma-collector
sudo install -d -m 0755 /etc/token-monitor-analytics
sudo install -d -m 0700 -o tma-analytics -g tma-analytics /var/lib/tma-analytics
sudo install -d -m 0700 -o tma-collector -g tma-collector /var/lib/tma-collector

# 以下の4ファイルは初回だけ配置。更新時は既存設定を上書きしない。
sudo install -m 0640 -o root -g tma-analytics "$STAGE/deploy/analytics.ubuntu.json" /etc/token-monitor-analytics/analytics.json
sudo install -m 0640 -o root -g tma-collector "$STAGE/deploy/collector.ubuntu.json" /etc/token-monitor-analytics/collector.json
sudo install -m 0600 -o root -g root "$STAGE/deploy/analytics.env.example" /etc/token-monitor-analytics/analytics.env
sudo install -m 0600 -o root -g root "$STAGE/deploy/collector.env.example" /etc/token-monitor-analytics/collector.env

sudo install -m 0644 "$STAGE/deploy/tma-analytics.service" /etc/systemd/system/tma-analytics.service
sudo install -m 0644 "$STAGE/deploy/tma-collector.service" /etc/systemd/system/tma-collector.service
```

## 3. 設定と認証

```bash
sudoedit /etc/token-monitor-analytics/analytics.json
sudoedit /etc/token-monitor-analytics/collector.json
sudoedit /etc/token-monitor-analytics/analytics.env
sudoedit /etc/token-monitor-analytics/collector.env
```

- `collector.json`: HubのURL。`analytics_url`は`http://127.0.0.1:8787`を維持。Hubが1つならHub Bを削除。
- `analytics.json`: 同じHub ID、必要な契約定義、タイムゾーン。最初は`contracts: []`でよい。
- `analytics.env`: `TMA_INGEST_TOKEN`、閲覧用`TMA_VIEWER_USER`、`TMA_VIEWER_PASSWORD`。
- `collector.env`: **同じ**`TMA_INGEST_TOKEN`、Hub A/Bそれぞれの共有シークレット。

ランダム値の生成例（出力は安全に保管し、公開しない）:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

送信トークンと閲覧パスワードは別々に生成します。送信トークンは32文字以上、閲覧パスワードは16文字以上。`REPLACE_`で始まる例示値は拒否します。EnvironmentFileはシェルスクリプトではないので`export`やコマンド置換を書かないでください。Hub Secretに特殊文字がある場合はsystemdのEnvironmentFileの引用規則に従います。[S7]

## 4. 起動

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tma-analytics tma-collector
sudo systemctl status tma-analytics tma-collector --no-pager
sudo journalctl -u tma-analytics -u tma-collector -n 80 --no-pager
curl -fsS http://127.0.0.1:8787/api/health
```

Analyticsの`Analytics ready`、Collectorの`SSE connected`と`uploaded`を確認。Nodeの実行パス、設定、認証に問題があれば修正して再起動してください。短時間に起動失敗を繰り返しstart-limitへ到達した場合は、修正後に`sudo systemctl reset-failed tma-analytics tma-collector`を実行します。

Collector unitはAnalytics起動後に起動を試みますが、**Analyticsの実際の起動完了を依存関係だけでは保証しません**。一時的な接続失敗はoutbox＋再試行で処理します。Analyticsが停止してもCollectorを連動停止させる`Requires`/`PartOf`は設けていません。

## 5. Windowsから閲覧

WindowsでローカルAnalyticsを止め、SSH転送を開始します。

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8787:127.0.0.1:8787 USER@UBUNTU
```

`http://127.0.0.1:8787`を開き、閲覧用認証を入力します。SSHサーバーがポート転送を許可している必要があります。SSHを閉じてもUbuntuの2サービスは動き続けます。[S8]

初期版は`http://UBUNTU_IP:8787`ではアクセスできません。これはloopbackだけへbindする意図した設定です。LANへ直接開放する前に[SECURITY](SECURITY.md)を確認してください。

## 6. バックアップと更新

```bash
sudo -u tma-analytics /usr/bin/node --experimental-strip-types \
  /opt/token-monitor-analytics/analytics/runtime/backup.mjs \
  --config /etc/token-monitor-analytics/analytics.json \
  --output /var/lib/tma-analytics/backups/analytics-$(date +%Y%m%d-%H%M%S).db
```

SQLiteバックアップAPIで稼働中のDBから整合したコピーを作成します。同じ名前は上書きしません。DBとバックアップは自動的に遠隔地へ複製されません。端末自体の故障に備えるには、このファイルを別媒体へ保管してください。[S1][S4]

コード更新は、バックアップ→`sudo systemctl stop tma-collector tma-analytics`→コード/バイナリー交換→`sudo systemctl start tma-analytics tma-collector`です。`/etc/token-monitor-analytics`、`/var/lib/tma-analytics`、`/var/lib/tma-collector`は上書き・削除しません。適用済みSQLファイルを変更するのではなく、新しいマイグレーションを追加します。

停止/起動、OS再起動、24時間連続、実Hubの料金・利用率対応は利用者の環境で受入確認してください。作成環境でsystemd常駐を実行済みという意味ではありません。
