# 0.3.0 — self-hosted first (2026-09-05)

- 0.2.0 Web/Ubuntu版を元に修正。Go Collector・SSE購読・outbox・推定ステートマシン・3画面を継承。
- AnalyticsをNode.js HTTPサーバー＋ローカルSQLiteへ変更。Windows/Ubuntu共通ランタイム。
- D1/Worker/LiveRoom/Cloudflare Access/Wranglerを削除。残っていた旧エントリーポイント・設定・検証ホストを整理し、認証テストをネイティブNode版へ移行。
- ブラウザーのライブ通知をWebSocketからSSEへ変更。Hub側のSSEは変更なし。
- SQLiteの起動時マイグレーション・取込み全体のトランザクション・バックアップを追加。
- 設定をTypeScriptソースからJSONへ移動。環境変数でシークレットを供給。
- UbuntuでAnalyticsとCollectorの2サービスを常駐。既定はloopback＋SSH転送。
- デモと本番を別DBへ分離し、誤ったDBの共用を起動時に拒否。
- ブラウザーの1観測日グラフ表示と保存先表示を改善。
- Web UIにシステム更新機能を統合（Issue #17）。GitHub mainの更新確認、手動適用、独立したsystemd oneshotサービス（tma-update.service）による発行、再起動後の結果表示。
- 発行記録にコミットSHA・コミット日時を保持。status:ubuntuでバージョンと直近更新状態を表示。

古い.wranglerのD1データは自動移行しません。元のディレクトリーは残してください。
