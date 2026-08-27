# 品質ゲート

## 1. Blocking検査

Pull Requestでは、Windows runnerからリポジトリ直下のTaskfileと同じ入口を実行する。

- `policy:check`: 要件・画面・アーキテクチャ・デザイントークン・SQL・migration・依存版のrepo固有規則
- `lint`: Go、TypeScript、React、アクセシビリティ、PowerShellの静的解析
- `security:check`: Goとnpmの既知脆弱性、および秘密情報
- `test`: Go、SQLite integration、frontend、E2E、復元受入試験
- `build`: Windows production build
- `workflow-policy`: GitHub Actions自体の`actionlint`と`zizmor`

生成物検査は一時ディレクトリへ出力し、追跡済みファイルを変更しない。通常のE2Eは参照スクリーンショットを更新せず、更新は専用タスクだけで行う。

## 2. Advisory検査

`gosec`の全ruleとCodeQLはadvisoryとして収集する。`gosec`は`security:advisory`でJSONを`artifacts/gosec-report.json`へ出力する。初回指摘のレビューで実害のあるZIP展開量の`G110`を修正し、backupzip packageに対する`G110`を`security:check`のblocking ruleへ移した。CodeQLは専用workflowで結果をGitHub code scanningへ送る。

2026-08-27のgosec初回走査は47件だった。`G110` 1件はZIP entryの宣言値だけを信頼して無制限に展開していたため、期待サイズ+1 byteで読み取りを制限して解消した。残る46件は次の期限付き例外として逐件確認済みである。

- `G115` 6件: backup・restoreの4件は正数・実ファイルサイズ検証後の`int64`から`uint64`変換、credentialの1件はWindows APIのblob長、logical snapshotの1件は符号付き整数のbit列を固定する変換である。Scopeは指摘された6行、Ownerはbackend、Expiresは2026-12-31。
- `G202` 18件: SQLへ連結する値は固定列名、schemaから取得したquoted identifier、または要素数から生成する`?` placeholderだけであり、利用者入力をSQL構文へ連結しない。Scopeはsqlite adapterの18行、Ownerはpersistence、Expiresは2026-12-31。
- `G304` 11件: 対象pathは管理directory配下へ正規化・reparse point検査されたrestore/backup file、または利用者が明示選択したarchiveの読み取りである。Scopeはbackup・restore境界の11行、Ownerはbackup-restore、Expiresは2026-12-31。
- `G302` 2件: 指摘対象はfileではなくtemporary directoryへの`0700`指定であり、必要な所有者アクセスだけを許す。Scopeは2つの`os.Chmod`、Ownerはbackup-restore、Expiresは2026-12-31。
- `G103` 9件: Windows Credential Manager、timezone、atomic replaceを呼ぶために必要なWindows API境界で、pointerの寿命と解放を同じ関数内に限定する。Scopeは3つのWindows adapter、Ownerはwindows-platform、Expiresは2026-12-31。

`noUncheckedIndexedAccess`と`exactOptionalPropertyTypes`は本Issueではblockingにしない。

2026-08-27に両optionを同時指定して`tsc --noEmit`を実行した結果、15ファイルに37件の既存エラーを検出した。主な分類は、配列indexの未確認アクセスと、optional propertyへ`undefined`を明示代入する箇所である。この結果は別の変更単位で解消し、本Issueのblocking設定には含めない。

## 3. 抑止の記録

静的解析の抑止には、rule名、理由、対象範囲、所有者、期限を同じコメントまたは設定へ記録する。これらのいずれかを欠く恒久的なbaselineは追加しない。

`@typescript-eslint/require-await`の設定例外は、Promise形状のbackend facadeとtest fakeが同期fixtureを返す範囲に限定している。Reactの行単位の抑止は、外部adapterとの同期、選択に追従するeditor state、およびhookとcomponentの同居に限定する。各行の直前にrule名、理由、対象範囲、所有者、期限を記録し、policy testで欠落を検出する。現在の所有者はfrontend、期限は2026-12-31である。
