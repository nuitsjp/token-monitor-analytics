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

CollectorはGo標準ライブラリーのみ。Analyticsは既存のTypeScript推定処理を残し、Node.js組込みのHTTP・SQLite・TypeScript実行を使います。**Analyticsは事前ビルドなしで起動できます**。開発環境の`mise run setup`では、型検査用の固定依存だけを`npm ci`で取得します。[S1][S2]

## 1. miseで開発環境を作る

開発・検証の入口は、WindowsとLinuxで同じ`mise`タスクです。リポジトリーの`.mise.toml`がGo **1.26.8**とNode.js **24.20.0**を固定します。GoやNode.jsをOSへ別途インストールする必要はありません。`mise run`または`mise exec --`がタスクの実行時だけ固定版を有効にするため、PowerShellやBashへ`mise activate`を追加しなくても使えます。

まずmiseを公式手順で導入します。

Windows（PowerShell）では、公式に案内されているScoopまたはwingetを使います。

```powershell
# PowerShell 7が未導入の場合（新しいpwshを起動してから続ける）
winget install --id Microsoft.PowerShell --exact

# Scoopを使う場合
scoop install mise

# Scoopを使わない場合
winget install jdx.mise
```

Linux（Ubuntuを含む）では、公式の単体バイナリーを使います。`~/.local/bin`を現在のシェルのPATHへ追加する行も実行してください。

```bash
curl -fsSL https://mise.run | sh
export PATH="$HOME/.local/bin:$PATH"
mise --version
```

PowerShell 7は既存の`.ps1`ラッパーと`Read-Host -MaskInput`に必要です。`mise run`だけを使う場合でも、Windowsの開発手順はPowerShell 7で統一します。Linuxのmise 2026.9.1でこの手順を確認済みです。Windows実機では未検証のため、実行していない結果を成功とは記録しません。

公式のインストール方法は[mise Installing mise](https://mise.jdx.dev/installing-mise.html)、基本操作は[mise Getting Started](https://mise.jdx.dev/getting-started.html)、設定の信頼は[mise trust](https://mise.jdx.dev/cli/trust.html)、ツール取得は[mise install](https://mise.jdx.dev/cli/install.html)を参照してください。

リポジトリーのルートで、設定を信頼して固定ツールとNode依存を入れます。

```text
mise trust
mise install
mise run setup
```

`mise run setup`は、Go/Nodeの実行確認、組込みSQLiteの確認、`analytics/package-lock.json`に従った`npm ci`を行います。`mise install`は`.mise.toml`に記載されたツールの取得、`mise run setup`はこのリポジトリーの依存準備です。どちらも初回クローン時と、ツールのバージョンが変わったときに実行します。`package-lock.json`が変わった後も`mise run setup`を再実行してください。

Linuxで`mise run check`のRace Detectorを実行するにはCコンパイラーが必要です。Ubuntuでは一度だけ次を実行します。

```bash
sudo apt-get update
sudo apt-get install -y build-essential
```

Windowsではこのリポジトリーの共通チェックにRace Detectorを含めません。Windows実機・Linux実機のどちらも、実際にそのOSでタスクを実行した結果だけを成功として記録してください。

主なタスクは次のとおりです。

| コマンド | 内容 |
| --- | --- |
| `mise run setup` | ランタイム確認と`npm ci` |
| `mise run check` | Goのgofmt確認・テスト・vet、Analyticsのテスト・型検査。Linuxでは`go test -race`も実行 |
| `mise run integration` | 実Go Collector、模擬Hub、Node Analytics、SQLiteの結合試験 |
| `mise run demo:hub` | ループバックだけで動く模擬Hub |
| `mise run demo:analytics` | デモ設定のAnalytics |
| `mise run demo:collector` | デモ設定のCollector |

## 2. Windows/Linuxでローカルデモを確認

前回の3プロセスはCtrl+Cで停止し、**新しいフォルダーへ展開**してください。同じ8787/8765ポートを使うため、旧版と同時起動しません。既存フォルダーの`.wrangler`や設定を削除する必要はありません。

WindowsはPowerShell 7、LinuxはBashを使います。どちらも、前節の`mise run setup`をリポジトリールートで完了させてください。

3つのターミナルを同じリポジトリールートで開きます。以下のコマンドはWindowsとLinuxで共通です。

**ターミナルA — 模擬Hub**

```text
mise run demo:hub
```

**ターミナルB — Analytics**

```text
mise run demo:analytics
```

**ターミナルC — Collector**

```text
mise run demo:collector
```

ブラウザーで **http://127.0.0.1:8787** を開きます。前回と同じ3画面・利用額・日次履歴・ライブ更新が利用できます。模擬Hubは3秒ごとに合成値を送信し、少数回の更新で期間枠`$160`、月換算`$695.70`という参考推定になります。Hub Bが未受信なのは、標準デモがHub Aだけを送るためです。

AnalyticsのデモDBは**`data/demo/analytics.db`**、Collectorの未送信データは**`data/demo-outbox/`**。以前のローカルD1（`.wrangler/`）とは別の保存先です。初回起動時にDBとテーブルを自動作成し、起動し直しても保存済みの履歴が残ります。

従来のスクリプトを使う場合も、固定版ランタイムを明示するため`mise exec --`を付けます。Windowsでは`mise exec -- pwsh -File .\scripts\run-analytics.ps1 -Demo`、Linuxでは`mise exec -- bash scripts/run-analytics.sh --demo`のように実行してください。新しいデモでは上記の`mise run demo:*`を使います。

## 3. Windows上で実Hubへ切り替える

デモの3プロセスを止め、リポジトリールートで設定を作成します。

```powershell
Copy-Item .\analytics\configs\analytics.example.json .\analytics\config.local.json
Copy-Item .\collector\configs\collector.example.json .\collector\config.local.json
```

`collector/config.local.json`の`hubs[].url`を実Hubのoriginへ変更します。**`analytics_url`は`http://127.0.0.1:8787`のまま**です。Hubが1つなら、Collector設定からHub Bを削除します。Analyticsの`hubs`のIDとCollectorのIDは一致させます。

本番用の共通送信トークンを1つ生成して安全に保管します（例: `mise exec -- node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`）。デモトークンは本番設定では拒否します。

**Analytics用PowerShell**:

```powershell
$env:TMA_INGEST_TOKEN = Read-Host -MaskInput 'Analytics送信用トークン'
mise exec -- pwsh -File .\scripts\run-analytics.ps1
```

**Collector用PowerShell**:

```powershell
$env:TMA_HUB_A_SECRET = Read-Host -MaskInput 'Hub A共有シークレット'
$env:TMA_HUB_B_SECRET = Read-Host -MaskInput 'Hub B共有シークレット（使用時のみ）'
$env:TMA_INGEST_TOKEN = Read-Host -MaskInput '同じAnalytics送信用トークン'
mise exec -- pwsh -File .\scripts\run-collector.ps1
```

`SSE connected`、`uploaded`、Web画面の最終観測時刻を確認します。デモと本番は別DBになり、同一DBへの混在も起動時に拒否します。例を指定位置へコピーした場合、本番DBは`data/local/analytics.db`です。相対パスは常に**設定ファイルの場所が基準**です。

## 4. 契約を紐付けて推定を有効にする

最初は`analytics/config.local.json`の`contracts: []`で受信・保存を確認できます。Connections画面のaccountKey / deviceId / clientIdを使い、[契約設定例](docs/contract.example.json)を`contracts`配列へ追加してください。

対象device/clientの金額がその契約だけに過不足なく対応する場合に限り、`attributionConfirmed: true`にします。設定変更後は**Analyticsだけ再起動**します。設定にHub IDを追加する場合は、Analyticsを先に再起動してからCollectorを変更します。

計算式・null/0・欠測の扱いは[推定仕様](docs/ESTIMATION.md)。金額はToken Monitorの算出額を使用し、Analytics側でモデル単価から再計算しません。

## 5. UbuntuへCollectorとAnalyticsを移す

Windows/Linux共通のリリースタスクで、セットアップ・全チェック・結合試験に成功してから運用用パッケージを作成します。

```powershell
mise run release:ubuntu:amd64
```

`dist/tma-ubuntu-amd64.tar.gz`と検証用の`.sha256`が生成されます。Ubuntuで`uname -m`が`aarch64`なら`arm64`を選択します。パッケージに**ローカル設定・シークレット・DB・node_modulesは含めません**。転送・初回配置・更新手順は[Ubuntu導入](docs/UBUNTU.md)を参照してください。パッケージ作成のみの動作確認には`mise run package:ubuntu:amd64`を使います。

Ubuntuに必要な追加ランタイムは**Node.js 24 LTS**です。CollectorはLinux用Goバイナリーなので、Ubuntu上にGoの開発環境は不要です。Analyticsのnpm install/ビルドも不要です。2つのsystemd unit・初回配置・環境ファイルの手順は[Ubuntu導入](docs/UBUNTU.md)に記載しています。

配置・設定後:

```bash
sudo systemctl enable --now tma-analytics tma-collector
sudo systemctl status tma-analytics tma-collector --no-pager
sudo journalctl -u tma-analytics -u tma-collector -f
```

同じ実Hubを収集するWindows Collectorは切替前に停止します。Ubuntu側では両プロセスが独立して常駐し、Analytics停止中でもCollectorは受信済みデータをoutboxへ保留します。

## 6. WindowsのブラウザーからUbuntu版を閲覧

初期設定はUbuntuの`127.0.0.1:8787`だけで待ち受けます。まずはSSH転送を使用し、8787番を外部公開しません。[S8]

WindowsのローカルAnalyticsを止めて、次を開いたままにします。

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8787:127.0.0.1:8787 USER@UBUNTU
```

ブラウザーで`http://127.0.0.1:8787`へアクセスし、Ubuntuの`analytics.env`に設定した閲覧用ユーザー名・パスワードを入力します。**同じURLでも、今回はSSH経由でUbuntuの画面を見ています**。ブラウザー/SSHを閉じても、収集と保存はUbuntu上で続きます。

LAN/インターネットから直接公開する構成は初期設定に含めません。必要になった段階でHTTPSリバースプロキシ等を前置します。[公開と認証](docs/SECURITY.md)を参照してください。

## 7. テスト・型検査・バックアップ

```text
# Go/Node単体・ネイティブHTTP/SQLite/SSEテストと型検査
mise run check

# 実Go Collectorを含む2 Hub結合・停止/復旧・バックアップ試験
mise run integration
```

`mise run check`はWindowsではGoの通常テスト・vet、LinuxではそれらにRace Detectorを加え、両OSでAnalyticsの`npm test`と`npm run typecheck`を実行します。Node.jsのTypeScript実行は型検査を行わないため、変更後はこのタスクを実施してください。[S2]

全チェックの結果を揃える場合は`mise run --continue-on-error check`を使います。

SQLiteのオンラインバックアップ例:

```powershell
mise exec -- node --experimental-strip-types .\analytics\runtime\backup.mjs --config .\analytics\config.local.json --output .\backups\analytics-20260905.db
```

既存バックアップを上書きしません。稼働中の`.db`ファイルだけを単純コピーするのではなく、このコマンドを使います。[S1][S4] バックアップも私的な利用情報として保護してください。

## この版の範囲

履歴の正本はAnalyticsのSQLiteだけです。Collectorのoutboxとの双方向同期はしません。Hubの上流イベントは再送保証がないため、Ubuntu全体が停止していた間を復元できるとは扱いません。旧Cloudflare版データの自動移行、外部公開、クラウド版との切替機能、設定編集画面は今回含めません。

[変更履歴](CHANGELOG.md) / [旧版からの移行](docs/MIGRATION.md) / [構成](docs/architecture.md) / [運用](docs/OPERATIONS.md) / [検証結果](docs/VERIFICATION.md) / [一次資料](docs/SOURCES.md)

## UbuntuのHTTPS公開と自動起動

`mise run provision:ubuntu`でOS・Tailscale・配置権限・ユーザーサービスとlingerを準備し、通常ユーザーが`mise run configure:ubuntu`で設定、`mise run publish:ubuntu`で発行します。Tailscale IPv4の閲覧専用HTTP待受を使います。発行はsudo不要で、設定・DB・outboxを保持します。同一内容の再発行ではコード交換や稼働中アプリの再起動を行いません。[環境構築・発行・自動化の手順](docs/PUBLICATION.md)を参照してください。
