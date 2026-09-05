# Token Monitor Analytics

**AIサブスクリプションで実質どれくらいのAPI金額相当を利用できるか。その推定値の変化を記録するWebアプリです。**

Windowsで開発し、Go製CollectorをUbuntuで常駐運用します。AnalyticsのWeb画面・履歴保存・推定処理はCloudflareへ配置します。**デスクトップアプリではありません。Wails、WebView2、Dockerは使いません。**

> 0.2.0 starter / 2026-09-05。ソースコード一式です。実Cloudflareへのデプロイ・Windows/Ubuntu実機の受入試験は未実施です。実行した検証と未検証事項は [VERIFICATION](docs/VERIFICATION.md) に分けて記載しています。

## 構成

```text
Cloudflare Account A: Hub A ──SSE──┐
                                  ├─ Ubuntu: Go Collector（1プロセス）
Cloudflare Account B: Hub B ──SSE──┘         │ HTTPS POST
                                            ▼
Cloudflare Account C: Analytics Worker → LiveRoom → D1
                                            │
                                Hibernation WebSocket
                                            ▼
                                     Webブラウザー
```

Hubごとに1アカウント、Analyticsは別アカウントです。既存Hubは改変しません。LiveRoomは短い保存トランザクションを直列化し、閲覧中のブラウザーに更新を通知する1つのDurable Objectです。HubのSSEをCloudflare上から購読するObjectではありません。**履歴の正本はD1のみ**です。

## 含まれる実装

| 部分 | 初期実装 |
|---|---|
| Go Collector | 複数HubのSSE購読、Bearer認証、ハートビート監視、再接続、イベントの小型化 |
| 送信 | 最大2件/バッチ、通常は最大約2秒の送信待ち、ローカルファイルoutbox、確認応答後の削除 |
| Analytics | TypeScript Worker、D1マイグレーション、重複防止、順序逆転の保護 |
| 推定 | 対象アカウントと利用額を明示的に紐付け、同一リセット期間の差分から推定 |
| Web | Overview / Daily history / Connections、日次表・簡易グラフ、ライブ更新通知 |
| 認証 | 閲覧はCloudflare Access JWTを検証、Collector送信は独立したBearerトークン |
| Ubuntu | systemd unit、env例、クロスビルド手順 |
| 開発 | 模擬Hub、Goテスト、TypeScript/SQLiteテスト、CI |

モデル単価の管理・料金再計算、Hub間の自動名寄せ、AIサービスへの直接接続、設定編集画面、過去Hubイベントの再取得は実装しません。API換算額は**Token Monitorが算出した値**であり、実際の請求額とは区別します。

## 1. Windowsの開発環境

PowerShell 7、保守中のGo、Node.js LTS、Gitを用意してください。Goは**1.26系の最新パッチ**、Node.jsは**24系LTSの最新パッチ**を推奨します。ソースのGo言語要件は1.23以上、Nodeのテスト要件は22.16以上です。運用バイナリーは古い検証用Goではなく、保守中のGoでビルドしてください。

```powershell
cd C:\src\token-monitor-analytics
.\scripts\bootstrap.ps1
```

Go Collectorに外部依存はないため`go.sum`は不要です。Web側の直接開発依存はTypeScript 5.8.3、Wrangler 4.126.0に固定しています。このZIP作成環境ではnpmレジストリーへ接続できなかったため、**package-lock.jsonは未生成**です。bootstrapが生成する`analytics/package-lock.json`を確認し、Gitへ追加してください。以後は`npm ci`を使います。

## 2. まずローカルで一通り動かす

3つのPowerShellを同じリポジトリールートで開きます。

**A: 模擬Hub**

```powershell
.\scripts\run-mock.ps1
```

**B: Analytics（ローカルWorkers/D1/DO）**

```powershell
cd analytics
npm run dev
```

**C: Go Collector**

```powershell
.\scripts\run-collector.ps1 -Demo
```

ブラウザーで **http://127.0.0.1:8787** を開きます。すべてループバックで通信し、Cloudflareへのログインやデプロイは必要ありません。模擬データが3秒ごとに変わり、少数回の更新後に期間枠`$160`、月換算約`$695.70`という**合成値**が出ることを確認します。デモの料金・利用枠は実サービスの値ではありません。

`Hub B`が未受信でも正常です。デモはHub Aのみを送ります。ローカル設定を本番へデプロイしないでください。デモのoutboxは`data/demo-outbox/`、ローカルD1は`analytics/.wrangler/`に保存されます。

## 3. テストとWindows→Linuxビルド

```powershell
.\scripts\test.ps1
.\scripts\build-collector.ps1
```

`bin/`にWindows amd64、Linux amd64、Linux arm64のCollectorを生成します。Ubuntuへ持っていくのはLinux用の1ファイルだけです。Ubuntuで`uname -m`が`x86_64`ならamd64、`aarch64`ならarm64です。Ubuntu上にGoやNode.jsをインストールする必要はありません。

## 4. AnalyticsをCloudflareへ配置する

詳細は [Cloudflare導入](docs/CLOUDFLARE.md) です。**Account C（Analytics用）**を明示し、次の順序で進めます。

1. Wranglerへログインし、Analytics用アカウントを選ぶ。
2. D1を1つ作成し、`analytics/wrangler.jsonc`の`database_id`へ設定する。
3. `analytics/src/settings.ts`へHub IDと契約定義を設定する。初回の`contracts: []`は正常。
4. `INGEST_TOKEN`をWorker Secretへ設定する。
5. D1のremoteマイグレーションとWorkerデプロイを実施する。
6. AnalyticsサイトをCloudflare Accessで保護し、team domainとAudienceを設定して再デプロイする。

閲覧APIはAccess設定が不完全なら**拒否**します。`/api/ingest`は独立したBearer認証なので、Accessのログイン要求に遮られない専用ポリシーを設定します。Hub共有シークレット、送信トークン、Cloudflareの管理用API Tokenはそれぞれ別物です。

## 5. Windowsから実Hubに接続する

```powershell
Copy-Item .\collector\configs\collector.example.json .\collector\config.local.json
```

`analytics_url`、`hubs[].url`を実際のoriginへ変更します。`/api`などのパスは付けません。Hubが1つなら、2つ目の要素を削除します。Hub IDは`analytics/src/settings.ts`と一致させます。

```powershell
$env:TMA_HUB_A_SECRET = Read-Host -MaskInput 'Hub A shared secret'
$env:TMA_HUB_B_SECRET = Read-Host -MaskInput 'Hub B shared secret'
$env:TMA_INGEST_TOKEN = Read-Host -MaskInput 'Analytics ingest token'
.\scripts\run-collector.ps1
```

出力が`SSE connected`→`uploaded`となり、Web画面の最終観測時刻が更新されることを確認してください。WindowsとUbuntuで**同じHubを収集するCollectorを同時稼働させないでください**。切替時はWindows版を終了します。

## 6. Ubuntuで常駐させる

[Ubuntu運用](docs/UBUNTU.md) にコピー・初回設定・systemd登録の完全なコマンドを記載しています。

```bash
sudo systemctl enable --now tma-collector
sudo systemctl status tma-collector
sudo journalctl -u tma-collector -f
```

Ubuntuは外向きのSSE/HTTPSだけを使用します。ポート開放、Cloudflare Tunnel、Docker、常駐DBサーバーは不要です。設定/環境変数を変えたら`sudo systemctl restart tma-collector`を実行します。

## 7. 契約を紐付けて推定を有効にする

最初は観測値だけを保存して構いません。アカウントハッシュ・deviceId・clientIdは、Access認証済みブラウザーで`/api/state`を開くかConnections画面で確認します。

`docs/contract.example.ts`を参考に`analytics/src/settings.ts`へ定義を追加します。**そのデバイス/クライアントの金額が、その契約の対象利用だけを過不足なく表す**と確認できた場合だけ、`attributionConfirmed: true`へ変更します。API従量利用や別アカウントを混ぜた値からは推定しません。

```text
期間枠の参考推定 = API換算額の増分 ÷ (利用率の増分 / 100)
月換算・参考 = 期間枠の参考推定 × (平均月時間 / 制限枠時間)
```

モデル構成、制限の仕組み、計測漏れに依存する参考値であり、保証される利用可能額ではありません。リセット、再接続、カウンター減少、観測の欠落があれば基準を作り直します。詳しくは [推定仕様](docs/ESTIMATION.md)。

## 8. Gitリポジトリーとして開始する

```powershell
git init -b main
git status --short
git add .
git commit -m "chore: initialize web analytics and Go collector"
```

ZIPには`.git`、実アカウントID、秘密情報、ビルド済みexeは含めません。GitHubへのリポジトリー作成やpush、Cloudflareリソース作成は行っていません。公開ライセンスは未選択です。

## 文書

[構成と責務](docs/ARCHITECTURE.md) / [Cloudflare](docs/CLOUDFLARE.md) / [Ubuntu](docs/UBUNTU.md) / [プロトコル](docs/PROTOCOL.md) / [推定](docs/ESTIMATION.md) / [運用と無料枠](docs/OPERATIONS.md) / [検証](docs/VERIFICATION.md) / [一次資料](docs/SOURCES.md) / [開発指針](AGENTS.md)
