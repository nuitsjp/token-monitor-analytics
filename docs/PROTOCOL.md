# 接続プロトコル v1

## 上流（確認基準: Token Monitor v0.54.0）

`GET {hubOrigin}/api/stats/stream`、`Authorization: Bearer <Hub shared secret>`。初回は`event: snapshot`、以後`event: stats`。dataは`{type:"stats",stats:{...},at:"ISO8601"}`。コメント形式のハートビートを活性監視に使うが保存・転送しない。[S6]

LF/CRLF/CR、複数data行、BOM、コメントに対応。不完全なEOFフレームは破棄し、再接続で新しいstreamIdを作る。`id`/`Last-Event-ID`によるバックフィルは、上流の再送契約がないので実装しない。HTTPSを必須にし、ループバックだけHTTPを許可する。リダイレクトには認証情報を追従させない。

## Collector → Analytics

`POST /api/ingest`、`Content-Type: application/json`、`Authorization: Bearer <INGEST_TOKEN>`。

```json
{
  "schemaVersion": 1,
  "events": [{
    "schemaVersion": 1,
    "hubId": "hub-a",
    "eventId": "ランダム16bytesのhex32桁",
    "streamId": "接続ごとに新しいhex32桁",
    "kind": "snapshot",
    "observedAt": "2026-09-05T00:00:00Z",
    "receivedAt": "2026-09-05T00:00:00Z",
    "stats": {
      "updatedAt": "2026-09-05T00:00:00Z",
      "periods": {}, "devices": [], "limits": {"providers": []}
    }
  }]
}
```

この例のeventId/streamIdは説明文なので、そのまま送信しない。1バッチ1〜2件、1イベント128 KiB以下、HTTP本文270,000 bytes以下。`stats.periods`はtoday/month/allTimeのcostUsd/totalTokens/clientCostsのみ。端末はdeviceId/updatedAt/stale/allTimeの金額だけ。providerはprovider/accountKey/updatedAt/status/stale/windowsだけ。プロジェクト名、セッション明細、メール、認証情報は送らない。

成功は`200 {"ok":true,"acked":["eventId",...]}`。全イベントのIDが確認されてから対応ファイルを削除する。エラー/応答不明はファイルを維持する。再送時には新しいIDを振らない。`(hub_id,event_id)`が保存中イベントの重複キー。詳細保持期間を過ぎて削除したイベントを再受信しても、古い観測時刻は最新値/推定基準へ適用しない。

通信停止や5xx/408/429は上限付きバックオフで再試行する。その他の4xx/3xxは設定やスキーマ不整合として停止する。無限フォールバックやデータ自動破棄はしない。

## Web閲覧

`GET /api/state`: 設定済みHub、Hubごとの最新小型snapshot、最新推定、契約設定。Hub秘密情報は含まない。

`GET /api/history?contract=id`: その契約の最新90観測日の最新判定と最後の有効推定。

`GET /api/live`: 同一originのWebSocket Upgrade。Access JWTを検証後に接続。`ready`と`updated`は再取得通知で、履歴イベントログではない。ping/pongはWebSocket Hibernationの自動応答を使う。[S1]

`GET /api/health`: 秘密情報を含まない固定ヘルス情報。DB/Hubの疎通を保証しない。

## 時刻と欠測

観測時刻はHubの`at`、受信時刻はCollectorのUTC時刻。サーバーは保存時にISO文字列をミリ秒単位へ正規化する。未来5分超の値を拒否する。SSEの切断履歴そのものを別テーブルへは書かないが、streamIdの変化を保持して推定区間を分離する。画面のライブ接続表示はブラウザー↔Analyticsだけの状態であり、Collectorの生存確認ではない。
