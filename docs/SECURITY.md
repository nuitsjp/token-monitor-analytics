# 公開と認証

## 初期の公開範囲

開発・運用とも`127.0.0.1:8787`で待ち受けます。Windowsの開発デモはloopback内の閲覧だけ認証なし。UbuntuのサンプルはBasic認証を有効にし、閲覧経路をSSHポート転送内に閉じます。Hub→CollectorはHTTPSのSSE、Collector→同居Analyticsはloopback HTTPです。

外部公開を暗黙には行いません。UbuntuのFWで8787番を開ける、`host`を0.0.0.0へ変更する、認証を無効にすることは初期手順に含みません。loopback閲覧モードはローカルユーザーを信頼する方式であり、同じ端末の他ユーザーからも閲覧され得ます。

## 認証の分離

CollectorのPOSTは常に32文字以上のBearerトークンを検証。閲覧用のBasicユーザー/パスワードでは取込みできず、CollectorのトークンでもBasic保護された閲覧APIは読めません。Hubの共有シークレットはCollectorだけが保持し、Analyticsへ転送しません。

Basic認証はユーザー/権限管理機構ではなく、単一の閲覧資格情報です。初期版ではSSH転送内で使用します。平文HTTPをLAN/インターネットへ公開してBasic認証する構成にはしないでください。

`Host`と`Origin`を検査し、想定外のHost（DNS rebinding等）とクロスサイト要求を拒否します。CORSは許可しません。静的ファイルは固定allowlistから配信し、設定・DB・envは配信対象になりません。ログへペイロードや認証値を出しません。

## 明示的なTailscale閲覧

[Ubuntu発行タスク](PUBLICATION.md)はTailscale IPv4へ閲覧専用HTTP待受を追加します。接続はTailscale内で暗号化され、Basic認証を維持します。loopback側だけが取込みを受け付けます。閲覧用待受は有効な取込みトークンやX-Forwarded-*ヘッダーがあっても取込みを拒否します。両待受は同一のSQLite・直列化処理・SSE通知を共有します。

`tailnetViewer`は明示設定でのみ有効になり、起動時に指定IPがTailscaleインターフェースへ割り当て済みであることを確認します。0.0.0.0やLAN IPでは起動しません。一般インターネット公開、Serve、Funnelは設定しません。通常の非loopback bindに対するHTTPS/Basic必須条件は維持します。

## ファイル

設定JSON、env、SQLite、outbox、バックアップは私的利用情報です。Gitへ追加しません。Windowsでは自身のユーザープロファイルや適切なACLで保護された場所、Ubuntuでは専用ユーザー/0700のstate directoryを使用してください。
