# 開発・検証ツール

開発環境はリポジトリー直下の`.mise.toml`で固定します。Go 1.26.8とNode.js 24.20.0を使うため、OS側の`go`や`node`を直接呼び出さず、リポジトリールートから`mise run`または`mise exec --`を使ってください。シェルの`mise activate`は必要ありません。

初回クローン時は、リポジトリールートで次を実行します。

```text
mise trust
mise install
mise run setup
```

`mise run setup`はランタイムの確認と`npm --prefix analytics ci --include=dev`を行います。`NODE_ENV=production`でも型検査用依存を導入し、`analytics/package-lock.json`の固定バージョンを使います。Go/Nodeのバージョンまたは`package-lock.json`を更新した後も、`mise run setup`を再実行します。

## 共通タスク

| タスク | 内容 |
| --- | --- |
| `mise run setup` | Go/Nodeと組込みSQLiteの確認、Analyticsの開発依存を`npm ci`で準備 |
| `mise run check` | Goのgofmt確認・テスト・vet、Analyticsの`npm test`・型検査。LinuxではGoの`-race`も実行 |
| `mise run release:ubuntu:amd64` / `release:ubuntu:arm64` | setup→全チェック→結合試験に成功後、対象CPUのアーカイブとSHA-256を作成・検査 |
| `mise run package:ubuntu:amd64` / `package:ubuntu:arm64` | アーカイブ作成・展開検査のみ。リリース検証の成功は保証しない |
| `mise run integration` | 模擬Hub、実Go Collector、Node Analytics、SQLite、SSE、outbox再送・バックアップの結合試験 |
| `mise run demo:hub` | ループバック限定の合成Hubを起動 |
| `mise run demo:analytics` | `analytics/configs/demo.json`でAnalyticsを起動 |
| `mise run demo:collector` | `collector/configs/collector.demo.json`でCollectorを起動 |

デモは3つのターミナルをリポジトリールートで開き、`mise run demo:hub`、`mise run demo:analytics`、`mise run demo:collector`をそれぞれ実行します。WindowsとLinuxで同じコマンドを使えます。デモ用トークンはタスク内で設定され、本番設定へ流用しません。

Linuxで`mise run check`のRace Detectorを実行するにはCコンパイラーが必要です。Ubuntuでは`sudo apt-get install build-essential`を事前に実行してください。Windowsの共通チェックにはRace Detectorを含めません。

## 個別ツールと結合試験

- `check-runtime.mjs`: Node.jsの最低版、組込みSQLite、TypeScriptコアの直接importを確認します。単独で実行する場合は`mise exec -- node --experimental-strip-types tools/check-runtime.mjs`です。`mise run setup`にも含まれます。
- `check-go-format.mjs`: Collector配下のGoファイルをgofmtで検査します。通常は`mise run check`から呼び出します。
- `integration.mjs`: 一時ディレクトリーへ模擬Hub/Collectorを用意して2 Hubの実HTTP結合を検査します。Analytics停止中のoutbox、復旧後の再送、重複防止、再接続、SQLiteバックアップを検証します。実Hub・固定本番設定・永続DBは使いません。単独で実行する場合は次のコマンドを使います。

```text
mise exec -- node --experimental-strip-types tools/integration.mjs
```

結合試験はGoとNode.jsだけを使い、npmパッケージは参照しません。ただし、先に`mise install`を実行して固定版ランタイムを用意してください。

## 既存スクリプトを直接使う場合

`bootstrap`スクリプトは`mise install`と`mise run setup`、`test`スクリプトは`mise run check`を呼びます。旧`-InstallDevTools`/`--dev-tools`と`-Typecheck`/`--typecheck`は互換用に受け付けますが、開発依存の導入と型検査は常に含まれます。

既存のPowerShell/Bashスクリプトも、固定版ランタイムを確実に使うため`mise exec --`から起動します。

```powershell
mise exec -- pwsh -File .\scripts\test.ps1 -Typecheck
mise exec -- pwsh -File .\scripts\run-analytics.ps1 -Demo
```

```bash
mise exec -- bash scripts/test.sh --typecheck
mise exec -- bash scripts/run-analytics.sh --demo
```

新しい作業では、OSごとに引数を変えるスクリプトより共通の`mise run setup`、`mise run check`、`mise run integration`、`mise run demo:*`を優先します。`mise exec --`の詳細は[mise exec](https://mise.jdx.dev/cli/exec.html)、タスクの詳細は[mise run](https://mise.jdx.dev/cli/run.html)を参照してください。

## リリースパッケージ

`package-ubuntu.mjs`はGo・Node・OSの`tar`を使い、必要な実行ファイル・設定例・文書を明示リストから同梱します。ローカル設定が同じディレクトリーにあってもディレクトリーごとコピーしません。新しい実行時モジュールを追加する場合は、このリストも更新してください。SQLマイグレーションは番号付きの`.sql`をすべて同梱します。

パッケージタスクは`check-package.mjs`も実行し、SHA-256、私的ファイルの混入、Linux ELFの対象CPU、空白を含む一時パスへの展開とAnalyticsのHTTP/SQLite起動を検査します。arm64バイナリーの実行試験ではありません。既存の同名アーカイブとチェックサムは再作成時に置き換わります。

転送・systemdへの配置・更新は[Ubuntu手順](../docs/UBUNTU.md)に従います。miseタスクはSSH接続やサービス停止を実行しません。

## 実行結果の扱い

`integration.mjs`は、実行した環境の終了コードとログを確認して結果を記録します。Windows実機で未実行の手順をWindows成功とは記録せず、LinuxのRace Detectorも`build-essential`がない環境では成功と扱いません。環境構築・テスト・パッケージ生成・実機運用の結果を分けて記録してください。
