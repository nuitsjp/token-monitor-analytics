# 接続プロトコル

## HubからAnalytics

AnalyticsはHub originの`GET /api/stats/stream`へ接続し、`Authorization: Bearer <Hub Secret>`を送ります。初回の`snapshot`、以後の`stats`を受け取り、data JSONの`type`、`at`、`stats`を検証します。Hubのheartbeatコメントは接続活性だけに使い、観測として保存しません。

SSE parserはUTF-8チャンク境界、BOM、LF/CRLF/CR、複数`data`行、コメント、未知field、不完全EOF、1イベント8 MiB上限を扱います。redirectは追従しません。HTTPS originを必須とし、loopback開発時だけHTTPを許可します。`at`が現在より5分以上未来のイベント、未知の構造、許可されていない情報、上限超過は当該Hubの入力エラーにします。

正規化した内部`Observation`は次の項目だけを持ちます。

```json
{
  "hubId": "hub-a",
  "streamId": "connection-local-id",
  "kind": "snapshot",
  "observedAt": "2026-09-05T00:00:00.000Z",
  "receivedAt": "2026-09-05T00:00:01.000Z",
  "stats": {
    "updatedAt": "2026-09-05T00:00:00.000Z",
    "periods": {},
    "devices": [],
    "limits": {"providers": []}
  }
}
```

`event_id`はAnalyticsが16バイトの乱数から生成します。Hubの再送ID、Batch envelope、送信資格情報を内部APIへ渡しません。古い観測は履歴として保存できますが、Hub最新値や推定基準を逆行させません。保存transactionのCOMMIT後にだけブラウザー通知を出します。

通信断・5xx・408・429は1秒から最大30秒のjitter付き指数backoffです。401/403などの恒常的な認証エラー、redirect、入力不正は当該Hubを停止し、管理操作または再接続で再開します。Hubごとの障害は他Hubとブラウザーへ波及させません。SQLite保存不能は全収集を停止します。

## Hub履歴

履歴補完は認証付き`GET /api/devices`を使います。取得全体を検証し、`devices[].history`の端末別daily/monthly行を保存します。1応答16 MiB、端末数・行数・map entriesに上限があります。重複device ID、日/月キー、構造不正、数値不正は既存保存を壊さずに失敗します。

起動、Hub登録、SSE再接続、Hubの`deviceHistoryRevision`/`historyRevision`通知、手動要求で取得します。revisionは変更通知であり、GET応答の版番号とはみなしません。取得中の通知はdirty状態として次回へまとめ、Hubごとの取得を直列化します。通信失敗は有限回再試行し、404/非対応はそのHubの補完非対応として表示します。

## ブラウザーAPI

同じHTTP listenerが以下を提供します。

| Endpoint | 用途 |
| --- | --- |
| `GET /api/health` | 秘密を含まないプロセスhealthとrelease identity |
| `GET /api/state` | 最新Hub観測、推定、Hub接続状態、契約、release identity |
| `GET /api/live` | `ready`とCOMMIT後の再取得通知、heartbeatコメント |
| `GET /api/history?contract=id` | 契約の日次推定履歴 |
| `GET /api/usage-history/...` | 端末別daily/monthly履歴 |
| `/api/manage/hubs` | 明示的に有効にしたHub管理 |
| `/api/manage/update` | 更新候補確認と適用要求 |

`/api/ingest`と`/api/collector/status`は存在しません。Analytics内部のHub認証、閲覧認証、管理Origin/Host検査は独立しています。loopback、Basic、または専用Tailscale待受で閲覧境界を作ります。Hub Secret、secretRef、設定ファイル全体、DBパス、環境変数名をレスポンスへ含めません。

## 時刻と欠測

Hubの`at`が観測時刻、Analyticsの`receivedAt`が受信時刻です。ISO文字列をミリ秒精度へ正規化し、未来5分超を拒否します。SSE切断そのものは履歴イベントにせず、`streamId`の変化で推定区間を切り分けます。Hub停止中の値はHubが保持する端末履歴の範囲だけを補完し、limit時系列や過去の推定値を生成しません。
