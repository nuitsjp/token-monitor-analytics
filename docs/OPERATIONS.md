# 運用

## 常駐プロセス

通常運用はAnalytics 1プロセス、SQLite 1ファイル、HTTP listener 1つです。Hub管理、SSE購読、履歴取得、保存、推定、ブラウザー配信は同じプロセスにあります。更新時だけ`tma-update.service`を起動します。runnerは通常の収集やDB書込みを担当しません。

```text
mise run provision:ubuntu   # 管理者: Node、service、権限
mise run configure:ubuntu   # 通常ユーザー: listener/DB/Secret設定
mise run publish:ubuntu     # 通常ユーザー: 検証済み配布と再起動
mise run status:ubuntu      # 通常ユーザー: 状態確認
```

`tma-analytics.service`は失敗時に再起動します。`tma-update.service`は常駐有効化せず、WebまたはCLIの明示的な更新要求でだけ実行します。`/api/health`はHTTP listenerの生存だけを示し、Hub接続や最新保存を保証しません。

## Hub管理

管理モードを有効にすると、UIの登録・停止・再接続・archive・Secret差し替えを使えます。Hub行はSQLiteの`hubs`テーブル、Secret値は専用`hub-secrets.json`が正本です。Hub IDを再利用せず、archive後も観測と履歴を保持します。複数タブの競合は行versionで409にします。

保存transactionがCOMMITした直後に購読世代を更新します。URL・Secret・状態が変わると旧SSEをabortしてから新世代を開始します。欠損SecretやHub入力エラーはそのHubだけ停止します。SQLite保存エラーは全収集を停止し、ログにはSecretやSQL詳細を出しません。

## 履歴補完と保持

Hub履歴は起動、登録、再接続、revision通知、手動要求で取得します。SSEを定期pollingへ置き換えません。取得中の変更はdirty状態にまとめ、1 Hubにつき1件だけ実行します。端末別のdaily/monthly行は同じ主キーをupsertし、再取得で加算しません。端末削除、History無効、欠測、非対応はsource状態として表示し、既存の過去行を偽の0で上書きしません。

観測詳細の既定保持期間は7日です。起動時と定期保守で古い詳細を小さい単位で削除し、Hub最新snapshotは残します。日次推定と端末履歴は長期参照用に保持します。SQLiteのファイルサイズは自動的に上限へ収束するとは限らないため、容量とバックアップを運用で確認します。

## 障害対応

| 状態 | 対応 |
| --- | --- |
| Hub接続エラー | UIの接続状態、URL、Secret、Hub側SSEを確認。対象Hubだけを再接続 |
| 履歴取得エラー | 最終成功行を保持し、Hub登録または手動取得で再試行 |
| SQLite保存エラー | Analyticsが収集を停止。ディスク、権限、整合性を確認してから再起動 |
| HTTP listener停止 | systemd status/journalとhealthを確認。viewer境界を変更して迂回しない |
| DB破損の疑い | アプリを停止し、バックアップと`PRAGMA integrity_check`を別DBで検査。空DBへ置換しない |
| 更新失敗 | update stateのstage/errorCodeを確認。runnerが示す復旧手順を使い、Hub/Secret/DBを手作業で消さない |

未受信の過去観測を推測して埋めません。停止中の利用実績はHubの端末別履歴が提供する範囲だけ補完できます。limit時系列、過去の推定、アカウント帰属は復元しません。

## バックアップ

Analytics停止中またはバックアップAPIを使ってSQLiteをバックアップします。

```text
node --experimental-strip-types analytics/runtime/backup.mjs \
  --config /path/to/analytics.json \
  --output /path/to/backups/analytics-YYYYMMDD.db
```

バックアップ先は既存ファイルへ上書きしません。DB、Secret、設定、release identityを同じ運用記録で管理し、ログや静的配信へ秘密値を出しません。

## 確認

ブラウザーの「ライブ接続」はブラウザーとAnalyticsのSSE状態です。Hubの接続継続は管理画面のHub状態、最終観測時刻、履歴取得時刻で別に確認します。Ubuntuの再起動・Tailscale・自己更新は実機または隔離ゲストで実行した証跡だけを成功と記録します。
