# アーキテクチャ

## 実行形態

```text
Hub A ── HTTPS SSE ──┐
Hub B ── HTTPS SSE ──┤
                     ▼
             Node.js Analytics 1プロセス
             ├─ Hub購読・再接続・履歴取得
             ├─ SQLite 1つ / 同期writer 1つ
             ├─ 管理HTTPと閲覧HTTP 1 listener
             └─ ブラウザーSSE
```

Node.jsがHubごとのSSE購読、入力の正規化、履歴取得、Hub管理、推定、SQLite保存、HTTP配信を担当します。ブラウザーを閉じてもHub購読は続きます。通常時に常駐する別プロセス、内部HTTP、outbox、ACK、追加のDBやキューはありません。Web更新時だけ`tools/update-runner.mjs`をoneshot serviceとして動かしますが、runnerは収集とDB書込みを行いません。

## SQLite境界

`analytics/runtime/sqlite.mjs`はNodeのnative `DatabaseSync`を開き、WAL、`synchronous=FULL`、外部キー、migration checksumを設定します。同期statementを直接呼び出し、`bind()`互換層やPromise DB wrapperは使いません。transaction helperは`BEGIN IMMEDIATE`、同期callback、COMMITまたはROLLBACKだけを扱います。

観測のtransactionは基準値の読取り、観測保存、Hub最新値、契約state、日次推定を一単位にします。履歴snapshotのtransactionは完全検証済みの端末履歴、source状態、取得状態を一単位にします。履歴行のupsert statementはtransaction単位で再利用します。ネットワーク、JSON受信、SecretファイルI/Oはtransaction外です。

保存がCOMMITする前にブラウザー通知や収集成功を返しません。COMMIT後に`LiveFeed`へ再取得通知を送り、通知が失われてもSQLiteを再読込みすれば復旧できます。SQLite保存不能は全体の永続化障害として収集を止めます。

## Hub購読

`analytics/runtime/collection/`のmanagerがHubごとにAbortController、購読世代、終了待ちを持ちます。`event: snapshot`と`event: stats`のデータだけを`compactHubEvent`で許可リストへ正規化し、`Observation`を同期保存へ渡します。SSE parserはBOM、UTF-8チャンク分割、LF/CRLF/CR、複数data行、コメントheartbeat、未知イベント、不完全EOF、8 MiB上限を扱います。

Hub URLはHTTPS originに限定し、loopback開発時だけHTTPを許可します。Hub SecretはBearer headerだけに設定し、URL、レスポンス、例外、ログへ出しません。接続断と5xx/408/429はjitter付き指数backoff、恒常的な認証・入力エラーは当該Hubだけ停止します。古い購読世代の保存callbackは管理変更後に破棄します。

## 設定と管理

起動設定`analytics.json`にはlistener、SQLite、Secretファイル、閲覧認証、保持期間、timezone、契約、更新設定を置きます。Hub行はSQLiteの`hubs`が正本で、Secret値は`hub-secrets.json`だけに保存します。Secret変更は新しいopaque参照を安全に保存し、DB COMMIT後に購読世代を切り替えます。保存済みSecretや内部パスをUI/APIへ返しません。

listenerは常に1つです。loopback/Basicでは選択したloopback addressを使い、Tailscale modeでは専用Tailscale IPv4だけをbindします。管理API、state、health、history、browser SSE、静的配信は同じlistenerです。別のingest listenerやCollector status endpointはありません。

## 履歴補完

停止・起動・再接続・Hubの履歴revision通知・手動要求を契機に、認証付き`GET /api/devices`を取得します。これはSSEの代替pollingではありません。1 Hubにつき1件を直列化し、取得中の変更はdirty状態として次の取得へまとめます。応答全体を検証してから、端末別`usage_sources`と日/月別`usage_periods`をupsertします。端末削除はsourceをdeletedにしますが、過去行は明示的な履歴として保持します。

## 更新と配置

発行物は`tools/release.mjs`のallowlistから作るAnalytics runtime、静的資産、migration、設定例、systemd unit、更新runnerだけを含みます。開発checkout、Hub submodule、秘密、DB、旧構成は含めません。更新runnerはcandidate SHA、release identity、deployment lock、バックアップ、サービス再起動を管理し、同一content/configurationなら再起動しません。初回の旧環境切替は通常publishから分離した#27の移行CLIで行います。
