# 一次資料（設計確認: 2026-09-05）

- **S1** Cloudflare, Use WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ — acceptWebSocket、休止、自動ping/pong、new_sqlite_classes。
- **S2** Cloudflare, Validate JWTs: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ — Access署名、issuer、audience、JWTヘッダー。
- **S3** Cloudflare, D1 Pricing: https://developers.cloudflare.com/d1/platform/pricing/ — 行単位の読み書き、索引、Free枠。
- **S4** Cloudflare, D1 Limits: https://developers.cloudflare.com/d1/platform/limits/ — 1DB容量、クエリー数等。
- **S5** Cloudflare, Durable Objects Pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/ — Duration、128MB計量、Free枠。
- **S6** Token Monitor v0.54.0 Worker/API: https://github.com/Javis603/token-monitor/blob/v0.54.0/worker/src/index.js と https://github.com/Javis603/token-monitor/blob/v0.54.0/docs/API.md — SSEイベント、heartbeat、stats形状。この会話で確認した固定バージョンの契約を使用。今後の互換性は受入試験で確認する。
- **S7** systemd: https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html と https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html — サービス常駐、環境ファイル、StateDirectory。
- **S8** Cloudflare, Application paths: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/ — ホスト/パス単位のAccessポリシー。
- **S9** Cloudflare, Worker static-assets routing: https://developers.cloudflare.com/workers/static-assets/routing/worker-script/ — run_worker_first、静的配信。
- **S10** Wrangler: https://developers.cloudflare.com/workers/wrangler/install-and-update/ と https://www.npmjs.com/package/wrangler — プロジェクトローカルのCLI。確認時の4.126.0を直接依存に固定。パッケージの取得/実行は作成環境で未実施。
- **S11** Go Release History: https://go.dev/doc/devel/release — 保守中のパッチを使う。作成環境のGo 1.23.2は動作検査用で、運用向け推奨ではない。
- **S12** D1 batch: https://developers.cloudflare.com/d1/worker-api/d1-database/ — batchの順序/トランザクション。

料金・上限・利用条件は変わり得るため、デプロイ時にも確認する。これらの文書はCloudflare上での実動作試験の代わりではない。
