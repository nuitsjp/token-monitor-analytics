# アーキテクチャ

## 確定事項

Windowsで開発し、UbuntuでGo Collectorを常駐運用する。AnalyticsはCloudflare上のWebアプリ。HubとAnalyticsは別アカウントで、Hubは原則1アカウントにつき1つ。HubはToken Monitor側の別リポジトリーで管理し、このリポジトリーから変更しない。

## 責務と実行時間

CollectorはHubの`/api/stats/stream`を長時間購読する。API換算額は上流から取得し、再計算しない。受信データからセッション、プロジェクト名、メールなどを落として必要な観測項目だけをファイルoutboxへ確定し、短いHTTPS POSTで送る。既定の送信待ちは最大約2秒、バッチ上限は2件。

Analytics Workerが認証・サイズ/スキーマ検証を行い、1つのLiveRoomへ渡す。LiveRoomは**短いリクエストだけ**で動作し、`blockConcurrencyWhile()`でD1の基準値読取りと保存を直列化する。これにより送信タイムアウト後の再送などが重なっても、履歴・基準値・日次値の整合を保つ。保存成功後にブラウザーへ無効化通知を出し、Collectorへ確認応答する。詳細データはブラウザーが認証付きAPIから読む。

LiveRoomに永続的な利用履歴は置かない。WebSocketの有効期限だけをattachmentへ付ける。`acceptWebSocket()`と自動ping/pong応答を使い、接続中でも待機時にhibernateできる。サーバー側の周期タイマー、SSE購読、常駐維持用Alarmは作らない。[S1]

## 正本と例外

D1が観測・推定履歴の正本。Collectorのoutboxは未送信分だけの再送バッファであり、双方向同期DBではない。ファイルのwrite→fsync→rename後に送信対象とし、保存確認後だけ削除する。rename後のディレクトリーfsyncまでは行わないため、**電源断に対する完全な永続保証はしない**。プロセス停止/ネットワーク障害の再送を主対象にする。単一Collector・単一outbox writerという運用制約がある。

HubのSSEに履歴再送契約はない。[S6] Collector停止中、またはバッファ満杯で受信が停滞した間の上流イベントを復元できるとは扱わない。再接続ごとに新しいstreamIdを発行し、推定基準をリセットする。

## UI

静的HTML/CSS/JavaScript + TypeScript API。React/SSR/独立したフロントビルドは初期には不要。ブラウザーは認証済みHTTPで初期状態を取得し、WebSocketのready/updated通知でも読直す。接続し直した後も再取得する。これはHubの定期ポーリングではない。通知はベストエフォートで、永続化と通知の二相コミットや追加の通知キューは導入しない。通知だけ失敗した場合は再接続/手動更新/タブ復帰で現在値を読み直す。

## 初期上限

Collectorは最大8 Hub、1 Hub snapshotは最大64 devices/64 provider accounts、送信イベントは128 KiB以下。Analyticsの契約・制限枠定義は合計8個まで。1バッチ2イベントと合わせ、1回の保存処理をD1のクエリー上限内に収めるためのスターター上限であり、製品としての最大拡張性ではない。WebSocketは最大16接続。

参照番号は[SOURCES](SOURCES.md)。
