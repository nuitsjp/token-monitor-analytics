# 0.2.0 Cloudflare版から0.3.0同居版へ

## コピー元と継承部分

この版は`token-monitor-analytics-web-ubuntu-starter-20260905.zip`を元に修正しています。古いWails/デスクトップ版は元にしていません。Go Collectorの実装とプロトコル、純粋な推定処理、3画面を継承しています。

## ローカルデモ

旧版の模擬Hub・Collector・Wranglerを停止し、新しいフォルダーへ展開してください。新しい起動コマンドはREADMEの3ターミナル方式です。`.wrangler`内の開発D1は新SQLiteへ自動移行しません。0.2.0のディレクトリー/DB/ローカル設定を削除しないでください。

新旧を上書き混在させるとwrangler.jsoncや古いnode_modules、開発コマンドが残るため、別フォルダーを推奨します。既存Gitリポジトリーに適用する場合は作業ブランチで比較し、削除されたファイルも反映してください。単なるZIPの上書き展開は削除を反映しません。

## 実設定

CollectorのJSON形式はv1のまま。`analytics_url`を`http://127.0.0.1:8787`に変更します。Hub URL、Hub ID、secret_envは維持できます。実体が同じHubのIDは変えません。

契約定義は旧`analytics/src/settings.ts`から新`analytics/config.local.json`の`contracts`へ、Hub定義は`hubs`へ移します。新しい本番設定では`demo: false`にします。JSONなのでコメント・TypeScriptの型注釈・末尾カンマは使えません。

新Analyticsに対する送信トークンを設定します。デモ用tokenは本番で拒否します。ブラウザー認証はCloudflare Accessではなく、localhost限定またはBasic認証です。

## 0.3.0のWindows本番データをUbuntuへ引継ぐ場合

1. Windows Collectorの`pending_bytes`が0になったことを確認して停止します。残件がある場合は削除せず、まずWindows Analyticsへ排出してください。
2. READMEのbackupコマンドで**本番DB**の整合したバックアップを作ります。以後Windows Analyticsも停止します。
3. Ubuntu側の両サービスを止めた状態で、バックアップを`/var/lib/tma-analytics/analytics.db`として配置し、所有者を`tma-analytics:tma-analytics`、modeを0600へ設定します。Ubuntu側に既存履歴がある場合は先に別途バックアップしてください。
4. Ubuntu側の契約/Hub ID、タイムゾーンを合わせて起動します。新しいCollector接続になるため、推定基準は最初のsnapshotで作り直します。保存済みの日次履歴は保持します。

バックアップ復元時に稼働中DBへ直接上書きしません。既存の`.db`/`-wal`/`-shm`を別の安全な場所へ退避したうえで、新しいバックアップを配置します。デモDBを本番へ移しません。

0.2.0のCloudflare D1からの自動インポーターは含めません。既に本番D1へ履歴を蓄積している場合、旧環境を残し、別途エクスポート/移行を実施する必要があります。
