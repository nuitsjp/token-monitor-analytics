# Hub インターフェース仕様（調査事実）

本書は、Token Monitor Hub が公開する参照 API、SSE 通知、返却データの意味と制約、および調査根拠に関する正本です。本システムで採用する動作仕様は [機能仕様](functional-spec.md)、アーキテクチャ構造・保存境界は [設計書](../../docs/architecture.md) を参照してください。

本書は上流の調査基準版に基づく事実と、実 Hub で明示的に確認した範囲を記録します。後続リビジョンとの互換性検証は [PLAN.md U1](../../PLAN.md#u1) で追跡します。

## 1. 調査根拠

上流リポジトリ [Token Monitor](https://github.com/Javis603/token-monitor) の基準コミット [`2f60827e3028d283969dd74cde5b3f5664220442`](https://github.com/Javis603/token-monitor/commit/2f60827e3028d283969dd74cde5b3f5664220442)（`v0.56.0`）のソースコード、および稼働中の Private Hub（Cloudflare Worker 実装、`coreRevision: 36`、`runtimeRevision: 3`）の参照 API 応答を確認しました。実データ資料は [Private Hub 実データ資料](../../docs/reference/hub-private/README.md) に保存しています。

比較対象 `c4182fd5` までの4コミット・42ファイルを2026-09-14に静的照合しました。HubのAPI実装、利用実績・履歴の正規化、共有利用枠処理とAPI仕様書は変更ありません。収集側のカスタムスキャンパス、セッションの日時・プロジェクト情報の補完、`clientHealth` のチェックID追加は、Analyticsの `src/observations.js` が既に受理する型・項目です。API・アカウント識別・履歴・利用枠に修正が必要な不互換は見つかりませんでした。旧版・新版Hubを切り替える相互運用試験と上流全テストは未実施であり、この結果はソース差分の確認範囲に限ります。

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

### 2026-09-13 の実 Hub 接続確認

現在値機能を使って以下の2 Hubへ同時に接続しました。`/api/health` は両方とも HTTP 200、`runtime` は `cloudflare-worker`、`hubBuild.coreRevision` は36、`runtimeRevision` は3でした。

| 登録 ID | 接続先 | 受信した端末数 |
| --- | --- | ---: |
| `private` | `https://private.token-monitor-hub-private.workers.dev` | 2 |
| `work` | `https://work.token-monitor-hub-work.workers.dev` | 5 |

両方の `coreBuildId` は `sha256:e19784d3e95b07d617b10bec1c38eb54d6cc5984c395e0366351a78d96b89153`、`runtimeBuildId` は `sha256:7b98c4a6209c258ceac7ecc781cf6b9c0f9e803b0b5716a533fa1dafec954ad9` でした。シークレットはこの記録に含めません。

実際の SSE を現在の入力検証で受理して保存でき、接続後も両 Hub の受信日時がそれぞれ前進することを確認しました。これは今回の現在値経路の確認であり、全 API の互換性や長時間接続を保証するものではありません。実装と画面の確認結果は [設計書 第9節](../../docs/architecture.md#quality-and-risks)、残る実機検証は [U1](../../PLAN.md#u1) に記録します。

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

固定版 `2f60827e` の実装で確認した日時・鮮度項目の区別は以下のとおりです。Analytics 自身の受信完了時刻は Hub の返却項目ではなく、Analytics 側で付与します。

| 項目 | 確認した意味と根拠 |
| --- | --- |
| SSE 外側の `at`、`stats.updatedAt` | 配信・集計の生成時刻。同じ端末データの再配信でも変わり得る（`src/hub/server.js:89–92,217`、`src/shared/usage.js:1380–1381`） |
| `stats.devices[].updatedAt` | 端末レコードの更新時刻を投影した値。利用枠だけの更新でも進むため、利用実績の測定成功時刻とは限らない（`src/shared/usage.js:913–920,1399`、第4節の `limitsOnly`） |
| `stats.devices[].clientHealth.observedAt` | 端末の利用実績全体を収集した時刻。`limitsOnly` では実績とともに以前の値を保持する（`src/shared/usage.js:1135–1154`）。ツール別の成功時刻がない場合の既存取得時刻として使用できる |
| `stats.devices[].clientHealth.clients[tool].collection.lastSuccessAt` | 対象ツールの収集が最後に成功した時刻。提供されている場合は `clientHealth.observedAt` より直接的なツール別利用実績の収集時刻となる |
| `stats.devices[].receivedAt`、`ageMs`、`stale` | Hub における端末報告の受信時刻と、それに基づく鮮度情報。Analytics の受信時刻とは異なる（`src/hub/server.js:113`、`src/shared/usage.js:1400–1402`） |
| `stats.devices[].limits.updatedAt` | 端末側の利用枠サマリーを再構築した時刻（`src/shared/limits/runtime.js:334–340`、`src/shared/limits/core.js:519–525`） |
| `stats.devices[].limits.providers[].updatedAt` | プロバイダー行に保持された更新試行時刻。失敗時にも前回の成功値が残る場合がある（`src/shared/limits/core.js:504`、`src/shared/limits/runtime.js:312–326,518–544`） |
| `stats.limits.updatedAt` | Hub 全体の利用枠集約を生成した時刻（`src/shared/limits/core.js:916–917`） |

この確認は固定版ソースの調査であり、現行 Hub との互換性や再配信時の実測確認は [U1](../../PLAN.md#u1) の検証対象です。

### 3.2 実績とカレンダー境界

- `stats.periods.today`、`month`、`allTime` は各期間の累積集計値です（SSE の受信回数ごとに加算しない）。
- 端末の `periodWindows` は期間キー、終了時刻、端末側タイムゾーンを表すカレンダー境界であり、利用枠の `resetsAt` が示す枠境界とは独立しています。
- Hub の集約処理では、カレンダー境界を過ぎた端末の `today` / `month` を集計から除外し、`allTime` は維持します。したがって、集約額の減少のみをもって利用枠のリセットとは判定できません。
- 実績データにはツール・セッション・モデル等の内訳が含まれますが、実績の各明細へ `accountKey` や契約 ID は付与されません。利用枠側の `accountKey` と実績の対応は Analytics 側で観測関係として扱います。

### 3.2.1 Cursorの利用実績範囲（2026-09-13追加調査）

Token Monitor が依存する Tokscale v4.16.0 の `cursor.rs` では、Cursorの `get-filtered-usage-events` を端末やローカルセッションで絞り込まず、同期済みアカウント全体の利用イベントとして取得します。Token Monitor側も `src/shared/collector.js:1111` からCursor同期を実行し、`src/shared/providers/cursor/auth.js:403–408` では `tokscale cursor sync --json` を呼び出します。したがって、同じCursorアカウントを使う複数端末は同じアカウント全体実績をそれぞれHubへ報告し得ます。

Token Monitorの `src/shared/usage.js:822–828` は、期間内のトークン数または費用が正の場合だけ `clients[client]`・`clientCosts[client]` の内訳を追加します。当日未使用のCursorでは、Hubの期間合計が有効でもCursor内訳が未提供になり得ます。これは数値0を明示した観測ではないため、Analyticsは内訳の欠落を0へ変換せず、提供済みのHub合計を維持します。

この調査から、Cursorの `clientCosts.cursor` と `clients.cursor` は端末別利用額として加算できません。同じ観測上の契約ID集合を持つ報告は一つのアカウント全体実績として扱う必要があります。他ツールについては、現時点でこのCursor固有の取得経路は確認されておらず、端末単位の利用実績として扱います。Analyticsでの重複除去、競合・部分重複の扱いは [機能仕様 第1.5節](functional-spec.md#15-利用額契約集合利用枠の対応) を正本とします。

### 3.3 アカウント切替時の契約帰属の制約

2026-09-13 に固定版 `2f60827e` の次の処理を確認しました。

- [収集処理](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/collector.js#L420-L427) は Tokscale の集計軸を `client,session,model` とし、[セッションの構造](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/usage.js#L475-L495) にアカウントや契約の識別子はありません。上流の[契約表示処理の説明](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/worker/src/shared/subscriptionDisplay.js#L605-L612) にも、複数の Codex ログインの利用分が `month.clientCosts['codex']` に合流し、月中の切替を識別できないことが明記されています。
- [利用枠のみの更新](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/usage.js#L1144-L1154) は保存済みの `periods` を引き継ぎます。利用枠の現在のアカウント情報と、実績を構成したアカウントとの対応関係は付与しません。
- [定期収集](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/collector.js#L3490-L3507) は、ファイル監視で取り逃した更新や新規ディレクトリ等を後の全走査で回収します。従って、切替前に発生した利用分が切替後の累積額増分へ遅れて現れる可能性を、API の取得値だけから排除できません。

この制約から、利用枠側の `accountKey` が変わった区間を除外するだけでは、その後の利用額増分が新しい契約のみに属することを証明できません。これは個別契約への金額帰属の制約であり、共有利用額からの推定全体が不可能であることを意味しません。採用する共有利用額の計算式は [機能仕様 第1.2節](functional-spec.md#12-計算式と成立条件)、契約集合との対応規則は機能仕様第1.5節に従います。

### 3.4 ツール・アカウント・プランの対応に使える項目

2026-09-13 に固定版の追加調査を行いました。上流 HEAD `8b6cee22` との関係箇所の差分は、当時の個別調査対象外のクライアントの追加でした。以下の調査範囲は、現行の共通推定におけるサービス名の制限を意味しません。

- [共通のプロバイダーID](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/limitProviders.js#L67-L92) は client/provider の対応を定義し、codex・claude・grok・cursor・copilot・antigravity は同じIDを使います。
- [API仕様](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/docs/API.md#L307-L310) は `accountKey` を端末間のアカウント重複除去に使う識別子として説明しています。Codex は取得経路によってメールとワークスペースアカウントIDをキーに含めます（`src/shared/providers/codex/limits.js:1155–1176`）。全経路で公式契約IDと等価とは保証されません。Analyticsでの観測上の契約キーの共通採用規則とGrokのメールによる例外は、機能仕様第1.5節に定義します。
- 現行 [Codexのプラン生成](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/providers/codex/limits.js#L458-L482) は `planType` 等から `codexAccountLabel` を作り、`accountLabel` に格納します（同ファイル `521–550,1295–1304`）。Private・Work の実データでも `planLabel` が空で、`accountLabel` に Plus・Pro 5x 等を確認しました。名称からの倍率推測を意味しません。
- `clientHealth.clients[tool]` の source/collection/overall は収集状態です。`clientStatus` の active/waiting/missing は過去の利用活動やソース有無に由来し、それだけで収集成功とは判断できません。
- Antigravityの一部キーは匿名RPC由来で端末間の同一性を保証せず、窓もモデル別プールの名前を `label` に格納します。同じ kind・期間長だけでは同一の利用範囲と判断できません（`src/shared/providers/antigravity/limits.js:26–60`）。

これらは取得項目の意味の調査結果です。採用対象と推定停止条件は機能仕様第1.5〜1.6節に定義します。

### 3.5 Hub横断同一性の確認範囲（2026-09-13）

今回の実GETでは、Private の `home-main`、Work の `zrfg050641`・`zrfg066335` において、CodexのPro 5x行の `accountKey` が一致することを確認しました。これは同じプロバイダーとアカウントキーを複数Hubの利用枠が共有している実例であり、共通契約の推定対象に採用する根拠です。

同日の両Hubの全7端末ではHubをまたぐ `deviceId` の重複はありませんでした。当日・当月の返却セッションにもHub間の重複はありませんでした。ただし、この確認だけではツール側の収集範囲を判定できません。後続調査でCursorはアカウント全体実績と確認したため、CursorをHub・端末・ツール単位で加算する根拠には使いません。他ツールは端末単位として扱います。また `allTime` に利用明細が返らないため、全期間の利用額がこの確認対象だけで契約へ完全に帰属することは証明できません。

上流の [Codex認証情報生成](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/providers/codex/auth.js#L14) と [Codex利用枠生成](https://github.com/Javis603/token-monitor/blob/2f60827e3028d283969dd74cde5b3f5664220442/src/shared/providers/codex/limits.js#L1155-L1176) は、Hubの識別子をキーへ含めない構造です。一方、`accountKey` は上流生成値であり、公式契約IDとの等価性や全取得経路での同一性は保証されません。この実GETの検証事実はCodexの確認例に限られます。現行の共通推定では、利用者の2026-09-13指示に基づき、サービスごとの実契約検証を適用の前提にしません。取得項目による採否規則は機能仕様第1.5節を参照してください。

### 3.6 Grokの契約識別項目（2026-09-13）

Grokの利用枠には既存の `accountEmail` を使用できます。上流の `providers/grok/limits.js` は、認証ファイルの任意のメールアドレスを読み取り（59〜70行）、利用枠の応答へ含めます（714〜716行、771〜774行）。同じ箇所で `accountKey` を認証トークンのハッシュから生成するため、認証情報の更新によってキーが変わり得ます。メールアドレスは公式の不変な契約IDではありません。

Hubが配信するプロバイダー行には、現在の正常な行に加え、古いキーと利用枠を保持した `unavailable` 行が残る場合があります。上流の `limits/runtime.js` は前回成功値を失敗状態とともに返します（312〜329行）。今回の実Hubでも同じメールアドレスに複数のキーを確認しました。

Analytics側での同一メールの契約対応、現在・過去の判定、メール欠落時の扱いは [機能仕様 第1.5節](functional-spec.md#15-利用額契約集合利用枠の対応) に従います。Hubおよび端末側の収集プログラムは変更しません。Grokにも他サービスと同じ推定処理を適用します。

<a id="limit-fields"></a>
## 4. 利用枠の値・更新状態

`limits.providers[]` は、プロバイダー名、`accountKey`、`accountEmail`、表示用アカウント名・プラン名、`status`、`source`、`updatedAt`、`windows[]` などの項目を持ちます。主な項目と更新時の挙動は以下のとおりです。

| 項目・挙動 | 調査で確認した意味・制約 |
| --- | --- |
| `limitsOnly` | 利用枠のみを更新する処理。実績値を維持したまま端末の `updatedAt` / `receivedAt` が更新されるため、同一レコード内でも同一時点の測定とは限らない |
| `status` / `updatedAt` | 利用枠の更新試行状態と時刻（利用発生時刻や測定時刻とは限らない） |
| `stale` | `stale: false` のみでは鮮度や観測成功を保証しない |
| 一時エラー | 直前の成功値を残したまま `status` を更新する場合がある。値の存在のみをもって成功の証拠としない |
| 集約利用枠 | 同一キーの候補から鮮度や状態に基づき代表値を選定した値（複数端末の消費率や枠を単純合算したものではない） |
| `accountKey` | 上流が独自生成するアカウント識別子であり、公式の契約 ID ではない。Analyticsは同じ `provider + accountKey` をHub横断の観測上の契約キーとして扱う。Grokではトークン変更で変わり得るため契約キーに使わず、`accountEmail` を用いる |
| `accountEmail`（Grok） | 前後空白を除去して小文字化した値を `provider=grok` のHub横断契約キーに用いる。欠落時は契約を生成せず、端末の取得情報として保持する |
| `kind` / `limitId` / `additional` | 枠識別の補助情報（単独項目での一意性は保証されない。Claude では同一 `kind` にモデル別枠、Codex では同一 `limitId` に期間別枠が併存しうる） |
| `usedPercent` | 0〜100 に正規化された消費率（未取得・非提供時は `null` であり、ゼロや推測値で補完しない） |
| `remainingPercent` / `used` / `limit` | 残量率、使用量、上限。消費率を直接取得できない場合の正規化に使用する。採用順、範囲、上限変更時の比較境界は機能仕様第1節に定義する |
| `resetsAt` / `windowMinutes` | 予定される枠の境界時刻と期間長（リセット発生通知や利用発生時刻ではない） |
| `boundaryKind` / `showMeter` | リセット以外の失効・残高型の境界や、割合メーターを表示しない枠が存在することを示す補助情報 |

調査した Claude ではアカウント ID・組織 ID・メールアドレスから `accountKey` を生成しており、同一アカウント ID 内での組織切替がキーへ反映されない場合があります。また Codex ではメールアドレスとワークスペースのアカウント ID からキーを生成します。これらの生成規則は公式契約 ID との等価性や全経路での永続性を保証しません。Claudeの組織識別は [Issue #34](https://github.com/nuitsjp/token-monitor-analytics/issues/34) で追跡し、現行の共通推定の適用は妨げません。Grokの契約は、トークンの `accountKey` 変更をまたいで正規化した `accountEmail` へ対応付けます（第3.6節）。

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
