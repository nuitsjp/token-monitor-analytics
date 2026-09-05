# Token Monitor Analytics

**API金額換算の利用額とサブスクリプション利用枠の参考推定を継続保存するWebアプリ。**

**0.3.0 / self-hosted first / 2026-09-05**。前回の0.2.0 Web＋Ubuntu版を修正したリポジトリーです。**初期運用はUbuntu上にCollectorとAnalyticsを同居。開発中はWindows上に両方を起動**します。デスクトップGUIではありません。

## 今回の構成

```text
Cloudflare Hub A ──SSE──┐
Cloudflare Hub B ──SSE──┤
                       ▼
             Windows（開発）/ Ubuntu（運用）
             ┌──────────────────────────────────┐
             │ Go Collector                     │
             │   ├─ 複数Hub購読・再接続          │
             │   └─ 未送信outbox                 │
             │          │ HTTP POST / loopback  │
             │          ▼                       │
             │ Analytics / Node.js              │
             │   ├─ SQLite：観測・推定の正本     │
             │   ├─ Web画面 / 閲覧API            │
             │   └─ SSE：ブラウザーへ更新通知    │
             └────────────────┬─────────────────┘
                              ▼
                         Webブラウザー
```

**Hubは既存Cloudflare環境のまま**です。Analytics用のCloudflareアカウント、Worker、D1、Durable Objects、Wrangler、Accessは不要になりました。React、Docker、DBサーバー、Redisも追加していません。

CollectorはGo標準ライブラリーのみ。Analyticsは既存のTypeScript推定処理を残し、Node.js組込みのHTTP・SQLite・TypeScript実行を使います。**Analyticsは事前ビルドもnpm installもせず起動できます**。npmパッケージは型検査用のTypeScriptだけです。[S1][S2]

## 1. Windowsでローカルデモを確認

前回の3プロセスはCtrl+Cで停止し、**新しいフォルダーへ展開**してください。同じ8787/8765ポートを使うため、旧版と同時起動しません。既存フォルダーの`.wrangler`や設定を削除する必要はありません。

必要なものは**PowerShell 7、Go、Node.js 24 LTSの最新パッチ**です。Goは保守中のパッチを使ってください。コードの最低要件はGo 1.23、Node.js 22.16です。Node 22.16では型除去/SQLiteのexperimental警告が出ます。運用はNode 24 LTSを基準にしてください。[S1][S2][S5][S9]

展開後のリポジトリールートで:

```powershell
cd C:\src\token-monitor-analytics
.\scripts\bootstrap.ps1
```

3つのPowerShellを同じフォルダーで開きます。

**ターミナルA — 模擬Hub**

```powershell
.\scripts\run-mock.ps1
```

**ターミナルB — Analytics**

```powershell
.\scripts\run-analytics.ps1 -Demo
```

**ターミナルC — Collector**

```powershell
.\scripts\run-collector.ps1 -Demo
```

ブラウザーで **http://127.0.0.1:8787** を開きます。前回と同じ3画面・利用額・日次履歴・ライブ更新が利用できます。模擬Hubは3秒ごとに合成値を送信し、少数回の更新で期間枠`$160`、月換算`$695.70`という参考推定になります。Hub Bが未受信なのは、標準デモがHub Aだけを送るためです。

AnalyticsのデモDBは**`data/demo/analytics.db`**、Collectorの未送信データは**`data/demo-outbox/`**。以前のローカルD1（`.wrangler/`）とは別の保存先です。初回起動時にDBとテーブルを自動作成し、起動し直しても保存済みの履歴が残ります。

従来の`cd analytics; npm run dev`も使えます。今回はWranglerではなく、同じネイティブAnalyticsサーバーが起動します。

## 2. Windows上で実Hubへ切り替える

デモの3プロセスを止め、リポジトリールートで設定を作成します。

```powershell
Copy-Item .\analytics\configs\analytics.example.json .\analytics\config.local.json
Copy-Item .\collector\configs\collector.example.json .\collector\config.local.json
```

`collector/config.local.json`の`hubs[].url`を実Hubのoriginへ変更します。**`analytics_url`は`http://127.0.0.1:8787`のまま**です。Hubが1つなら、Collector設定からHub Bを削除します。Analyticsの`hubs`のIDとCollectorのIDは一致させます。

本番用の共通送信トークンを1つ生成して安全に保管します（例: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`）。デモトークンは本番設定では拒否します。

**Analytics用PowerShell**:

```powershell
$env:TMA_INGEST_TOKEN = Read-Host -MaskInput 'Analytics送信用トークン'
.\scripts\run-analytics.ps1
```

**Collector用PowerShell**:

```powershell
$env:TMA_HUB_A_SECRET = Read-Host -MaskInput 'Hub A共有シークレット'
$env:TMA_HUB_B_SECRET = Read-Host -MaskInput 'Hub B共有シークレット（使用時のみ）'
$env:TMA_INGEST_TOKEN = Read-Host -MaskInput '同じAnalytics送信用トークン'
.\scripts\run-collector.ps1
```

`SSE connected`、`uploaded`、Web画面の最終観測時刻を確認します。デモと本番は別DBになり、同一DBへの混在も起動時に拒否します。例を指定位置へコピーした場合、本番DBは`data/local/analytics.db`です。相対パスは常に**設定ファイルの場所が基準**です。

## 3. 契約を紐付けて推定を有効にする

最初は`analytics/config.local.json`の`contracts: []`で受信・保存を確認できます。Connections画面のaccountKey / deviceId / clientIdを使い、[契約設定例](docs/contract.example.json)を`contracts`配列へ追加してください。

対象device/clientの金額がその契約だけに過不足なく対応する場合に限り、`attributionConfirmed: true`にします。設定変更後は**Analyticsだけ再起動**します。設定にHub IDを追加する場合は、Analyticsを先に再起動してからCollectorを変更します。

計算式・null/0・欠測の扱いは[推定仕様](docs/ESTIMATION.md)。金額はToken Monitorの算出額を使用し、Analytics側でモデル単価から再計算しません。

## 4. UbuntuへCollectorとAnalyticsを移す

Windowsで運用用パッケージを作成します。

```powershell
.\scripts\package-ubuntu.ps1 -Architecture amd64
```

`dist/tma-ubuntu-amd64.tar.gz`が生成されます。Ubuntuで`uname -m`が`aarch64`なら`arm64`を選択します。パッケージに**ローカル設定・シークレット・DB・node_modulesは含めません**。

Ubuntuに必要な追加ランタイムは**Node.js 24 LTS**です。CollectorはLinux用Goバイナリーなので、Ubuntu上にGoの開発環境は不要です。Analyticsのnpm install/ビルドも不要です。2つのsystemd unit・初回配置・環境ファイルの手順は[Ubuntu導入](docs/UBUNTU.md)に記載しています。

配置・設定後:

```bash
sudo systemctl enable --now tma-analytics tma-collector
sudo systemctl status tma-analytics tma-collector --no-pager
sudo journalctl -u tma-analytics -u tma-collector -f
```

同じ実Hubを収集するWindows Collectorは切替前に停止します。Ubuntu側では両プロセスが独立して常駐し、Analytics停止中でもCollectorは受信済みデータをoutboxへ保留します。

## 5. WindowsのブラウザーからUbuntu版を閲覧

初期設定はUbuntuの`127.0.0.1:8787`だけで待ち受けます。まずはSSH転送を使用し、8787番を外部公開しません。[S8]

WindowsのローカルAnalyticsを止めて、次を開いたままにします。

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8787:127.0.0.1:8787 USER@UBUNTU
```

ブラウザーで`http://127.0.0.1:8787`へアクセスし、Ubuntuの`analytics.env`に設定した閲覧用ユーザー名・パスワードを入力します。**同じURLでも、今回はSSH経由でUbuntuの画面を見ています**。ブラウザー/SSHを閉じても、収集と保存はUbuntu上で続きます。

LAN/インターネットから直接公開する構成は初期設定に含めません。必要になった段階でHTTPSリバースプロキシ等を前置します。[公開と認証](docs/SECURITY.md)を参照してください。

## 6. テスト・型検査・バックアップ

```powershell
# Go/Node単体・ネイティブHTTP/SQLite/SSEテスト（npm install不要）
.\scripts\test.ps1

# 型検査も行う場合だけ、開発依存を取得
.\scripts\bootstrap.ps1 -InstallDevTools
.\scripts\test.ps1 -Typecheck

# 実Go Collectorを含む2 Hub結合・停止/復旧・バックアップ試験
node --experimental-strip-types .\tools\integration.mjs
```

Node.jsのTypeScript実行は型検査を行いません。変更後は型検査も実施してください。[S2]

SQLiteのオンラインバックアップ例:

```powershell
node --experimental-strip-types .\analytics\runtime\backup.mjs --config .\analytics\config.local.json --output .\backups\analytics-20260905.db
```

既存バックアップを上書きしません。稼働中の`.db`ファイルだけを単純コピーするのではなく、このコマンドを使います。[S1][S4] バックアップも私的な利用情報として保護してください。

## この版の範囲

履歴の正本はAnalyticsのSQLiteだけです。Collectorのoutboxとの双方向同期はしません。Hubの上流イベントは再送保証がないため、Ubuntu全体が停止していた間を復元できるとは扱いません。旧Cloudflare版データの自動移行、外部公開、クラウド版との切替機能、設定編集画面は今回含めません。

[変更履歴](CHANGELOG.md) / [旧版からの移行](docs/MIGRATION.md) / [構成](docs/ARCHITECTURE.md) / [運用](docs/OPERATIONS.md) / [検証結果](docs/VERIFICATION.md) / [一次資料](docs/SOURCES.md)
