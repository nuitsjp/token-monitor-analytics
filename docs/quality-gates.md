# 品質ゲート

## 1. Blocking検査

Pull Requestでは、Windows runnerからリポジトリ直下のTaskfileと同じ入口を実行する。

- `policy:check`: 要件・画面・アーキテクチャ・デザイントークン・SQL・migration・依存版のrepo固有規則
- `generate:check`: sqlc生成物とWails bindingが追跡済み内容と一致すること
- `fmt:check`: Goとfrontendの整形が追跡済み内容と一致すること
- `lint`: Go、TypeScript、React、アクセシビリティ、PowerShellの静的解析
- `security:check`: Goとnpmの既知脆弱性、および秘密情報
- `test`: Go、SQLite integration、frontend、復元受入試験のカバレッジゲート、およびbrowser E2E
- `build`: Windows production build
- `workflow-policy`: GitHub Actions自体の`actionlint`と`zizmor`

生成物検査は一時ディレクトリへ出力し、追跡済みファイルを変更しない。通常のE2Eは参照スクリーンショットを更新せず、更新は専用タスクだけで行う。

Goのカバレッジは自動生成した`sqlcgen`を対象外とし、rootと`internal`の手書きコードについてstatement 71.0%以上を要求する。frontendは`src`の手書きコードについて、line 68%以上、branch 58%以上、function 57%以上、statement 66%以上を要求する。Go 72.2%、frontend line 71.27%・branch 58.81%・function 64.94%・statement 69.41%の実測を同一条件で確認し、一時的な微小差で失敗しない余白を残して段階的に設定した。除外対象や閾値を下げる変更はレビューで理由を確認する。

カバレッジ検査は計測境界も検査する。Goは`go list . ./internal/...`から`/sqlcgen`を除いたパッケージだけを計測し、生成された`coverage.out`に範囲外または`sqlcgen`のファイルがあれば失敗する。frontendは`frontend/vitest.config.ts`の`src/**/*.{ts,tsx}`、テストファイル、`src/test/**`、`src/vite-env.d.ts`のinclude/exclude契約を確認し、`json-summary`と`lcov`の両レポートが`src`の範囲内にあることを確認する。各検査は`coverage-diagnostics.txt`に境界契約、総合値、領域別・ファイル別の未達を出力する。

ローカルの`test:coverage:go`と`test:coverage:frontend`は既定で一意な一時ディレクトリへ出力し、終了時に削除する。調査で保存する場合は、それぞれのスクリプトに`-OutputDirectory <path>`を指定する。CIでは`GO_COVERAGE_OUTPUT_DIRECTORY`と`FRONTEND_COVERAGE_OUTPUT_DIRECTORY`をrunnerの一時領域に指定し、`coverage.out`、`coverage.func.txt`、`coverage-summary.json`、`lcov.info`、`coverage-diagnostics.txt`を`if: always()`のartifact uploadで7日間保存する。したがって通常の検査はworkspaceへカバレッジ残骸を残さない。

`release:verify`は上記の全品質検査に加え、規範受入レポートを生成して全項目がpassであることを要求する。開発途中のpending・blockedを通常PRのCI失敗へ変換しないため、規範受入ゲートはリリース判断時に実行する。

`test:windows`、`test:stability`、`test:fuzz`はローカル拡張試験であり、現時点のGitHub Actionsでは実行しない。Windows固有試験のCI接続はセルフホストランナー準備後にIssue #5で行う。browser E2Eは既存dev serverを再利用せず、失敗時のtrace、動画、スクリーンショットを`frontend/test-results`へ出力し、CI失敗時だけartifactとして保存する。

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
