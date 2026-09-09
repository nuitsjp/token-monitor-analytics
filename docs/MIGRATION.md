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

## 旧Cloudflare版から0.3.0同居版へ

## コピー元と継承部分

この版は`token-monitor-analytics-web-ubuntu-starter-20260905.zip`を元に修正しています。古いWails/デスクトップ版は元にしていません。Go Collectorの実装とプロトコル、純粋な推定処理、3画面を継承しています。

## ローカルデモ

旧版の模擬Hub・Collector・Wranglerを停止し、新しいフォルダーへ展開してください。新しい起動コマンドはREADMEの3ターミナル方式です。`.wrangler`内の開発D1は新SQLiteへ自動移行しません。0.2.0のディレクトリー/DB/ローカル設定を削除しないでください。

新旧を上書き混在させるとwrangler.jsoncや古いnode_modules、開発コマンドが残るため、別フォルダーを推奨します。既存Gitリポジトリーに適用する場合は作業ブランチで比較し、削除されたファイルも反映してください。単なるZIPの上書き展開は削除を反映しません。

## 実設定

CollectorのJSON形式はv1のまま。`analytics_url`を`http://127.0.0.1:8787`に変更します。Hub URL、Hub ID、secret_envは維持できます。実体が同じHubのIDは変えません。

契約定義は旧`analytics/src/settings.ts`から新`analytics/config.local.json`の`contracts`へ、Hub定義は`hubs`へ移します。新しい本番設定では`demo: false`にします。JSONなのでコメント・TypeScriptの型注釈・末尾カンマは使えません。

新Analyticsに対する送信トークンを設定します。デモ用tokenは本番で拒否します。ブラウザー認証はCloudflare Accessではなく、localhost限定、Basic認証、または明示的なTailscale境界モードです。現在のUbuntu発行タスクはTailscale境界モードを使用し、閲覧資格情報の入力は不要です。

## 0.3.0のWindows本番データをUbuntuへ引継ぐ場合

1. Windows Collectorの`pending_bytes`が0になったことを確認して停止します。残件がある場合は削除せず、まずWindows Analyticsへ排出してください。
2. READMEのbackupコマンドで**本番DB**の整合したバックアップを作ります。以後Windows Analyticsも停止します。
3. Ubuntu側の両サービスを止めた状態で、バックアップを`/var/lib/tma-analytics/analytics.db`として配置し、所有者を`tma-analytics:tma-analytics`、modeを0600へ設定します。Ubuntu側に既存履歴がある場合は先に別途バックアップしてください。
4. Ubuntu側の契約/Hub ID、タイムゾーンを合わせて起動します。新しいCollector接続になるため、推定基準は最初のsnapshotで作り直します。保存済みの日次履歴は保持します。

バックアップ復元時に稼働中DBへ直接上書きしません。既存の`.db`/`-wal`/`-shm`を別の安全な場所へ退避したうえで、新しいバックアップを配置します。デモDBを本番へ移しません。

0.2.0のCloudflare D1からの自動インポーターは含めません。既に本番D1へ履歴を蓄積している場合、旧環境を残し、別途エクスポート/移行を実施する必要があります。
