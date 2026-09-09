# 開発指針

## 配置と技術

Hubは既存Cloudflareの別リポジトリーです。AnalyticsはNode.jsの組込みHTTP/SQLite、純粋なTypeScript推定処理、静的HTML/CSS/JSで構成します。常駐アプリは1つ、SQLiteは1つ、DB writerは1つ、HTTP待受は1つです。更新時だけ独立したoneshot runnerを起動します。Go、Collector、Wails、デスクトップGUI、Docker、Cloudflare、外部キュー、Redisは通常構成へ追加しません。

Nodeは型除去でTypeScriptを直接実行します。enum、parameter properties、非type importの型、tsconfigパスエイリアスを導入しません。Nodeのnative `DatabaseSync`/`StatementSync`を直接使い、同期SQLiteをPromise互換APIで包みません。TypeScript変更後は`npm run typecheck`を実行します。

Hub API仕様は`external/token-monitor/docs/API.md`と`external/token-monitor/worker/README.md`を参照します。Hub→Analyticsは認証付きSSE、Analytics→ブラウザーはSSEです。Hub履歴のHTTP取得は停止中の欠測補完と明示的な履歴更新に限り、SSEの代替ポーリングにはしません。

## 正しさと安全

観測保存・最新値・推定・日次行を`BEGIN IMMEDIATE`からCOMMITまでの同期transactionで直列化します。callbackは同期関数だけを許可し、通知はCOMMIT後に出します。ネットワークとSecretファイルI/Oはtransactionの外に置きます。未知・欠測はnull、0は有効な値として保持し、Hubの金額を独自計算せず、アカウントの推測帰属をしません。利用率と金額の対象・期間を一致させます。

既定はloopback待受です。Ubuntuの承認済み公開構成では専用Tailscale IPを1つのlistenerに指定し、`viewerAuth.mode=tailscale`を使います。別のingest待受、`/api/ingest`、`/api/collector/status`、ingest専用Bearer、Hub設定ファイルの定期同期は実装しません。Hub Secretは`hub-secrets.json`へ分離し、OS権限で保護します。設定、env、DB、Secret、履歴、ログをフロントエンド・Git・配布物へ出しません。

Hub登録の正本はSQLiteの`hubs`テーブルです。Hub IDは再利用せず、削除はarchiveとします。管理操作は行versionで競合を検出し、COMMIT直後に同じプロセスの購読世代を更新します。旧Hub登録の初回切替は#27の移行CLIだけが扱い、通常起動・発行は旧設定やoutboxを読みません。

適用済みmigration SQLは変更せず、新しいmigrationを追加します。デモDBと本番DBを混ぜません。壊れたDBを空DBとして起動し直しません。SQLite保存不能は収集を停止し、入力不正とは分けます。大きな履歴は1つの同期transactionで処理し、worker・分割atomic response・別DBを追加して回避しません。prepared statementをtransaction単位で再利用します。

## 検証

```text
npm --prefix analytics test
npm --prefix analytics run typecheck
node --experimental-strip-types --test tools/test/*.test.mjs
node --experimental-strip-types tools/integration.mjs
node --experimental-strip-types tools/integration-manage.mjs
node --experimental-strip-types tools/integration-update.mjs
```

配布確認は`mise run package:ubuntu:amd64`または`mise run package:ubuntu:arm64`を使います。Windowsのパス、Ctrl+C、ACL、ファイルlock、Ubuntuのservice/再起動/Tailscaleは実行したOSの証跡だけを成功と記録します。未実行のOS・systemd試験を成功と書きません。

移行専用コード（旧設定の読取り、drain、reset、旧service検査）は`tools/migrate.mjs`とそのテストの入口からだけ呼びます。通常のruntime、起動、publish、releaseへimportしません。移行前の旧サービスを停止・変更・再起動する場合は、#27の手順と明示的な運用承認に従います。
