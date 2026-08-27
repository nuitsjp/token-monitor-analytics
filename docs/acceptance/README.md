# 受入ゲートの証跡

`wails3 task acceptance` は、規範要件、画面受入キー、デザインシステム共通規則を自動試験名または手動証跡へ結び付け、`report.json` を生成する。報告は未実施の項目を合格へ補完せず、未実施は `pending`、SP-01 の不足やクリーン Windows 実演の不足は `blocked` としてゲートを失敗させる。

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
