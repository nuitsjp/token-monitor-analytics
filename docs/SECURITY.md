# 公開と認証

## 初期の公開範囲

開発・運用とも`127.0.0.1:8787`で待ち受けます。Windowsの開発デモはloopback内の閲覧だけ認証なし。UbuntuのサンプルはBasic認証を有効にし、閲覧経路をSSHポート転送内に閉じます。Hub→CollectorはHTTPSのSSE、Collector→同居Analyticsはloopback HTTPです。

外部公開を暗黙には行いません。UbuntuのFWで8787番を開ける、`host`を0.0.0.0へ変更する、認証を無効にすることは初期手順に含みません。loopback閲覧モードはローカルユーザーを信頼する方式であり、同じ端末の他ユーザーからも閲覧され得ます。

## 認証の分離

CollectorのPOSTは常に32文字以上のBearerトークンを検証。閲覧用のBasicユーザー/パスワードでは取込みできず、CollectorのトークンでもBasic保護された閲覧APIは読めません。Hubの共有シークレットはCollectorだけが保持し、Analyticsへ転送しません。

Basic認証はユーザー/権限管理機構ではなく、単一の閲覧資格情報です。初期版ではSSH転送内で使用します。平文HTTPをLAN/インターネットへ公開してBasic認証する構成にはしないでください。

`Host`と`Origin`を検査し、想定外のHost（DNS rebinding等）とクロスサイト要求を拒否します。CORSは許可しません。静的ファイルは固定allowlistから配信し、設定・DB・envは配信対象になりません。ログへペイロードや認証値を出しません。

## 後から直接Web公開する場合

別のHTTPSリバースプロキシを前置する設計にできますが、今回はプロキシ製品の導入・設定を含めません。推奨はAnalyticsを引き続きloopbackにbindし、プロキシだけで外部TLSを終端する形です。

その際は`viewerAuth.mode=basic`、`publicOrigin=https://実際のホスト名`を設定し、プロキシが元のHost/Authorizationを保持して渡すようにします。`/api/live`はレスポンスをbufferingせず、25秒heartbeatより長いread timeoutを設定します。アプリはX-Forwarded-*の申告を認証の根拠にしません。リバースプロキシ越しの公開は未検証です。

非loopback bindはBasic認証とHTTPSのpublicOriginが設定されない限り起動を拒否します。ただしアプリ自身がTLSを終端するわけではありません。HTTPSの文字列を設定するだけでは暗号化されないため、必ず実際のTLSプロキシとFWで平文のバックエンドを保護してください。

## ファイル

設定JSON、env、SQLite、outbox、バックアップは私的利用情報です。Gitへ追加しません。Windowsでは自身のユーザープロファイルや適切なACLで保護された場所、Ubuntuでは専用ユーザー/0700のstate directoryを使用してください。
