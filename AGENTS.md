# 開発指針

## 配置と技術

初期はUbuntuにGo CollectorとNode.js Analyticsを同居。開発中はWindows上で両方を起動する。Hubは既存Cloudflareの別リポジトリー。AnalyticsにCloudflare、Wails、デスクトップGUI、Dockerを導入しない。

CollectorはGo標準ライブラリー。AnalyticsはNode組込みHTTP/SQLite、純粋なTypeScript推定処理、静的HTML/CSS/JS。Nodeの型除去で直接動かすため、enum、引数プロパティ、非type importの型、tsconfigパスエイリアスなどを導入しない。変更時はtscも実行する。

## 単純さ

Hub→CollectorはSSE、Collector→同居Analyticsはloopback HTTP POST、Analytics→ブラウザーはSSE。黙ってポーリングへ変えない。履歴の正本はSQLite1つ。outboxは未送信バッファだけで、DB同期ではない。外部キュー・Redis・クラウドへの自動フォールバック・プラグイン層は不要。

## 正しさと安全

1 Analytics、1 Collector、1 outbox writerが初期運用。ingest全体をSQLite transactionで直列化し、COMMIT後だけACKと通知を出す。未知/欠測はnull。金額の独自再計算やアカウントの推測帰属はしない。利用率と金額の対象・期間を一致させる。デモDBと本番DBを混ぜない。

既定はloopbackのみで待受、Ubuntuからの閲覧はSSH転送＋Basic認証。Hub Secretとingest/viewer認証を分離。設定・env・DB・outboxをフロント/Git/ログに出さない。外部公開はTLSプロキシ等の明示的な別要件として扱う。

## 検証

Go: gofmt / go test ./... / go vet ./...、Linuxで-race。
Analytics: npm test（ネイティブHTTP/SSE/SQLite）とnpm run typecheck。
結合: node --experimental-strip-types tools/integration.mjs。
WindowsとUbuntuの違いはパス・終了処理・ファイルロックも確認する。未実行のOS/systemd試験を成功と書かない。適用済みSQLは変更せず、新migrationを追加する。
