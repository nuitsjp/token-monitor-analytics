# Ubuntu常駐運用

前提はsystemdを利用できるUbuntuです。Dockerは使いません。WSLで動かす場合は、Windowsホストの停止/スリープやWSLの終了でCollectorも停止するため、24時間稼働の前提を別途確認してください。

## 1. Windowsでビルドして転送

```powershell
.\scripts\build-collector.ps1
scp .\bin\tma-collector-linux-amd64 USER@UBUNTU:/tmp/tma-collector
scp .\deploy\tma-collector.service USER@UBUNTU:/tmp/tma-collector.service
scp .\collector\configs\collector.example.json USER@UBUNTU:/tmp/collector.json
scp .\deploy\collector.env.example USER@UBUNTU:/tmp/collector.env
```

UbuntuがARM64なら`linux-arm64`を選びます。Go、npm、WranglerはUbuntuに不要です。Windows/Ubuntu両方で本番Collectorを同時起動しないでください。

## 2. Ubuntuでユーザーとディレクトリーを作成

```bash
sudo useradd --system --home-dir /var/lib/token-monitor-analytics --shell /usr/sbin/nologin tma-collector
sudo install -d -m 0755 /opt/token-monitor-analytics
sudo install -d -m 0750 -o root -g tma-collector /etc/token-monitor-analytics
sudo install -d -m 0700 -o tma-collector -g tma-collector /var/lib/token-monitor-analytics
sudo install -m 0755 /tmp/tma-collector /opt/token-monitor-analytics/tma-collector
sudo install -m 0640 -o root -g tma-collector /tmp/collector.json /etc/token-monitor-analytics/collector.json
sudo install -m 0600 -o root -g root /tmp/collector.env /etc/token-monitor-analytics/collector.env
sudo install -m 0644 /tmp/tma-collector.service /etc/systemd/system/tma-collector.service
```

すでに専用ユーザーがある場合、`useradd`は省略します。

## 3. 本番設定

```bash
sudoedit /etc/token-monitor-analytics/collector.json
sudoedit /etc/token-monitor-analytics/collector.env
```

JSONの`analytics_url`、`hubs[].url`を実際のHTTPS originへ変更し、`spool_dir`を必ず以下へ変更します。

```json
"spool_dir": "/var/lib/token-monitor-analytics/outbox"
```

`collector.env`へHub A/Bの共有シークレットとAnalyticsの送信トークンを入れます。systemdのEnvironmentFileはシェルスクリプトではないので`export`やコマンド置換を使いません。トークンに空白や特殊な引用符がある場合はsystemdのEnvironmentFile構文に従って引用してください。生成した英数字/hexの送信トークンならそのまま記述できます。[S7]

Hubが1つならJSONからHub Bを削除します。envに残った未使用の値は使われません。URLにsecretを付けないでください。

## 4. 起動と確認

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tma-collector
sudo systemctl status tma-collector --no-pager
sudo journalctl -u tma-collector -n 50 --no-pager
sudo journalctl -u tma-collector -f
```

`SSE connected`と`uploaded`を確認します。`pending_bytes`が増え続ける場合は送信先、認証、D1容量/上限を確認します。SSEのネットワーク切断は上限30秒＋jitterの待機で再接続します。通常の送信失敗はoutboxを維持して再試行します。

致命的な設定不整合、非再試行HTTPエラー、壊れたoutbox、ファイルI/Oエラーはプロセスを終了し、systemdが10秒後に再起動します。繰り返す場合はサービスを止めて原因を修正してください。満杯だけは受信側を待機し、送信側が残件を排出します。待機が長ければHub側SSE切断/欠測は起こり得ます。

## 5. 更新と停止

新しいバイナリーを転送してから、次の順序で交換します。

```bash
sudo systemctl stop tma-collector
sudo install -m 0755 /tmp/tma-collector /opt/token-monitor-analytics/tma-collector
sudo systemctl start tma-collector
```

JSON/envだけの変更は`sudo systemctl restart tma-collector`で読み直します。outboxは消さないでください。同じspoolディレクトリーを複数Collectorで共有してはいけません。

このunitの`StateDirectory`がデータディレクトリーを維持します。削除/アンインストール時に、未送信データがないことを確認してから手動でデータを消します。自動削除スクリプトは含めません。

## 6. 稼働前の確認

`timedatectl status`で時刻同期を確認します。外向きHTTPSとDNSが利用できればよく、待受ポートはありません。ネットワークプロキシが必要なら、サービスのEnvironmentFileへ標準`HTTPS_PROXY`/`NO_PROXY`を設定します。シークレットを含むURLや認証レスポンスをログへ出力しませんが、ログとoutboxも運用情報として保護します。
