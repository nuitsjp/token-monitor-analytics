# Hub インターフェース仕様（調査事実）

本書は、Token Monitor Hub が公開する参照 API、SSE 通知、返却データの意味と制約、調査根拠の正本です。Analytics が採用する動作は [機能仕様](functional-spec.md)、構造・保存境界は [設計書](../../docs/architecture.md) を参照します。

以下は旧文書に記録された調査基準版の事実を移管したもので、今回の文書統合で現行上流を再検証したものではありません。文書の比較対象版 `c4182fd5bcdcd466f6bcd159026756323e084318` との互換性は未検証であり、[PLAN.md U1](../../PLAN.md#u1) で追跡します。

## 1. 調査根拠

- [旧アーキテクチャ設計書](../../old/docs/architecture.md) の第1〜2節および第5.1〜5.2節。調査基準は上流コミット `2f60827e3028d283969dd74cde5b3f5664220442`（`v0.56.0`）です。
- [Private Hub 単発取得ログ](../../old/docs/reference/hub-private/README.md)。取得日は 2026-09-12、Worker の `coreRevision: 36`、`runtimeRevision: 3` です。取得した参照 API の本文は、現行 Hub の継続取得や一貫したスナップショットを証明しません。
- 調査対象は上流の API 仕様、Node Hub、Worker Hub、実績集計、履歴、利用枠正規化・収集状態、Claude・Codex プロバイダー、収集処理とリセット境界です。対応するソースの一覧は旧設計書 第1節にあり、上記基準コミットの内容を根拠とします。

<a id="hub-api"></a>
## 2. Hub API 経路・用途・認証

| 経路 | 認証 | 返却内容と用途 | 調査上の制約 |
| --- | --- | --- | --- |
| `GET /api/health` | 不要 | `runtime`、`version`、`hubBuild`、`secretRequired` などの稼働・ビルド情報 | `version` は製品リリース番号ではなく、`hubBuild` は登録ソース識別子であり履歴カーソルではない |
| `GET /api/stats` | 保護対象 | 全端末の期間集計、端末別実績・利用枠、集約利用枠、履歴プレビュー。調査・診断用 | 集計スナップショットであり、利用イベント一覧ではない。推定入力の SSE を置き換えない |
| `GET /api/stats/stream` | 保護対象 | 接続時の `snapshot` と以後の `stats` を SSE で配信する集計スナップショット。現在値表示と推定に使用 | SSE 本体に保持履歴は含まれない |
| `GET /api/devices` | 保護対象 | 保持端末レコードの一覧。`periods`、`limits`、任意の `history` を含み、日次・月次の収集・補完に使用 | 端末別の保持履歴を取得する主経路。応答全体を取得する |
| `GET /api/history` | 保護対象 | 端末を合算した `daily`、`monthly`、`summary` | 端末別・契約別の補完には適さず、初期版では使用しない |
| `GET /api/subscriptions` | 保護対象 | Hub 内で共有される手入力の契約・支払情報 | 実績との確実な帰属を証明しないため、初期版では利用しない |

保護経路には共有シークレットを `Authorization: Bearer <secret>` または `X-Token-Monitor-Secret: <secret>` ヘッダーで送信します。URL クエリへシークレットを含めません。シークレット未設定時の上流挙動は、調査した Node Hub ではループバックにバインドして認証なし、Worker Hub では保護経路を HTTP 503 で拒否するものでした。公開統計 `/api/public/stats` は識別情報が不足するため利用せず、Private Hub の単発取得では HTTP 404 でした。

<a id="observation-fields"></a>
## 3. SSE と累積実績

### 3.1 SSE の通知

`/api/stats/stream` は、接続時に `snapshot`、以後に `stats` のイベントを送ります。イベントの JSON は `{ type, reason, stats, at }` の形で集計スナップショットを含みます。

`at` や `updatedAt` は集計・応答・更新試行の時刻であり、利用発生時刻や単調増加する版番号ではありません。GET と SSE の共通の順序番号はなく、到着順だけで新旧を判定しません。SSE には 30 秒間隔のコメント形式 heartbeat がありますが、`id`、`retry`、`Last-Event-ID` による再送や履歴カーソルはありません。再接続で得られるのは、その時点のスナップショットです。

### 3.2 実績とカレンダー境界

- `stats.periods.today`、`month`、`allTime` は各期間の累積集計値です。`costUsd` などを SSE の受信回数ごとに加算しません。
- 端末の `periodWindows` は期間キー、終了時刻、端末側タイムゾーンを表すカレンダー境界です。利用枠の `resetsAt` が示す枠境界とは別です。
- Hub の集約では、カレンダー境界を過ぎた端末の `today` / `month` を集計から除外し、`allTime` は維持します。したがって、集約額の減少だけを利用枠のリセットとは判定しません。
- 実績にはツール・セッション・モデル等の内訳がありますが、`accountKey` や契約 ID を保持しません。

利用許容量の推定可否、観測の有効性、および計算区間は [機能仕様の観測有効性](functional-spec.md#observation-validity) と [推定仕様](functional-spec.md#estimation) に定めます。本書では重複して定義しません。

<a id="limit-fields"></a>
## 4. 利用枠の値・更新状態

`limits.providers[]` は、プロバイダー名、`accountKey`、表示用アカウント名・プラン名、`status`、`source`、`updatedAt`、`windows[]` などを持ちます。利用枠の主な項目と更新時の挙動は次のとおりです。

| 項目・挙動 | 調査で確認した意味・制約 |
| --- | --- |
| `limitsOnly` | 利用枠だけを更新する処理。実績値を維持したまま端末の `updatedAt` / `receivedAt` が更新されるため、実績と利用枠が同じレコード内にあっても同一時点の測定とは限らない |
| `status` / `updatedAt` | 利用枠の更新試行の状態と時刻。利用発生時刻や測定時刻とは限らない |
| `stale` | `stale: false` だけでは鮮度や観測成功を保証しない |
| 一時エラー | 直前の成功値を残したまま `status` を更新する場合がある。値が存在することだけを成功の証拠にしない |
| 集約利用枠 | 同一キーの候補から鮮度や状態に基づき代表値を選ぶ。複数端末の消費率や枠を単純合算した値ではない |
| `accountKey` | 上流が生成するアカウント識別子であり、公式の契約 ID ではない。プロバイダー間で共通の永続性も保証されない |
| `kind` / `limitId` / `additional` | 枠識別の補助情報。単独項目での一意性は保証されない。Claude では同じ `kind` にモデル別枠、Codex では同じ `limitId` に短時間枠・長時間枠が併存し得る |
| `usedPercent` | 0〜100 に正規化された消費率。未取得・提供されない場合は `null` であり、ゼロや推測値で補わない |
| `resetsAt` / `windowMinutes` | 予定される枠の境界時刻と期間長。リセット発生通知や利用発生時刻ではない |
| `boundaryKind` / `showMeter` | リセット以外の失効・残高型の境界や、割合メーターを表示しない枠が存在することを示す補助情報 |

調査した Claude ではアカウント ID・組織 ID・メールアドレスから `accountKey` を生成し、同一アカウント ID の組織切替がキーへ反映されない場合があります。Codex ではメールアドレスとワークスペースのアカウント ID からキーを生成します。アカウントキーを契約 ID として代用する根拠にはなりません。

<a id="history"></a>
## 5. 保持履歴

- 標準の保持範囲は直近 370 日の日別集計です。履歴 GET は保持中の全履歴を一括で返し、期間指定・ページング・過去時点の利用枠履歴取得はありません。
- `historyRevision` は変更検出用のハッシュ値です。単調増加する版番号や SSE の再送カーソルとして扱いません。
- `historyAvailable: true` でも履歴配列が空の場合があり、端末の更新日時が新しくても保持履歴が古いまま残る場合があります。
- 日次履歴は送信元の現地暦日と数値による集計で、利用時刻の明細およびタイムゾーン情報を持ちません。保存・日付・合算表示の規則は [機能仕様 第3節](functional-spec.md#history) を参照します。
- `/api/history` は端末合算の履歴であり、端末別・契約別の補完に使いません。`/api/devices` の端末別 `history` と現在値 SSE は用途を分けます。

## 6. 保存・配信の限界

上流の保存と SSE 配信には、次の限界があります。

- Node Hub はメモリ上の変更を JSON ファイルへ保存した後に SSE を配信しますが、保存失敗時にメモリ状態をロールバックしません。
- Worker Hub は Durable Object への永続化後に配信しますが、Analytics までイベントが到達することは保証しません。
- 上流には Analytics が受信完了を確認する仕組みがないため、Analytics 側で保存の確定と画面通知の順序を制御します。Analytics の保存・通知設計は [現行アーキテクチャ §5](../../docs/architecture.md#crosscutting) を参照してください。
- Private Hub の単発取得では各 GET を独立に並行実行しており、保存されたファイル群は単一トランザクションのスナップショットではありません。取得時刻と各端末・利用枠の更新時刻も異なります。
- 取得した参照 API の本文は Hub ストレージ全体のバックアップではありません。Hub が保持していない履歴や過去の利用枠観測は復元できず、単発取得の SSE も接続時の最初のイベントだけです。

具体的な観測の採用と推定可否は [機能仕様](functional-spec.md#observation-validity)、識別・保存単位は [設計書](../../docs/architecture.md#identity) を参照します。未決の対応関係や比較再開の判断は [PLAN.md U2](../../PLAN.md#u2)〜[U6](../../PLAN.md#u6) に残ります。
