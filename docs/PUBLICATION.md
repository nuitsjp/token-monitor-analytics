# Ubuntuの構築・発行・更新

## 構成

配布物はAnalyticsのNode runtime、静的資産、migration、設定例、`tma-analytics.service`、更新runnerと`tma-update.service`だけを持ちます。常駐アプリはAnalytics 1つです。更新unitはoneshotで、収集・DB書込み・Hub管理を行いません。

構築は次の3段階です。

```text
sudo が必要        mise run provision:ubuntu
通常ユーザー        mise run configure:ubuntu
通常ユーザー        mise run publish:ubuntu
```

`provision:ubuntu`は固定Nodeをコピーし、`/opt/token-monitor-analytics`、`/var/lib/tma-analytics`、`/var/lib/tma-deploy`、user systemd unit、linger、更新runner、root所有のinfrastructure recordを準備します。Analytics serviceだけをenableし、update serviceはenable/startしません。既存の旧unitや旧配置が検出された場合は、ファイルやserviceを変更せず移行を要求します。

`configure:ubuntu`はlistener、public origin、閲覧mode、SQLite path、Secret path、update設定を作成します。Hub行は空のままにし、Hub登録はAnalytics UIで行います。`hub-secrets.json`はmode 0600（Windowsではprivate ACL）で作成します。Tailscale modeを選ぶ場合は、選択IPが実際のTailscale interfaceに割り当てられていることを起動時に確認します。

## 発行

事前に、作業ツリーが対象SHAへ固定され、必要なチェックが完了していることを確認します。

```text
mise run release:ubuntu:amd64
# または
mise run release:ubuntu:arm64
```

`tools/release.mjs`はallowlistからcontent hashを作り、release manifestとSHA-256 sidecarを生成します。秘密、DB、local config、env、開発依存、Hub submodule、旧構成は含めません。展開後のAnalytics HTTP/SQLite起動を`tools/check-package.mjs`で検査します。

`publish:ubuntu`は共通deployment lockを取得し、対象SHA・release identity・configuration snapshot・service/infrastructureを再確認します。失敗時はAnalyticsを停止しません。変更がある場合だけ、現在のAnalyticsを停止→SQLite backup→`current`の原子的な切替→設定を保持したまま再起動→health/state/SSEを検査します。同じcontentと起動設定なら再起動・バックアップ・コード交換を省略します。

publishはHub行、Hub Secret、観測、端末履歴、契約snapshot、更新stateを削除しません。更新後は同じlistenerでHub購読と履歴補完が再開することを確認します。初回の旧環境切替やHubリセットはpublishへ組み込まず、[MIGRATION](MIGRATION.md)の停止・drain・backup・reset・復旧手順を使います。

## 更新runner

WebのUpdate画面または対応CLIからcandidateを確認し、指定SHAを検証してoneshot runnerを起動します。runnerは共有lockを取得し、候補配布物・content hash・release identity、設定、サービス停止、SQLite backup、配置、Analytics再起動、health/state/SSEを検査します。常駐Analyticsが停止している間もrunnerは完了まで動けますが、runnerはDBへ書きません。

candidate検証、配置、起動、SSE再接続のいずれかが失敗した場合は、update stateの終端stageと復旧案内を保持します。成功stageを後から中断へ上書きしません。同一jobの再実行とCLI/Webの競合はlockとstateで拒否します。

## 閲覧とバックアップ

loopback構成はSSH転送を使います。Tailscale構成は専用Tailscale addressだけで1 listenerを公開し、アプリのBasic資格情報を要求しません。外部インターネット公開、wildcard bind、別のingest待受を作りません。

SQLite backupは次で作ります。

```text
node --experimental-strip-types analytics/runtime/backup.mjs \
  --config /var/lib/tma-deploy/config/analytics.json \
  --output /var/lib/tma-analytics/backups/analytics-YYYYMMDD.db
```

稼働中DBを`cp`でコピーしません。backup先は上書きせず、秘密と同じ権限境界で保護します。

## 状態確認

```text
mise run status:ubuntu
```

`status:ubuntu`はinfrastructure record、Analytics serviceのactive/enabled、update oneshotの非稼働、設定listener、health、publication identity、update stateを表示します。実Ubuntu host、実Tailscale interface、OS再起動を実行していない結果を成功として記録しません。
