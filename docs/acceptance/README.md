# 受入ゲートの証跡

`wails3 task acceptance` は、規範要件、画面受入キー、デザインシステム共通規則を自動試験名または手動証跡へ結び付け、`report.json` を生成する。Go は `go test -json -count=1`、Vitest と Playwright は JSON reporter で結果を取得し、試験名に含まれる ID ごとに結果を照合する。報告は未実施の項目を合格へ補完せず、結果が照合できない項目は `pending`、skip された項目は `skip`、SP-01 の不足やクリーン Windows 実演の不足は `blocked` としてゲートを失敗させる。別の試験の失敗は、成功した個別項目の結果を書き換えない。

`wails3 task release:verify` は、先に `verify` でカバレッジを含む自動試験を一度だけ実行し、その成功結果を `acceptance:release`（`-ReuseVerifiedTests`）で再利用する。これにより受入スクリプトが Go、Vitest、Playwright を二重実行しない。再利用時のレポートには `automatedTestsReused: true` を記録する。通常のE2Eで実行するのは `window-routing.spec.ts` であり、`showcase-screenshots.spec.ts` は別の画面証跡試験として `pending` のまま扱う。

`release:verify` の最後に `test:wails` を実行する。このタスクはCIでは実行せず、Windows上でWailsのproduction binaryをビルドし、NSIS installerを作成した後、両方が有効なPEファイルであること、対象アーキテクチャのinstallerが生成されたこと、SHA-256を取得できることを `scripts/check-windows-package.ps1` で確認する。既定アーキテクチャは `amd64` で、必要なら `ARCH=arm64` を指定する。`test:windows` はadapter、restore、race試験を行う別のローカル拡張タスクであり、GitHub Actionsへは追加しない。

追跡対象は Phase 1 と Phase 2 の要件 ID（`P1-*`、`P2-*`、`QL-*`、`AC-P1-*`、`AC-P2-*`）を含む。画面受入キーは `SCREEN-COMMON`、`SCREEN-T01`、`SCREEN-M00` から `SCREEN-M11` までの14キーで、`SCREEN-M02` を含める。Phase 2 の最終ゲートは T-065 であり、クラウド同期・クラウド保存・サーバー実装は Phase 2 の受入対象外である。

手動証跡を追加する場合は、追跡対象へ含める JSON を `docs/acceptance/evidence/` 以下へ置く。JSON の各要素は次の形式とする。

```json
[
  {
    "id": "AC-P1-25",
    "testName": "AC-P1-25 clean Windows backup handling",
    "result": "pass",
    "evidencePath": "docs/acceptance/evidence/ac-p1-25.png",
    "artifactPath": "docs/acceptance/evidence/backup.zip",
    "cleanWindows": true
  }
]
```

`id` は規範要件、画面キー、または `DESIGN-SYSTEM-02` から `DESIGN-SYSTEM-09` までの共通規則キーの完全一致、`testName` は実施した試験名、`evidencePath` は存在する証跡ファイルを指定する。`cleanWindows` が必要な項目では、クリーンな Windows プロファイルの証跡であることを `true` と明示する。`artifactPath` は任意で、報告へはファイル内容ではなく検査時に計算した SHA-256 だけが記録される。

証跡 JSON、証跡ファイル、成果物には資格情報、アクセストークン、Cookie、復号鍵、原 JSON 本文を含めない。自動生成される `docs/acceptance/report.json` は追跡対象外である。
