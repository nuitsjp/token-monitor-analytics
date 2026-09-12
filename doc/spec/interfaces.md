# Hub インターフェース仕様（調査事実）

本書は、Token Monitor Hub が公開する参照 API、SSE 通知、返却データの意味と制約、および調査根拠に関する正本です。本システムで採用する動作仕様は [機能仕様](functional-spec.md)、アーキテクチャ構造・保存境界は [設計書](../../docs/architecture.md) を参照してください。

本書の内容は上流の調査基準版に基づく事実の記録です。後続リビジョンとの互換性検証は [PLAN.md U1](../../PLAN.md#u1) で追跡します。

## 1. 調査根拠

上流リポジトリ [Token Monitor](https://github.com/Javis603/token-monitor) の基準コミット [`2f60827e3028d283969dd74cde5b3f5664220442`](https://github.com/Javis603/token-monitor/commit/2f60827e3028d283969dd74cde5b3f5664220442)（`v0.56.0`）のソースコード、および稼働中の Private Hub（Cloudflare Worker 実装、`coreRevision: 36`、`runtimeRevision: 3`）の参照 API 応答を確認しました。実データ資料は [Private Hub 実データ資料](../../docs/reference/hub-private/README.md) に保存しています。

| 根拠資料 | 主な確認内容 |
| --- | --- |
| [API 仕様書](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/docs/API.md) | 認証方式、ヘルスチェック、データ投入・集計仕様、契約情報 |
| [Node Hub 実装](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/hub/server.js) | `getStats`, `getDevices`, `getHistory`, SSE 配信、リクエスト処理 |
| [Worker Hub 実装](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/worker/src/index.js) | Durable Object による永続化・集計、SSE 配信、公開統計 |
| [利用実績の集計](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/usage.js) | 端末レコードの正規化・マージ、セッション集約、履歴集計 |
| [履歴処理](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/history.js) | 履歴データの正規化、プレビュー生成、履歴リビジョン管理 |
| [利用枠の正規化](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/limits/core.js) | 枠ウィンドウの正規化、プロバイダー別集約 |
| [利用枠の収集状態](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/limits/runtime.js) | 最終成功値と最新試行状態の分離管理 |
| [Claude プロバイダー](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/providers/claude/limits.js) / [Codex プロバイダー](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/providers/codex/limits.js) | プロバイダー別の利用枠生成 |
| [収集処理](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/collector.js) / [リセット境界の更新](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/limits/resetBoundary.js) | 収集処理とリセット境界の更新 |

※ Private Hub のサンプルは単発取得の応答であり、継続接続や複数 API 間の一貫性を保証するものではありません。

<a id="hub-api"></a>
## 2. Hub API 経路・用途・認証

| 経路 | 認証 | 返却内容と用途 | 調査上の制約 |
| --- | --- | --- | --- |
| `GET /api/health` | 不要 | `runtime`、`version`、`hubBuild`、`secretRequired` などの稼働・ビルド情報 | `version` は製品リリース番号ではなく、`hubBuild` は登録ソース識別子であり履歴カーソルではない |
| `GET /api/stats` | 保護対象 | 全端末の期間集計、端末別実績・利用枠、集約利用枠、履歴プレビュー（調査・診断用） | 集計スナップショットであり、利用イベント一覧ではない。推定入力の SSE を代替しない |
| `GET /api/stats/stream` | 保護対象 | 接続時の `snapshot` と以後の `stats` を SSE で配信する集計スナップショット（現在値表示と推定に使用） | SSE 本体に保持履歴は含まれない |
| `GET /api/devices` | 保護対象 | 保持端末レコードの一覧（`periods`、`limits`、任意の `history` を含み、日次・月次の収集・補完に使用） | 端末別の保持履歴を取得する主経路。応答全体を取得する |
| `GET /api/history` | 保護対象 | 端末を合算した `daily`、`monthly`、`summary` | 端末別・契約別の補完には適さず、初期版では使用しない |
| `GET /api/subscriptions` | 保護対象 | Hub 内で共有される手入力の契約・支払情報 | 実績との確実な帰属を証明しないため、初期版では利用しない |

保護経路には共有シークレットを `Authorization: Bearer <secret>` または `X-Token-Monitor-Secret: <secret>` ヘッダーで送信します（URL クエリへは含めない）。シークレット未設定時の上流挙動は、Node Hub ではループバックにバインドして認証なし、Worker Hub では保護経路を HTTP 503 で拒否する構成でした。公開統計 `/api/public/stats` は識別情報が不足するため利用しません（Private Hub の単発取得では HTTP 404）。

<a id="observation-fields"></a>
## 3. SSE と累積実績

### 3.1 SSE の通知

`/api/stats/stream` は、接続時に `snapshot`、以後に `stats` イベントを送信します。イベントの JSON は `{ type, reason, stats, at }` の構造を持つ集計スナップショットです。

`at` や `updatedAt` は集計・応答・更新試行の時刻であり、利用発生時刻や単調増加するバージョン番号ではありません。GET と SSE に共通の順序番号はなく、到着順のみで新旧を判定することはできません。SSE には 30 秒間隔のコメント形式 heartbeat が含まれますが、`id`、`retry`、`Last-Event-ID` による再送機能や履歴カーソルはありません。再接続時に得られるのは、その時点のスナップショットとなります。

### 3.2 実績とカレンダー境界

- `stats.periods.today`、`month`、`allTime` は各期間の累積集計値です（SSE の受信回数ごとに加算しない）。
- 端末の `periodWindows` は期間キー、終了時刻、端末側タイムゾーンを表すカレンダー境界であり、利用枠の `resetsAt` が示す枠境界とは独立しています。
- Hub の集約処理では、カレンダー境界を過ぎた端末の `today` / `month` を集計から除外し、`allTime` は維持します。したがって、集約額の減少のみをもって利用枠のリセットとは判定できません。
- 実績データにはツール・セッション・モデル等の内訳が含まれますが、`accountKey` や契約 ID は保持されません。

<a id="limit-fields"></a>
## 4. 利用枠の値・更新状態

`limits.providers[]` は、プロバイダー名、`accountKey`、表示用アカウント名・プラン名、`status`、`source`、`updatedAt`、`windows[]` などの項目を持ちます。主な項目と更新時の挙動は以下のとおりです。

| 項目・挙動 | 調査で確認した意味・制約 |
| --- | --- |
| `limitsOnly` | 利用枠のみを更新する処理。実績値を維持したまま端末の `updatedAt` / `receivedAt` が更新されるため、同一レコード内でも同一時点の測定とは限らない |
| `status` / `updatedAt` | 利用枠の更新試行状態と時刻（利用発生時刻や測定時刻とは限らない） |
| `stale` | `stale: false` のみでは鮮度や観測成功を保証しない |
| 一時エラー | 直前の成功値を残したまま `status` を更新する場合がある。値の存在のみをもって成功の証拠としない |
| 集約利用枠 | 同一キーの候補から鮮度や状態に基づき代表値を選定した値（複数端末の消費率や枠を単純合算したものではない） |
| `accountKey` | 上流が独自生成するアカウント識別子であり、公式の契約 ID ではない（プロバイダー間で共通の永続性も保証されない） |
| `kind` / `limitId` / `additional` | 枠識別の補助情報（単独項目での一意性は保証されない。Claude では同一 `kind` にモデル別枠、Codex では同一 `limitId` に期間別枠が併存しうる） |
| `usedPercent` | 0〜100 に正規化された消費率（未取得・非提供時は `null` であり、ゼロや推測値で補完しない） |
| `resetsAt` / `windowMinutes` | 予定される枠の境界時刻と期間長（リセット発生通知や利用発生時刻ではない） |
| `boundaryKind` / `showMeter` | リセット以外の失効・残高型の境界や、割合メーターを表示しない枠が存在することを示す補助情報 |

調査した Claude ではアカウント ID・組織 ID・メールアドレスから `accountKey` を生成しており、同一アカウント ID 内での組織切替がキーへ反映されない場合があります。また Codex ではメールアドレスとワークスペースのアカウント ID からキーを生成します。これだけではアカウントキーを契約 ID として代用する根拠にはなりません。

<a id="history"></a>
## 5. 保持履歴

- 標準の保持範囲は直近 370 日の日別集計です。履歴 GET は保持中の全履歴を一括で返却し、期間指定、ページング、過去時点の利用枠履歴取得の機能はありません。
- `historyRevision` は変更検出用のハッシュ値であり、単調増加する版番号や SSE の再送カーソルとしては扱えません。
- `historyAvailable: true` であっても履歴配列が空の場合があり、端末更新日時が新しくても保持履歴が古いまま残る場合があります。
- 日次履歴は送信元の現地暦日と数値による集計であり、利用時刻の明細やタイムゾーン情報を持ちません（保存・表示規則は [機能仕様 第3節](functional-spec.md#history) 参照）。
- `/api/history` は端末合算の履歴であり、端末別・契約別の補完には使用しません（`/api/devices` の端末別 `history` を使用）。

## 6. 保存・配信の制約事項

上流のデータ保存と SSE 配信には、以下の制約があります。

- Node Hub はメモリ上の変更を JSON ファイルへ保存した後に SSE を配信しますが、保存失敗時にメモリ状態をロールバックしません。
- Worker Hub は Durable Object への永続化後に配信を行いますが、クライアントまでのイベント到達は保証しません。
- 上流には受信完了を確認する応答プロトコルがないため、本システム側で保存確定と画面通知の順序制御を行います（設計詳細は [アーキテクチャ設計書 第5節](../../docs/architecture.md#crosscutting) 参照）。
- 取得した参照 API のデータは Hub 内部ストレージ全体のバックアップではなく、Hub が保持していない履歴や過去の利用枠観測は復元できません。

観測の採用・推定可否の判定は [機能仕様](functional-spec.md#observation-validity)、識別・保存単位は [設計書](../../docs/architecture.md#identity) を参照してください。未決の対応関係や比較再開の判断は [PLAN.md U2](../../PLAN.md#u2)〜[U6](../../PLAN.md#u6) で追跡します。
