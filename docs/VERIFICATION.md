# 検証結果 — 0.3.0 self-hosted

更新日: 2026-09-06。Tailscale閲覧認証の除去後、miseによる正式発行で実行した検証を記録します。

## 実行環境

Ubuntu Linux amd64実ホスト、mise 2026.9.1、Go 1.26.8、Node.js 24.20.0、TypeScript 5.8.3。`mise run setup`が`npm ci --include=dev`で開発依存を取得します。

## 結果

`mise run publish:ubuntu`と`mise run status:ubuntu`が成功しました。Analyticsは46件、発行関連は10件成功・失敗0件。型検査、Goのgofmt/race/vet、2 Hub結合、amd64パッケージ生成・展開検査も成功しています。実ホストでサービスactive/enabled・linger、Tailscale経由の認証なし閲覧・SSE・外部ingest遮断、実Hub観測データの保存を確認しました。

## 検証コマンド

```bash
mise run publish:ubuntu
mise run status:ubuntu
```

amd64/arm64のreleaseタスクは共通の`release:verify`を一度実行し、setup→Go/Analytics検証→結合試験が成功してから各パッケージを作成・検査します。

- Go: gofmt確認、`go test -race ./...`、`go vet ./...`。
- Analytics: `npm test`（推定、プロトコル、SQLite、認証、ネイティブHTTP/SSE）、`npm run typecheck`。
- 保存失敗時はHTTP ACK・通知なし。再送成功時は通知時点で別SQLite接続からCOMMIT済みデータを読めることを検査。
- 結合: 実Go模擬Hub 2つ→Go Collector→Node Analytics→SQLite→SSE。停止後のoutbox再送、重複防止、再接続、SQLiteバックアップと整合性を検査。
- パッケージ: 今回はLinux amd64向けELF、SHA-256、私的ファイルの除外、空白を含む一時パスへの展開、展開したAnalyticsのHTTP配信とSQLite起動を検査。

NodeのTypeScript型除去だけでは型検査になりません。tscの対象は`analytics/src`の純粋TSコアです。`.mjs`ランタイムはネイティブテストとパッケージ起動で検証します。

## 実行範囲の限界

- Windows上の実行、PowerShellスクリプト、GitHub Actionsは未実行です。Windows/UbuntuのCI定義があることと、実行成功は区別します。
- arm64は2026-09-05時点の成果物を検査済みで、今回の認証変更後は未再検証です。arm64 CollectorはクロスビルドとELFヘッダーの確認のみで、arm64上の実行試験ではありません。パッケージ内のNodeサーバーはLinux amd64で起動しています。
- Ubuntu実機のsystemd登録・停止起動は確認済み。新規ホストからの全工程、実OS再起動、SSH転送、認証除去後の別端末ブラウザー確認は未実施です。
- 実Hub観測データの保存は確認済み。実アカウントの契約帰属・利用額、ブラウザーUI、24時間連続稼働、電源断・ディスク故障、外部TLSプロキシは今回未検証です。
- 上記の結合試験は模擬データの短時間試験です。負荷試験や実料金の正しさを保証するものではありません。

現在の環境構築・発行手順は[PUBLICATION](PUBLICATION.md)、旧データの扱いは[MIGRATION](MIGRATION.md)を参照してください。

## Hub管理レビュー修正（2026-09-06、Linux）

`b4df7d4`のレビューで確認した5件を修正。Ubuntu配布対象へ必須モジュールを追加し、停止後のHub再有効化、Secretファイル解析エラーの非露出、Node/Goの表示名長検証、書込み前の両設定ファイルのサイズ検証を修正した。

- `mise run --continue-on-error check`: Analytics 54件・発行関連10件、Go整形/test/race/vet、TypeScript型検査に成功。
- 従来の`tools/integration.mjs`: HTTP/SSE/SQLite、停止復旧、outbox排出、バックアップの結合試験に成功。
- `tools/integration-manage.mjs`: Hub 0件からの追加・受信・停止に加え、同一Collectorプロセスで再有効化後の接続と新しい観測の保存に成功。通常の`mise run integration`にも管理用試験を追加。
- `mise run package:ubuntu:amd64`: アーカイブ作成、チェックサム、配布内容、ELF、展開後のAnalytics HTTP/SQLite試験に成功。
- 共通fixtureで日本語・絵文字の128 UTF-16コード単位境界をNode/Go双方で検証。秘密情報JSONの破損・欠落時にGET/POST/PUT/DELETE応答へ秘密値や内部パスが出ないこと、設定サイズ超過時に両ファイルが変更されないことを検証。

Windows実機、arm64実行、今回の修正を本番へ発行した場合の動作、OS再起動は未検証。本番への発行は行っていない。既存設定の移行とconfigure/publish/statusの管理モード対応は今回の修正対象外であり、未実装。


## 管理モードの運用統合・正式発行（2026-09-06）

前節で未実装としていたconfigure/publish/statusを管理モードへ対応させた。ユーザー指定により旧Hub情報は移行せず、停止・outbox ACK確認後に登録とSecretを削除し、UIから登録し直す方式とした。

- Analytics 54件、運用関連12件、Go整形/test/race/vet、型検査、従来および管理用の結合試験、amd64配布検証に成功。
- 実環境で`configure:ubuntu -- --reset-hubs`を実行。停止時点の未送信outboxは0件。旧登録とHub Secretを削除し、契約0件・Hub0件・Secret0件で管理モードを初期化した。
- `publish:ubuntu`で正式発行。両ユーザーサービスactive/enabled、Tailscaleの閲覧・管理API・SSE、外部ingest/状態POSTの遮断、Collectorの空設定revision反映を確認。
- リセット前後で履歴件数が減少していないことと、ingest資格情報のハッシュ一致を確認した。設定・Secretの内容は検証出力へ表示していない。
- 同じコード・設定でconfigure/publishを再実行し、サービスPID・設定ファイルのハッシュ・DBバックアップ一覧が不変であることを確認。
- 実Hubの再登録はユーザーが管理画面から行う。削除した秘密情報を復元・自動登録していない。

Windows実機・別Tailscale端末のブラウザー・OS再起動は未実施。別端末ではTailscale接続後に表示URLのHubs画面で登録・接続状態を確認する。Windowsの開発実行を検証する場合は修正コードを配置し、PowerShellで`mise run setup`、`mise run check`、`mise run integration`を実行する。OS再起動確認は都合のよい時にUbuntuで`sudo reboot`を実行し、復帰後にリポジトリーで`mise run status:ubuntu`とブラウザーからの到達を確認する。
