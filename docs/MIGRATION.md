# 旧Go Collector構成から単一Node構成への一回限りの移行

初回切替は旧Web更新ボタンから実行せず、`tools/migrate.mjs`を管理者が
明示的に実行します。CLIは旧版を
`cae687c4947990e9da6db3193ea8afe26b4b5246`へ固定し、対象SHAのrelease
artifact（SHA sidecarとmanifestを含む）を切替前に検証します。旧runnerの
Web経路から呼び出された移行は、停止・バックアップ前に拒否されます。

```text
node --experimental-strip-types tools/migrate.mjs \
  --old-sha cae687c4947990e9da6db3193ea8afe26b4b5246 \
  --target-sha <40文字の対象SHA> --target-artifact <検証済みtar.gz> \
  --analytics-config <旧analytics.json> --collector-config <旧collector.json> \
  --state /var/lib/tma-deploy/migration-state.json \
  --backup-dir /var/lib/tma-deploy/migration-backup
```

Ubuntuでは対象設定の既定値は`/var/lib/tma-deploy/config/analytics.json`（Secretと
`analytics.env`も同じ配下）です。Basic認証・旧Tailscale待受・更新repository/branch・状態
pathは旧設定から引き継ぎます。Windowsでは`--collector-pid`と`--analytics-pid`を指定して
停止対象を明示し、DBのファイルロック検査を通過してから同じDBへ設定を切り替えます。

Windowsではさらに`--windows-install-dir`で新Nodeアプリの配置先を指定します。publish段階は
検証済みartifactをその場所へ原子的に配置し、実際の`analytics/runtime/server.mjs`を起動して
health/state/SSEとrelease SHAを確認します。復旧時は`--restore --analytics-pid <PID>
--legacy-command <旧起動コマンド>`（必要なら`--legacy-args` JSON配列）を指定します。
WindowsのPID停止・DB rename検査・新アプリ起動証明が通らない限りcompleteへ進みません。
保存済みの新Analytics PIDを自動停止するときは、実行ファイル・配置先・設定ファイルの
プロセス情報を照合し、PID再利用や別プロセスの場合は停止せず中断します。

`--dry-run`は対象artifact、旧設定、更新job、service、DB、Hub/Secret、outboxを
読み取るだけです。通常実行は共通の`/var/lib/tma-lock/deploy.lock`を保持したまま、
`prepare → stop → drain → finalbackup → archive → provision → publish → complete`
の順に進みます。各段階の状態は秘密値を含まないJSONへ原子的に保存され、失敗後の
再実行は完了済みの段階を繰り返しません。移行完了後に登録したHubや契約を再実行で
消去する処理はありません。

停止順序はCollector、Analyticsです。自動起動を抑止し、停止PIDとDB writerがないことを
確認してから、固定した旧Node serverをloopback一時待受で起動します。このserverは
元のDB、ingest token、Hub ID、契約だけを使い、管理・更新・収集・Tailscale待受を
無効にします。旧版`tools/reset-hubs.mjs`でoutbox全件を送り、各COMMIT ACKを確認した
ファイルだけ削除します。破損、`.tmp-*`、未知ファイル、ACK不明、残件があれば移行を
中断し、outboxを保持します。一時serverを閉じた後に、drain後のSQLiteを最終バック
アップします。rollbackで使うDBはこのバックアップだけです。

停止直前の状態保存後にプロセスが落ちた場合も、`--restore`は停止対象を再確認し、現在の旧形式DBを保持したまま旧サービスを戻します。`stop`/`drain`中のACK不確実終了でも同じ扱いで、post-drainバックアップが無い状態で古いDBへ戻すことはありません。

旧Hub ID/表示名と契約定義は履歴として残ります。移行後の`hubs`行はarchivedで、URLと
Secret参照はNULLです。新しい起動設定のactive Hub/契約とSecret fileは空で、旧URL/Secret
は設定へ自動復活しません。旧登録や構築記録、service/drop-in、runner、固定Node、root
infraは保護バックアップへ保存します。復旧は`--restore`で新Analyticsを停止し、切替後
DBを別バックアップへ退避してからdrain後DBと旧一式を戻します。旧アプリを新DBへ向ける
ことはありません。

Ubuntuの実service停止・provision・再起動、WindowsのCtrl+C/ACL/ロック、OS再起動後の
自動起動はこの開発環境では未実行です。実機切替前に`--dry-run`と保護バックアップを
確認し、停止・復旧の手動責任者を決めてください。

実行前にUbuntuの管理者シェルで、発行先の通常ユーザーを明示します。

```sh
export TMA_DEPLOY_USER=tma-analytics
sudo -E node --experimental-strip-types tools/migrate.mjs \
  --target-sha <40文字の対象SHA> --target-artifact <検証済みtar.gz> \
  --analytics-config /etc/token-monitor-analytics/analytics.json \
  --collector-config /etc/token-monitor-analytics/collector.json
```

`--publication-user`を指定した場合は`TMA_DEPLOY_USER`より優先されます。旧systemd
EnvironmentFileをCLIへ明示する場合は`--analytics-env`と`--collector-env`を使います。
省略時は各設定ファイルと同じディレクトリーの`analytics.env`/`collector.env`を読みます。
CLIへ渡した環境変数はファイル値より優先されます。AnalyticsとCollectorのingest資格情報の値
は一致している必要があります。旧ingest tokenとBasic閲覧資格情報はdrainと候補設定の検証に
メモリー上でだけ使い、移行stateへ保存しません。新しいSecret fileへ旧Hub Secretをコピー
しません。

復旧は同じ管理者ユーザーで、移行stateと対象ユーザーのサービス情報を指定します。

```sh
sudo -E node --experimental-strip-types tools/migrate.mjs --restore \
  --state /var/lib/tma-deploy/migration-state.json \
  --publication-user "$TMA_DEPLOY_USER" \
  --analytics-pid <新AnalyticsのPID> \
  --legacy-command <旧Analyticsの起動コマンド> \
  --legacy-args '["--config","/etc/token-monitor-analytics/analytics.json"]'
```

Windowsではsudo/systemdの手順を使わず、`--collector-pid`、`--analytics-pid`、
`--windows-install-dir`を指定します。移行stateに保存された新Analytics PIDは実行ファイル・
配置先・設定ファイルを照合してから停止します。旧Analyticsを起動する復旧時だけ
`--legacy-command`と必要な`--legacy-args`を指定してください。
