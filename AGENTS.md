# 開発指針

## 守る前提

Windowsで開発、UbuntuでGo Collectorを常駐、AnalyticsはCloudflareのWeb。デスクトップGUI・Wails・WebView2を導入しない。Hubは別リポジトリーの責務で、このアプリから変更しない。

Goは標準ライブラリーだけで維持する。Cloudflare上でSSE購読を常駐させない。Hub→CollectorはSSE、Collector→Analyticsは短いPOST、Analytics→ブラウザーはHibernation WebSocket。取得方式を黙ってポーリングに変更しない。

## Simple is best

D1が履歴の正本。LiveRoomは短い保存処理の直列化とライブ通知だけ。Collectorのoutboxは未送信の一時領域で、クラウドとの同期DBではない。Redis、外部キュー、常駐維持Alarm、フォールバックの多段化、抽象プラグイン層は実要求が出るまで導入しない。

認証には明示的な失敗を使う。本番でlocal認証を有効にしない。トークンをURL、フロントエンド、Git、エラーボディへ含めない。料金は上流の換算額を受け取り、独自単価計算をしない。

## 正しさ

nullと0、観測値と推定値、期間とアカウントの帰属を区別する。同じリセット窓・連続観測だけを推定対象にする。再送を冪等にし、古い観測で最新値/基準を戻さない。保存成功の応答を受ける前にoutboxを削除しない。欠測を捏造しない。

## 変更時の検証

`collector`: gofmt / go test ./... / go vet ./...。Linux CIで-race。
`analytics`: npm run typecheck / npm test。D1エミュレーター、SQLite adapter、Cloudflare本番を同一の検証として扱わない。Worker側の認証とWebSocket Origin検査を維持する。

新機能追加時はD1クエリー数・書込み行数・保存容量とDurationの影響を見積もる。無料枠に収まると未計測のまま断言しない。実機で実行していない試験を成功と記載しない。外部依存を追加したらlockfileとライセンスを確認する。
