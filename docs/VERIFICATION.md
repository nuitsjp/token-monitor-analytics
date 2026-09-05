# 検証結果

作成日: 2026-09-05 / starter 0.2.0

## 実行した検査

| 検査 | 結果 | 実行環境・範囲 |
|---|---|---|
| Goテスト | トップレベル23件成功 | Go 1.23.2 / Linux amd64、`go test -race ./...` |
| Go静的検査 | 成功 | `go vet ./...` |
| Windows amd64クロスビルド | 成功 | `CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ...`、PE32+確認。Windows実行ではない |
| Linux amd64クロスビルド | 成功 | ELF64 x86-64、静的リンクを確認 |
| Linux arm64クロスビルド | 成功 | ELF64 AArch64、静的リンクを確認。ARM64実行ではない |
| TypeScript | 成功 | TypeScript 5.8.3、`npm run typecheck` |
| Web側テスト | 29件成功 | Node.js 22.16.0、`npm test`。推定、プロトコル、認証、実SQLite SQL、通知処理 |
| フロントエンド構文 | 成功 | `node --check analytics/public/app.js` |
| HTTP結合 | 成功 | 模擬Hub→実Go Collector→実HTTP→Worker/LiveRoomハンドラー→SQLite adapter |
| 再送 | 成功 | Analytics停止でoutboxが残り、再起動後に送信・削除されることを確認 |
| UI fixture | 成功 | Chromiumのメモリー内ページ、模擬fetch/WebSocket。3画面・合成値・履歴表/図・識別子・390px幅の横溢れなしを確認 |

HTTP結合試験では合成データから期間枠160 USDの推定を確認。3観測、1 latest、1 dailyを保存した小規模スモーク試験であり、負荷試験・24時間連続試験ではない。

WebテストのSQLite adapterはNode組込みSQLiteを使って実SQL・トランザクションを検証する。一方でCloudflareのD1ネットワーク、クエリー課金、Durable Objectのイベントゲートや休止を再現するものではない。

## 実施していない検証

- npm install / Wrangler 4.126.0の取得と実行。作成環境からnpmレジストリーへの接続ができなかったため、Wrangler / workerd / ローカルD1ランタイムは未実行。
- `npm run dev`とWranglerによるローカルD1マイグレーション、Cloudflareへの実デプロイ。
- 実CloudflareのAccessログイン、実WebSocket Upgrade / 休止 / ping-pong、Freeプランの使用量測定。
- 実Token Monitor Hubの接続。実HTTPの試験元は付属の模擬Hubのみ。
- Windows実機上での実行、Ubuntu実機上のsystemd登録、電源断/OS障害、長時間運用。

ChromiumからローカルHTTPページへ直接移動する試験は、環境の`ERR_BLOCKED_BY_ADMINISTRATOR`で実施できなかった。ネットワーク制限は変更せず、UIだけをメモリー内fixtureで検査した。実ブラウザーのAccess・WebSocket結合の代わりではない。

## 初回に利用者側で実施すること

`bootstrap.ps1`でnpm依存取得とローカルマイグレーションを行い、生成された`analytics/package-lock.json`をコミットする。Goには外部モジュール依存がないため、`go.sum`未添付は不足ではない。

READMEの3ターミナル手順でWrangler上の実ローカルランタイムを確認し、次にCloudflare本番へ配置する。実Hubで契約の帰属を確認してからUbuntuへ移す。運用バイナリーはGo 1.26系など保守中の最新パッチで利用者側がビルドする。今回検査用に作ったGo 1.23.2のバイナリーはZIPへ同梱しない。

CI定義は含むが、ユーザーのGitHub上でワークフローを実行したわけではない。リポジトリー作成、Cloudflareリソース作成、秘密情報の登録も行っていない。
