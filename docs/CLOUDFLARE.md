# Cloudflareへの導入（Windows PowerShell）

**Hub用ではなく、Analytics用アカウントで実施します。** 初期ZIPには実Account IDやD1 IDは含めていません。

## 1. ログイン、アカウント、D1

```powershell
cd C:\src\token-monitor-analytics\analytics
npx wrangler login
npx wrangler whoami
$env:CLOUDFLARE_ACCOUNT_ID = 'ANALYTICS_ACCOUNT_ID'
npx wrangler d1 create token-monitor-analytics
```

表示されたdatabase_idを`wrangler.jsonc`の`d1_databases[0].database_id`へ設定します。`wrangler.local.jsonc`は変更不要です。Account IDは公開可能な識別子ですが、API Tokenは秘密情報です。デプロイ権限を持つAPI TokenをCollectorへ渡してはいけません。

## 2. Hubと契約の定義

`src/settings.ts`の`hubs`をCollectorの`hubs[].id`と一致させます。最初は`contracts: []`で受信と表示だけを確認できます。hub-a、hub-bはAnalytics内の識別子で、Cloudflare Account IDではありません。

## 3. 送信トークンを作る

十分長いランダム値を1つ作り、Worker SecretとUbuntuの環境変数に同じ値を設定します。例えばPowerShellでは以下で生成できます。コマンド履歴に秘密値を直接書かず、出力を安全に保管してください。

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToHexString($bytes)
$token | npx wrangler secret put INGEST_TOKEN --config wrangler.jsonc
```

`$token`はUbuntuの`TMA_INGEST_TOKEN`へ安全に移します。画面・リポジトリー・ログへ貼り付けないでください。`INGEST_TOKEN`未設定または短すぎる場合、取込みは拒否されます。

## 4. D1とWorkerを配置

```powershell
npm run db:remote
npm run deploy
```

初回Secret作成時にWorker作成を求められる場合はそのWorker名を確認します。まだSecretを作れない場合は、Secret未設定のままWorkerを先にデプロイしてから設定できます。未設定状態では取込み・閲覧ともfail closedです。

`new_sqlite_classes`でLiveRoomを作るため、SQLite-backed Durable Objectsの構成です。Cloudflare上のリソースはD1 1つ、Worker 1つ、LiveRoomの実体1つです。Cronは古い詳細履歴の削除専用で、Hub取得や常駐維持には使いません。

## 5. Cloudflare Accessを設定

Analyticsのホスト名にSelf-hosted Access Applicationを作り、許可するメール等を限定します。**公開Everyone Allowにはしません。** Worker設定の`vars.ACCESS_TEAM_DOMAIN`に`your-team.cloudflareaccess.com`、`ACCESS_AUD`にそのアプリのApplication Audience (AUD)を入れて再デプロイします。[S2]

閲覧APIとWebSocketの入口で、`Cf-Access-Jwt-Assertion`のRS256署名、issuer、audience、期限を検証します。メールヘッダーが存在するだけでは許可しません。

CollectorはWebログインしないので、`/api/ingest`だけを対象にする**より具体的なAccessアプリ/パス**を作り、Bypassを設定します。これはAccessのログイン画面を回避するためで、Worker側のBearer認証は引き続き必須です。`/api/*`全体をBypassしないでください。[S8]

運用例:

```text
analytics.example.com/*            : 許可した閲覧者だけ
analytics.example.com/api/ingest   : Access Bypass + WorkerのINGEST_TOKEN必須
```

`workers.dev`を使う場合は、WorkersダッシュボードのAccess保護設定から対象ホストを保護し、作成されたAccess Applicationのポリシーを確認します。https://developers.cloudflare.com/workers/configuration/cloudflare-access/ を参照してください。独自ドメインは必須ではありません。独自ドメインだけを使う場合は、`workers_dev: false`にし、routes/custom domainを設定します。プレビューURLは初期設定で無効です。別名の入口を残す場合も、閲覧APIがJWTを検証するため認証を迂回できないことを確認します。

## 6. 本番の受入確認

未認証の`/api/state`が閲覧できないこと、誤ったBearerで`/api/ingest`が拒否されること、Accessログイン後はOverviewを表示できることを確認します。Cloudflare Accessが先に302/403を返す場合、アプリの401まで届かないことは正常です。

次にWindowsのCollectorを実Hubへ接続し、`uploaded`とWeb表示を確認します。最後にWindows Collectorを終了してUbuntuへ移します。実HubからのAPI換算額・利用率の期間/帰属が一致するか確認するまでは、`attributionConfirmed`をtrueにしないでください。

Wranglerの実環境デプロイ、Accessの画面上の設定、無料枠メーターはこのZIPの作成時には未検証です。
