# 検証結果 — 0.3.0 self-hosted

作成日: 2026-09-05。前回の0.2.0の検証記録ではなく、今回の変更後の結果です。

## 実行環境

Linux amd64の作成コンテナー。Go **1.23.2**、Node.js **22.16.0**、TypeScript **5.8.3**を使用しました。Nodeの型除去と組込みSQLiteについてexperimental警告があります。実際の運用にはREADMEどおり保守中のGoとNode.js 24 LTS最新パッチを使用し、実機で受入確認してください。

## 実行して成功した検査

| 検査 | 結果・範囲 |
|---|---|
| Goテスト | **トップレベル23件成功**。サブテスト込み26件。`go test -race -json ./...` |
| Go静的検査 | `go vet ./...` 成功 |
| Nodeテスト | **38件成功**。既存の推定・プロトコル・DB検査と、新規のネイティブHTTP/認証/SQLite/SSE検査 |
| TypeScript | `npm run typecheck`成功。既存の純粋TSコアをTypeScript 5.8.3で型検査。`.mjs`ランタイムをtscで検査したという意味ではない |
| JavaScript構文 | フロントエンドとruntime/toolsの`node --check`成功 |
| SQLite実体 | 自動マイグレーション、WAL、demo/real混在拒否、取込み全体のrollback、重複防止、日次last-valid保持 |
| ネイティブHTTP | 起動・静的配信・閲覧API・POST。Bearer/Basicの分離、Host/Origin拒否、入力サイズ/不正形式の拒否 |
| ネイティブSSE | 実HTTPの`ready`/`updated`/heartbeat、保存後の通知、再接続後のstate取得。クライアントはNode fetch |
| 2 Hub結合 | **実Go模擬Hub 2つ → 実Go Collector → 実Node Analytics → 組込みSQLite**。期間枠160 USDを確認 |
| Analytics停止/復旧 | Analytics停止中にCollectorのファイルoutboxが残り、再起動後に再送・削除される。再起動前の履歴も保持 |
| 再送/Collector再接続 | 同じイベントを再送しても二重保存しない。Collector再起動で新しいstreamIdを観測 |
| バックアップ | WALを含む稼働中DBから整合したSQLiteバックアップ。既存ファイル上書き拒否。`PRAGMA integrity_check`成功 |
| クロスビルド | Windows amd64 PE32+、Linux amd64 ELF、Linux arm64 ELFを生成。Linuxは静的リンク。Windows/ARM64での実行ではない |
| Bashスクリプト | `bash -n`成功。`bootstrap.sh`と`package-ubuntu.sh amd64`を実行 |
| 配置用tar | 実生成・展開し、**node_modulesなし**でAnalyticsを起動、SQLiteを自動作成。設定/DB/envの混入なし、デモに本番用環境トークンを引き継がないことも確認 |
| UI描画 | Chromiumの**メモリー内fixture**で3画面、通知後の再描画、単一観測のグラフ、識別子表示、390px幅での横溢れなしを確認 |

結合試験の再実行:

```powershell
node --experimental-strip-types .\tools\integration.mjs
```

実SQLite・実Node HTTPサーバーを使っており、前版のCloudflare Worker/DOを模したホストではありません。数十秒・少数イベントのスモーク試験であり、負荷試験や24時間連続稼働試験ではありません。

## 実行していない／確認できなかったもの

- **Windows上の実行、PowerShellスクリプト、Windowsブラウザー**。クロスビルド成功とWindows実行成功を混同しないこと。
- **Ubuntu実機上のsystemd登録・OS再起動・SSH転送・Basic認証のブラウザー対話**。unitと手順を同梱したが、実サービス登録は行っていない。
- **Node.js 24での実行**。作成環境の実行版は22.16.0。CIにはNode 24/Windows/Ubuntuを定義したが、ユーザーのGitHubで実行済みではない。
- **ブラウザーから実サーバーへのネットワーク接続**。ChromiumでローカルHTTPへ移動を試みたが、作成環境の`ERR_BLOCKED_BY_ADMINISTRATOR`により拒否された。ポリシーを変更せず、描画はネットワークを使わないfixtureで検査した。実HTTP/SSEは別途Nodeクライアントで検証しており、ブラウザー実接続と区別する。
- **実Token Monitor Hub、実アカウントの契約帰属、実利用額**。上流固定バージョンのプロトコルを引き継ぎ、試験元は模擬Hubのみ。
- 電源断、ディスク故障、長時間負荷、ネットワーク共有上のSQLite、外部TLSリバースプロキシ。ネットワーク共有DBは今回の運用対象外。
- **`npm ci`による依存ダウンロード**。npmレジストリーへのDNS解決ができず、既設のTypeScriptで型検査した。公式レジストリーのintegrityを使って同梱lockを作成し、`npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund`で正規化した。Analytics起動・全Nodeテスト・結合試験にnpm依存は不要。

## 利用者側での受入順序

1. 新フォルダーでWindowsデモを起動し、更新ボタンなしで金額と観測時刻が変わることを確認する。
2. Analyticsを一度止め、再起動後にCollectorの未送信分が反映されることを確認する。
3. 実Hub設定へ切り替え、契約帰属を確認するまでは`contracts: []`で観測を継続する。
4. Ubuntuへ配置し、両サービスの再起動・OS再起動・SSH経由の閲覧・数日分の履歴を確認する。

実データを含まないソースZIPを提供します。検査用にGo 1.23.2で生成したバイナリー・tar・DB・outbox・実envはソースZIPへ同梱していません。
