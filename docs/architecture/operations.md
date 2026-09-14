# 配置と運用の手順

本書は [設計書 第7節](../architecture.md#7-配置と運用-deployment-view) の詳細です。設定ファイルの形、初期設定・起動・終了、別端末からの接続、状態確認と復旧、自動検証と Mock Hub の手順を定めます。

## 設定ファイル

`.env` の待受アドレス・ポートは両モードで共用します。実データモードでは起動・終了担当が `.local/hubs.json` からHub接続設定とトップレベルの共通推定設定を読み込み、S7の入力検証と接続開始へ引き渡します。倍率設定はHub行に置かず、ファイル最上位の `estimation.planMultipliers` に記述します。形は次のとおりです（`windowKey` はUIに表示された正確な枠キーを使用します）。

```json
{
  "hubs": [],
  "estimation": {
    "planMultipliers": [
      { "tool": "codex", "windowKey": "<UIからコピーする正確な枠キー>", "basePlan": "Plus", "plans": { "Plus": 1, "Pro": 5 } }
    ]
  }
}
```

通常の単一契約・同一プラン共有では設定不要で、異なるプランの共有利用額をまとめる場合だけ設定します。旧Hub行の `estimation` は後方互換で読み替えず、存在時は `ConfigurationError('hub_estimation_must_be_top_level')` として起動を中止します。トップレベルの共通設定の形式不正は全体の推定を停止しますが、Hubの接続と観測保存は継続します。設定項目・検証条件・変更反映契機と共有シークレット保存方針は [機能仕様 S7](../../doc/spec/functional-spec.md#s7)、推定の詳細は [機能仕様 第1節](../../doc/spec/functional-spec.md#estimation)、SQLite のHub登録情報との対応は第5.1節に従います。DB は実データ用が `data/real/analytics.sqlite`、Mock 用が `data/mock/analytics.sqlite` です。旧 `data/analytics.sqlite` は今回の分離前データとして保持し、以降の起動では参照しません。分離結果の検証記録は [PLAN.md](../../PLAN.md#mode-separation) を参照してください。

## 初期設定・起動・終了

リポジトリのルートで以下を実行します。

```powershell
npm run setup
```

`.env.example` と `hubs.example.json` から、欠落している `.env` と `.local/hubs.json` だけを作成します。権限設定に失敗した場合はエラーを修正して再実行します。設定項目と変更時の再起動規則は [機能仕様 S7](../../doc/spec/functional-spec.md#s7) に従います。

Hub の設定例は空の `hubs` 配列です。実データを使う場合は `.local/hubs.json` の `hubs` に安定した `id`・Hub のベース URL・共有シークレットを記入し、`mise run real` を実行します。Mock を使う場合は `mise run mock` を実行するだけで Analytics と Mock Hub が起動します。どちらも `.env` の待受先をブラウザで開きます。既定は `http://127.0.0.1:3000` です。

切り替え時は起動したターミナルで Ctrl+C を押して終了を待ち、もう一方のタスクを実行します。二つ目の起動が `RUNTIME_IN_USE` で失敗した場合も同じ手順です。タスク間で設定ファイルを編集する必要はありません。実 Hub の URL・秘密情報を変えても同じ情報源として扱う場合は `id` を維持します。設定本文をターミナルやチャットへ貼り付ける必要はありません。

## 別端末からの接続

`.env` の `ANALYTICS_HOST` を実行 PC の LAN 側 IP に変更し、再起動します。別端末では `http://<LAN側IP>:<ポート>/` を開きます。IP は Windows のネットワーク設定で確認します。受信ファイアウォールの許可が必要な環境では、管理者 PowerShell で次の例を実行します。値は `.env` と合わせ、Private プロファイルの同一サブネットに限定します。

```powershell
New-NetFirewallRule -DisplayName 'Token Monitor Analytics' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress '<LAN側IP>' -LocalPort 3000 -RemoteAddress LocalSubnet -Profile Private
```

同じ PC から LAN 側 IP を開けても、別端末からの到達性を検証したことにはなりません。別端末で画面表示と継続更新、切断後の再接続を確認します。

## 状態確認と復旧

画面は `/`、保存済み現在値・契約・共通推定状態のJSONは `/api/state`、ブラウザ向けSSEは `/api/events` です。`state` は全体の `contracts`、`estimates`、`metrics`、`legacyEstimateCount` と、Hubごとの `contractIds`・`estimateIds`・`metrics` を返します。SSEは接続時と更新時に現在の状態全体を送ります。推定イベント履歴は `GET` または `HEAD /api/estimates/history` から取得できます。`scope=global`（既定）または `scope=legacy` を指定でき、`hubId` は任意、`seriesId`・`before`・`limit` も指定できます。旧方式と共通推定の履歴IDはscopeで分離し、`limit` の既定値は50、結果は新しいイベント順の `items` と `nextCursor` です。入力不正は400、DB参照不能は503を返します。日次・月次実績は `GET` または `HEAD /api/history` から読み出します。条件・複合カーソル・応答は [機能仕様 第3.2節](../../doc/spec/functional-spec.md#32-履歴読み出しapi) に従います。入力検証をDB操作の前に行い、400応答では保存状態を変更しません。DB読み出し失敗は503とし、保存済み表示を保持します。Hubごとの history で取得状態、最終成功日時、再試行予定、端末別の日次判定を通知します。

ログはターミナルと `.local/real.log` または `.local/mock.log` に記録します。設定障害・待受失敗・既存 DB 障害で起動できない場合は、記録された処理と原因を確認し、修正後に同じモードを再起動します。稼働中の保存失敗・DB 参照不能では全 Hub の保存が停止し、画面は保持値を表示します。原因解消後に再起動してください。SQLiteが数値のエラーコードを提供する場合は `sqliteCode` に記録します。DB を削除して復旧させる手順は設けません。ログファイルの書き込み失敗はターミナルへ明示し、保存停止状態の通知を妨げないようにします。

稼働中の状態や履歴の参照にはアプリのHTTP APIを使います。外部のDBツールで長い読み取りトランザクションを保持すると、SQLiteのコミットが競合して保存停止に至る場合があります。DB全件の照合はアプリ停止中、または停止中に作成した検証用複製で行います。

## 自動検証と Mock Hub

`npm test` は `test/*.test.js` のみを実行し、調査用サブモジュールのテストを含めません。テストは一時フォルダーの DB と空きポートの Mock Hub を使い、実運用の設定・DB を変更しません。

`mise run mock` は5秒ごとの通常更新を行います。自動テストでは `startMockHub` の `scenario` 引数により `duplicate`（同一データの再配信）、`invalid`（3回に1回の不正通知）、`disconnect`（3回に1回の切断）も再現できます。Mock Hub 単独の起動コマンドは設けません。
