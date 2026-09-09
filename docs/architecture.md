# アーキテクチャ — 0.3.0

## 実行配置

初期運用はUbuntu 1台にGo CollectorとNode.js Analyticsを同居させる。開発はWindows上に同じ2プロセスを起動する。別プロセスだが、HTTP APIの相手は通常loopbackであり、別サーバーやメッセージブローカーを必要としない。

Hubは既存のCloudflare版を使用し、1 Hub = 1 Cloudflareアカウントという前提を変更しない。Analytics側のCloudflareアカウント・Worker・D1・Durable Objects・Access・Wranglerは使用しない。

Ubuntuの発行構成では、Analyticsの同一プロセスがloopback取込み用とTailscale IPv4閲覧用の二つの待受を持つ。SQLiteと取込み直列化・ライブ通知は共有する。Tailscaleを閲覧の認証境界とし、アプリの閲覧資格情報を要求しない。閲覧側のingestは遮断し、loopback取込みのBearer認証は維持する。環境構築はsudoを使う`provision:ubuntu`、設定・発行は通常ユーザーの`configure:ubuntu`・`publish:ubuntu`に分離する。

## 責務

Go CollectorはHubのSSEを購読し、API金額・利用率などの必要な観測値だけを取り出す。ファイルoutboxに記録したイベントを短いHTTP POSTでAnalyticsに送り、保存確認後だけ削除する。API料金の再計算、推定、履歴照会、Web配信はしない。

AnalyticsはNode.jsのHTTPサーバー。既存のTypeScriptコード（protocol/estimate/db）を引き継ぎ、runtime/のコードがSQLite・認証・HTTP・ライブ通知を担当する。実行時はNodeのTypeScript型除去を使用し、ビルドツールや第三者のランタイムパッケージを要求しない。型検査は別途TypeScriptで実施する。[S1][S2]

## 保存トランザクション

SQLiteが観測・最新値・推定状態・日次履歴の正本。1 Analyticsプロセスだけが扱う。`BEGIN IMMEDIATE`からCOMMITまで、基準値SELECT→観測保存→最新値更新→推定→日次値保存の全体を1トランザクションとする。API呼出しと保守処理をキューで直列化し、未コミットの中間状態を別HTTP要求へ返さない。

収集モジュールから保存層へ渡す内部APIは、`recordObservation(db, observation, contracts, timeZone)`（複数件は`recordObservations`）である。`observation`は`hubId`、`streamId`、`kind`、`observedAt`、`receivedAt`、正規化済み`stats`だけを持ち、Batch/schemaVersion/ACKや上流の再送IDを要求しない。入力に余分な`eventId`があっても内部APIは無視し、保存用の`event_id`は保存処理が16バイトのランダム値から生成する。保存payloadには既存の状態再送互換のため`schemaVersion: 1`とこのローカルIDを付加する。APIは同期関数で、呼出し側が`db.transaction(() => ...)`で囲む。トランザクションcallbackが`PromiseLike`を返す場合は型・実行時の両方で拒否し、COMMITしない。旧`/api/ingest`だけが移行期間の薄い橋として上流の再送IDを保持し、通常の内部収集経路では使わない。

WAL＋synchronous=FULLを使用する。スキーマは起動時に番号順に適用し、適用済みマイグレーションの書換えをchecksumで検出する。デモ/本番の識別をDBへ保存し、混在させる設定では起動しない。CPUとSQLite I/Oは同じNodeイベントループで実行するため、小規模・個人利用のスターターが対象。大量データを処理する汎用分析基盤ではない。

## ライブ更新

ブラウザーはGET /api/stateで初期状態を取得する。GET /api/liveをEventSourceで購読し、ready/updated通知で状態を再取得する。**Hub→CollectorもSSE、Analytics→ブラウザーもSSEだが、別の接続**である。旧版のWebSocket/LiveRoomは廃止した。

通知はCOMMIT後。通知自体の永続キューや完全配信保証は設けない。通知が欠けても履歴はSQLiteに残り、再接続・タブ復帰・手動更新で読み直す。25秒ごとのコメントheartbeat、最大16閲覧接続、遅いブラウザーの切断を実装。ブラウザーを閉じても収集は止めない。[S3]

## 障害境界

Analyticsだけ停止した場合はCollectorがoutboxへ保留する。Ubuntu全体の停止やHubへの接続断で未受信だった更新は復元できない。再接続時の最新snapshotから再開し、streamIdを変えて推定の基準を再設定する。

outboxはwrite→fsync→rename後に送信対象とするが、rename後のディレクトリーfsyncまでは実施しない。したがって**電源断を含む全障害に対する完全な永続保証はしない**。プロセス停止/通信断からの再送が主対象。1 outboxにつき1 Collectorだけを起動する。

## 拡張の境界

純粋な推定ロジックとNode組込みSQLiteの同期`Database`/`Statement`境界を維持する。Promiseで同期SQLiteを包む互換層、Cloudflare/クラウドStoreの実装、クラウドへの自動切替、DB同期は含めない。実要件が発生する前から複数運用形態を抱え込まない。

## Hub管理UI（基本機能実装済み）

AnalyticsをHub設定の更新窓口とし、Collectorが共有設定ファイルを定期確認する。[Hub管理UIの実装計画](https://github.com/nuitsjp/token-monitor-analytics/issues/16)を参照。Analytics→CollectorのSSEは追加せず、既存の観測・ブラウザー通知経路を維持する。通常設定と平文の秘密情報は別ファイルに置き、OS権限で保護する。状態表示のためのCollector→Analyticsのloopback POSTを追加している。configure/publish/statusは管理モードに対応する。既存登録の移行は行わず、明示的なリセットとUIでの再登録を使用する。
