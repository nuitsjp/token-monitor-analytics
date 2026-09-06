# 開発指針

## 配置と技術

初期はUbuntuにGo CollectorとNode.js Analyticsを同居。開発中はWindows上で両方を起動する。Hubは既存Cloudflareの別リポジトリー。AnalyticsにCloudflare、Wails、デスクトップGUI、Dockerを導入しない。

Hub API仕様: [API資料](external/token-monitor/docs/API.md) / [Worker README](external/token-monitor/worker/README.md#endpoints)。

CollectorはGo標準ライブラリー。AnalyticsはNode組込みHTTP/SQLite、純粋なTypeScript推定処理、静的HTML/CSS/JS。Nodeの型除去で直接動かすため、enum、引数プロパティ、非type importの型、tsconfigパスエイリアスなどを導入しない。変更時はtscも実行する。

## 単純さ

Hub→CollectorはSSE、Collector→同居Analyticsはloopback HTTP POST、Analytics→ブラウザーはSSE。黙ってポーリングへ変えない。履歴の正本はSQLite1つ。outboxは未送信バッファだけで、DB同期ではない。外部キュー・Redis・クラウドへの自動フォールバック・プラグイン層は不要。

Hub管理UIは[GitHub Issue #16](https://github.com/nuitsjp/token-monitor-analytics/issues/16)に従う。Collectorによるローカル設定ファイルの定期確認は合意済みであり、観測のSSE経路は維持する。Analytics→Collectorの設定通知SSEは追加しない。Hub Secretは通常設定から別ファイルへ分離し、今回は暗号化せずOS権限で保護する。管理モードではAnalyticsの管理処理とCollectorがSecretを扱い、UIへ保存済み値や設定ファイル全体を返さない。

## 正しさと安全

1 Analytics、1 Collector、1 outbox writerが初期運用。ingest全体をSQLite transactionで直列化し、COMMIT後だけACKと通知を出す。未知/欠測はnull。金額の独自再計算やアカウントの推測帰属はしない。利用率と金額の対象・期間を一致させる。デモDBと本番DBを混ぜない。

既定はloopbackのみで待受、Ubuntuからの閲覧はSSH転送＋Basic認証。Hub Secretとingest/viewer認証を分離。設定・env・DB・outboxをフロント/Git/ログに出さない。外部公開は明示的な別要件として扱う。承認済みのUbuntu発行構成ではTailscaleを閲覧の認証境界とし、`viewerAuth.mode=tailscale`でアプリの閲覧認証を省略する。専用Tailscale IP待受と外部ingest遮断、loopback ingestのBearer認証は維持する。sudoを使う環境構築は`provision:ubuntu`、通常ユーザーの設定は`configure:ubuntu`、sudo不要の発行は`publish:ubuntu`に分離し、冪等性を維持する。

## 検証

Go: gofmt / go test ./... / go vet ./...、Linuxで-race。
Analytics: npm test（ネイティブHTTP/SSE/SQLite）とnpm run typecheck。
結合: node --experimental-strip-types tools/integration.mjs。
WindowsとUbuntuの違いはパス・終了処理・ファイルロックも確認する。未実行のOS/systemd試験を成功と書かない。適用済みSQLは変更せず、新migrationを追加する。

現環境の旧Hub情報は移行せず、明示的なリセットで登録とSecretを削除してUIから登録し直す。削除前にCollectorを停止し未送信outboxのCOMMIT ACKを確認する。履歴SQLiteとingest認証は保持する。
