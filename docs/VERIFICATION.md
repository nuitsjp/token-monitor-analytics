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
