# 0.3.x — Node単一アプリ構成

- Hub購読、端末別履歴、Hub管理、保存、推定、ブラウザー配信を1つのNode.js Analyticsへ統合。
- 常駐DB writerとHTTP listenerをそれぞれ1つに統一し、同期native SQLite transactionとCOMMIT後通知へ整理。
- SQLiteのmigration checksum、WAL/`synchronous=FULL`、バックアップ、デモ/本番DB分離を維持。
- Hub SecretをSQLiteと起動設定から分離し、専用ファイルとOS権限で保護。
- NodeのSSE購読・再接続と認証付き端末履歴取得を追加。欠測はHubが保持する範囲だけ補完。
- UbuntuのAnalytics常駐serviceと更新時だけ動くoneshot runnerを分離。発行物はallowlistで作成し、同一content/configurationの再発行は再起動しない。
- 旧Collector、内部ingest、Batch/ACK、outbox、二重listener、共有Hub設定の定期同期を通常構成から撤去。既存環境の初回切替は移行専用手順で行う。

旧Cloudflare/D1のデータや旧構成のHub登録は自動移行しません。初回切替は[移行手順](docs/MIGRATION.md)を読み、バックアップと復旧確認を済ませてから実行してください。
