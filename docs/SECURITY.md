# セキュリティ

## 待受と認証

開発・手動配置の既定は`127.0.0.1`または`::1`です。Ubuntuのloopback構成はSSH port forwardingとBasic認証を使います。承認済み公開構成では専用Tailscale IPv4へ1つのlistenerだけをbindし、`viewerAuth.mode=tailscale`でTailscaleの到達範囲を認証境界にします。`0.0.0.0`、任意LAN address、Cloudflare Access、Serve、Funnelを自動設定しません。

Management、health、state、history、browser SSE、static assetsは同じlistenerです。別のingest待受、loopback専用Bearer、`/api/ingest`、`/api/collector/status`はありません。Host/Origin/Sec-Fetch検査を行い、proxyの`X-Forwarded-*`を信頼しません。

## Secret

Hub Secretは`hub-secrets.json`にだけ保存します。SQLite、設定JSON、HTTP body、URL、静的ファイル、browser SSE、ログ、release archiveへ値を入れません。UIのHub一覧は`hasSecret`などの状態だけを返し、保存済み値やSecretファイル全体を返しません。

Secret差し替えは入力検証→新しいopaque参照で専用ファイルを原子的に保存→SQLiteの短いtransactionで参照切替の順序です。DB更新が失敗した場合、旧参照を維持します。未参照Secretの削除は停止中の明示的な保守だけで行い、稼働中に自動GCしません。暗号化は今回の範囲外であり、Windows ACLまたはPOSIX mode/ownerで保護します。

## 入力境界

Hub URLはHTTPS originに限定し、loopback開発時だけHTTPを許可します。credentialsをURL queryやfragmentへ置きません。Hub SSEのイベント、履歴JSON、JSONサイズ、日付、数値、端末ID、重複キーを上流境界で検証し、未知fieldを保存しません。未来時刻、無効なlimit、過大な応答、重複端末は当該Hubの入力エラーです。

ブラウザーへのJSONは公開用のallowlistで組み立て、内部パス、secretRef、環境変数名、DB内容、SQLエラーを返しません。HTTP例外とログからSecretを除去します。CSP、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`を設定します。

## 保存と配布

SQLiteはWAL、`synchronous=FULL`、foreign keys、busy timeoutを使います。1つのAnalytics processだけがDB writerです。transaction callbackは同期だけで、COMMIT前の通知はありません。詳細観測は期限保守を行いますが、保持期間は秘密保護や容量管理の代わりになりません。

配布物はallowlistで作成し、config.local、env、DB、Secret、node_modules、Hub submodule、旧構成、開発checkoutを含めません。候補SHA、content hash、release identityを検証し、publishのdeployment lockを共有します。更新runnerは常駐せず、収集とDB書込みを行いません。

## 運用境界

初回の旧環境切替だけが移行専用コードを読みます。通常起動、通常publish、通常updateは旧設定ファイル、Batch、ACK、outbox、旧serviceを読みません。旧環境を停止・drain・resetする手順は[移行手順](MIGRATION.md)に分離し、削除前にバックアップと復旧可能性を確認します。
