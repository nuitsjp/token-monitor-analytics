# Token Monitor Analytics

Token Monitor Hub の利用状況を収集し、SQLiteへ保存し、ブラウザーへ表示する個人向けWebアプリです。Hub接続・保存・推定・HTTP/SSE配信は1つのNode.jsプロセスで行います。

```text
Token Monitor Hub ── HTTPS SSE ──┐
                                 ▼
                         Analytics (Node.js)
                         ├─ Hub購読と履歴取得
                         ├─ SQLite 1つ・同期writer 1つ
                         └─ HTTP/SSE listener 1つ
                                 │
                                 ▼
                             Browser
```

常駐するのはAnalyticsだけです。更新時だけ独立したoneshot runnerを使います。Go、Collector、内部POST、ACK、outbox、追加DB、Redis、Cloudflare/Wranglerは通常構成に含めません。Hub SecretはSQLiteやAPIへ入れず、専用ファイルをOSの権限で保護します。

## 開発環境

Node.js 24.20.0を`.mise.toml`で固定しています。`mise`を準備した後、リポジトリーのルートで実行します。

```text
mise trust
mise install
mise run setup
```

`mise run setup`は固定Node、組込みSQLite、ロック済みTypeScript開発依存を確認します。AnalyticsはNodeの型除去で直接起動でき、ビルド成果物を要求しません。

主なタスクは次のとおりです。

| コマンド | 内容 |
| --- | --- |
| `mise run check` | AnalyticsのHTTP/SQLite/SSEテスト、公開ツールテスト、型検査 |
| `mise run integration` | 模擬Hub、Node収集、SQLite、ブラウザーSSEの結合試験 |
| `mise run demo:hub` | ループバックの模擬Hub |
| `mise run demo:analytics` | 本番DBと分離したデモAnalytics |
| `mise run package:ubuntu:amd64` | amd64配布物を作成し、展開後の起動を検査 |
| `mise run package:ubuntu:arm64` | arm64配布物を作成し、内容を検査 |
| `mise run release:ubuntu:amd64` | 全チェック後にamd64配布物を作成 |
| `mise run release:ubuntu:arm64` | 全チェック後にarm64配布物を作成 |

## ローカルデモ

2つのターミナルで実行します。

```text
# terminal A
mise run demo:hub

# terminal B
mise run demo:analytics
```

ブラウザーで`http://127.0.0.1:8787`を開きます。デモDBとSecretは`data/demo/`に作られ、本番設定とは混ざりません。停止は各ターミナルでCtrl+Cを押します。

自分のHubを使う場合は、`analytics/configs/analytics.example.json`をコピーして`analytics/config.local.json`を作り、Analyticsを起動します。管理モードを有効にした設定では、画面のHub管理からURLとSecretを登録します。登録内容の正本はSQLiteの`hubs`テーブル、Secretの正本は`hub-secrets.json`です。保存後に同じプロセスのSSE購読が開始されます。

```text
node --experimental-strip-types analytics/runtime/server.mjs --config analytics/config.local.json
```

契約を設定すると、指定したHub・provider・account・device・client・制限枠だけを使って参考値を推定します。Hubが返した金額を独自の単価表で再計算せず、帰属が確認できない値や欠測を0へ変換しません。計算の定義は[推定仕様](docs/ESTIMATION.md)を参照してください。

## Ubuntu

Ubuntuでは管理者操作と通常ユーザー操作を分けます。

1. `mise run provision:ubuntu`で固定Node、`tma-analytics.service`、更新時だけ動く`tma-update.service`、配置権限を準備します。
2. `mise run configure:ubuntu`でlistener、SQLite、Secretファイル、閲覧モードを設定します。
3. `mise run publish:ubuntu`で検証済みSHAの配布物を検査・配置し、Analyticsを再起動します。
4. `mise run status:ubuntu`で構築記録、Analytics、更新runner、healthを確認します。

通常運用で有効になる常駐サービスは`tma-analytics.service`だけです。`tma-update.service`は更新要求時だけ起動し、収集や通常のDB書込みは行いません。既存環境からの初回切替は[移行手順](docs/MIGRATION.md)に従い、通常の発行でHub登録を自動削除しません。

既定の閲覧待受はloopbackです。Ubuntuの承認済み公開構成では、専用Tailscale IPv4を1つのlistenerに指定し、`viewerAuth.mode=tailscale`でTailscaleを認証境界にします。一般公開やワイルドカード待受へ自動変更しません。[公開手順](docs/PUBLICATION.md)と[セキュリティ](docs/SECURITY.md)を確認してください。

SQLiteのバックアップはアプリのバックアップAPIを使います。

```text
node --experimental-strip-types analytics/runtime/backup.mjs \
  --config analytics/config.local.json \
  --output backups/analytics-YYYYMMDD.db
```

稼働中の`.db`ファイルを単純コピーしないでください。migrationは起動時に番号順で適用され、適用済みSQLの変更はchecksumで拒否されます。

## 保存と通知

観測保存、最新値、推定状態、日次行は`BEGIN IMMEDIATE`からCOMMITまでの短い同期transactionで原子的に更新します。Nodeのnative `DatabaseSync`/`StatementSync`を直接使い、transaction callbackは同期関数だけを許可します。Hubのネットワーク処理とSecretファイルI/Oはtransactionの外です。ブラウザーSSE通知はCOMMIT後にだけ送ります。

HubごとのSSEはUTF-8分割、BOM、改行形式、heartbeat、8 MiBイベント上限、認証、redirect拒否、再接続backoffを処理します。保存不能は入力不正と分けて収集を停止します。ブラウザーを閉じてもHub購読は続きますが、Analyticsが停止していた期間の観測を推測して作りません。停止中の欠測はHubが保持する端末別履歴を起動・再接続・履歴更新時に補完します。

詳細は[アーキテクチャ](docs/architecture.md)、[接続プロトコル](docs/PROTOCOL.md)、[運用](docs/OPERATIONS.md)、[検証](docs/VERIFICATION.md)を参照してください。

## ライセンスと一次資料

上流Hubの仕様は`external/token-monitor`と[一次資料一覧](docs/SOURCES.md)を参照します。配布物の依存情報は[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に記載します。
