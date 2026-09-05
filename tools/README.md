# テスト補助

`local-platform.mjs`はNode.js組込みSQLiteで、実Worker/LiveRoomハンドラーをHTTPから呼ぶテスト専用ホストです。WebSocket、DO休止、Cloudflareの認証ゲート、課金を再現しません。代替の本番アーキテクチャや自動フォールバックではありません。通常の開発にはREADMEどおりWranglerを使用します。

```bash
cd analytics
npm run build:test
cd ..
node tools/local-platform.mjs
```

別ターミナルで模擬HubとDemo Collectorを動かせます。ループバック8787だけに待受けます。WebSocketは意図的に未実装です。`TMA_TEST_DB`でテスト用SQLiteファイルを指定でき、未指定はメモリーDBです。実データや本番認証情報を渡さないでください。
