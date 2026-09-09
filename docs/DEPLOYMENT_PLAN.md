# Ubuntu配置計画

## 目的

UbuntuではAnalyticsを1つのNode.jsプロセスとして常駐させます。Hub購読、履歴取得、SQLite保存、推定、管理API、ブラウザーSSEは同じプロセスと1つのlistenerで動きます。更新時だけoneshot runnerを起動し、runnerは収集やSQLite書込みを行いません。

```text
Hub ── HTTPS SSE ──> Analytics ── SQLite
                          └── HTTP/SSE ──> Browser
```

旧Collector、内部ingest、outbox、ACK、別DB、別listenerは通常構成に含めません。既存環境の停止、backup、drain、Hub登録のarchive/resetは通常発行へ混ぜず、[MIGRATION](MIGRATION.md)の移行入口からだけ行います。

## 手順の責務

| 手順 | 実行者 | 役割 |
| --- | --- | --- |
| `mise run provision:ubuntu` | 管理者 | 固定Node、配置権限、user systemd unit、linger、更新runnerを準備 |
| `mise run configure:ubuntu` | 通常ユーザー | listener、SQLite path、Secret path、閲覧認証、更新設定を準備 |
| `mise run publish:ubuntu` | 通常ユーザー | 検証済み配布物をlock下で配置し、必要時だけbackup・再起動・疎通検査 |
| `mise run status:ubuntu` | 通常ユーザー | 構成、サービス、listener、health、release/update stateを表示 |

通常運用でenableするのは`tma-analytics.service`だけです。`tma-update.service`は更新要求時だけ起動します。既存の旧unitや旧配置が見つかった場合、provisionはそれらを変更せず移行を要求します。

## listenerとデータ

既定はloopback listenerとSSH転送です。承認済みの公開構成では専用Tailscale IPv4に1つのlistenerだけをbindし、`viewerAuth.mode=tailscale`でTailscaleを閲覧境界にします。wildcard bind、一般公開、別のingest socketは設定しません。

Hub登録はSQLiteの`hubs`テーブル、Secretは専用`hub-secrets.json`が正本です。設定・Secret・SQLite・履歴を配布物へ含めず、publishは同じlistenerへAnalyticsを戻します。backupはSQLite backup APIを使い、稼働中DBの単純コピーを避けます。

## 受入記録

同じPCのHTTP/SSE、user serviceの再起動、OS再起動、別Tailscale端末、Windows、arm64実行は個別の実行証跡を残します。未実行の環境を成功と記録しません。実施コマンドと結果は[VERIFICATION](VERIFICATION.md)へ追記します。
