# 検証結果 — 0.3.0 self-hosted

更新日: 2026-09-05。旧Cloudflare実装と検証ホストの残存を解消した後、miseの固定環境で再検証した結果を記録します。

## 実行環境

Linux amd64コンテナー、mise 2026.9.1、Go 1.26.8、Node.js 24.20.0、TypeScript 5.8.3。`mise run setup`が`npm ci --include=dev`で開発依存を取得します。

## 結果

`mise run 'release:ubuntu:*'`は終了コード0で成功しました。Analyticsは**43件成功・失敗0件**、型検査、Goのgofmt/race/vet、2 Hub結合、両CPU向けパッケージ生成・展開検査も成功しています。

## 検証コマンド

```bash
mise run 'release:ubuntu:*'
```

amd64/arm64のreleaseタスクは共通の`release:verify`を一度実行し、setup→Go/Analytics検証→結合試験が成功してから各パッケージを作成・検査します。

- Go: gofmt確認、`go test -race ./...`、`go vet ./...`。
- Analytics: `npm test`（推定、プロトコル、SQLite、認証、ネイティブHTTP/SSE）、`npm run typecheck`。
- 保存失敗時はHTTP ACK・通知なし。再送成功時は通知時点で別SQLite接続からCOMMIT済みデータを読めることを検査。
- 結合: 実Go模擬Hub 2つ→Go Collector→Node Analytics→SQLite→SSE。停止後のoutbox再送、重複防止、再接続、SQLiteバックアップと整合性を検査。
- パッケージ: Linux amd64/arm64向けELF、SHA-256、私的ファイルの除外、空白を含む一時パスへの展開、展開したAnalyticsのHTTP配信とSQLite起動を検査。

NodeのTypeScript型除去だけでは型検査になりません。tscの対象は`analytics/src`の純粋TSコアです。`.mjs`ランタイムはネイティブテストとパッケージ起動で検証します。

## 実行範囲の限界

- Windows上の実行、PowerShellスクリプト、GitHub Actionsは未実行です。Windows/UbuntuのCI定義があることと、実行成功は区別します。
- arm64 CollectorはクロスビルドとELFヘッダーの確認のみで、arm64上の実行試験ではありません。パッケージ内のNodeサーバーはLinux amd64で起動しています。
- Ubuntu実機のsystemd登録・停止起動・OS再起動・SSH転送・ブラウザーのBasic認証対話は未実行です。
- 実Hub・実アカウントの契約帰属・利用額、ブラウザーUI、24時間連続稼働、電源断・ディスク故障、外部TLSプロキシは今回未検証です。
- 上記の結合試験は模擬データの短時間試験です。負荷試験や実料金の正しさを保証するものではありません。

実機の受入手順とリリース配置は[UBUNTU](UBUNTU.md)、旧データの扱いは[MIGRATION](MIGRATION.md)を参照してください。
