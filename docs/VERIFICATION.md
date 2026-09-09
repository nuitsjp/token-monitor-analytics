# 検証記録 — 親 Issue #19

この文書は、親 Issue #19 の受入条件と、2026-09-09 時点で実行した証跡を対応付ける。最新の CI 対象 checkout は `8158ffa3d6b4e63441c45a56bdad8190d2e38c21`、Node.js は 24.20.0 である。証跡ファイルは一時的なオーケストレーション領域（`/tmp/tma-orchestration`）に保存している。

**親 Issue の判定は保留。** 単一アプリの機能、SQLite/SSE、管理、履歴、更新、移行の Linux ポータブル検証は完了している。Windows の実旧環境 CLI 移行・復旧と Ubuntu の分離 guest での移行・rollback は、成功した証跡が揃うまで未達として扱う。

判定欄の `✅` は記載した試験が成功、`◐` は一部の証跡が成功しているが受入条件全体は未完、`⏳` は再実行または実環境の証跡待ちを表す。

## 親 Issue #19 受入条件との対応

| #19 の条件 | 実行結果・証跡 | 判定 |
| --- | --- | --- |
| 空 DB、Hub 0 件から UI 登録、snapshot 保存・表示。常駐アプリ・閲覧待受・SQLite は各 1 つ | `native-db-integration.log`（`INTEGRATION OK`）、`integrated-manage.log`（`MANAGEMENT INTEGRATION OK`）、`hubs-review-suite2.log`（75 tests / 75 pass） | ✅ |
| 新規導入と移行後が同じ起動設定・schema・通常コードを使い、旧 Collector 入力に依存しない | `migration-real-first.log`（旧 SHA の実 server 2 tests / 2 pass）、`tools-baseline.log`、`native-db-analytics.log`。旧 source は `cae687c4947990e9da6db3193ea8afe26b4b5246` に固定 | ◐ |
| 観測保存・推定・最新値更新を同期 transaction で原子的に行い、COMMIT 後だけ通知する | `collection-readiness-review.log`、`native-db-analytics.log` の storage failure rollback、`history-final-suite.log` の同期 transaction・古い時刻・null/0・同値回帰 | ✅ |
| SSE の分割・EOF・サイズ・heartbeat・認証・redirect・backoff・Hub 障害分離・正常終了を検証する | `collection-readiness-review.log`（SSE/collection 14 tests / 14 pass）、`native-db-integration.log`（SSE→SQLite→browser SSE、再接続） | ✅ |
| Hub の追加・停止・再開・archive・URL/Secret 変更、version 競合、Secret 保存後 DB 失敗、旧 callback を検証する | `hubs-review-suite2.log`、`integrated-manage.log`。opaque secret、CAS、archive、disable/re-enable、保存失敗後の旧行保持を確認 | ✅ |
| 起動・再接続・revision・手動操作で履歴を取得し、失敗・通知連続時も件数を制限する | `history-final-suite.log` の revision scheduler、in-flight 世代、failure 後 dirty state、実 HTTP 境界 | ✅ |
| device 削除・disabled/null/missing、帰属・timezone・0/未知・不正/巨大応答で誤った合計を表示せず、再取得を二重計上しない | `history-final-suite.log` の normalization/storage（省略行保持、削除と capability の区別、16 MiB 制限、重複回避） | ✅ |
| 停止中の日跨ぎ実績を補完し、limit 時系列・推定を生成せず、日次/月次を二重計上しない | `history-final-suite.log` の明示的な JST 日境界と scheduler、`native-db-integration.log` の UTC day advance は成功。停止中の日跨ぎ専用の実環境証跡は未完 | ◐ |
| SQLite 保存失敗と上流不正を分け、最大履歴の応答・終了を測定する | `final-history-performance.log` / `final-history-performance.json` は 1 test pass。16,746,765 bytes（上限 16,777,216）、超過 16,841,741 bytes は拒否、94,720 行、transaction 980.5 ms、同時 HTTP 985.96 ms、shutdown 19.3 ms | ✅ |
| drain の ACK 不明・破損・中断・再実行、drain 後 backup からの復旧、ACK 済み観測保持、旧履歴読取りを検証する | `migration-windows-cleanup-retry.log`（11 / 11 pass）、`migration-isolated-paths.log`（12 / 12 pass）、`migration-real-first.log`（旧 server 2 / 2 pass）。manifest は `/tmp/tma-orchestration/pinned-legacy-cae-manifest.json` | ◐ |
| analytics test・typecheck・tools test・3 本の integration と、移行前の Go 検証を実行する | 基準 CI [run 34376000212](https://github.com/nuitsjp/token-monitor-analytics/actions/runs/34376000212)（commit `d4cc3e6`、Ubuntu/Windows とも success）。ローカルは `native-db-analytics.log`（103 / 103）、`native-db-types.log`、`native-db-integration.log`、`go-test.log`。[CI run 34379698164](https://github.com/nuitsjp/token-monitor-analytics/actions/runs/34379698164)（`8158ffa`）は Ubuntu/Windows とも success。追加の移行修正後に最終確認する | ◐ |
| Windows の path/Ctrl+C/file lock/ACL、Ubuntu service・reboot・Tailscale・同一内容再発行を確認する | `final-tailnet.log` と `tailnet-real-63f0d07.log` は 3 / 3 pass。Windows direct CLI と Ubuntu isolated guest の最終 migration/rollback は未完。[CI run 34379698164](https://github.com/nuitsjp/token-monitor-analytics/actions/runs/34379698164) は両 OS success、[guest run 34379698182](https://github.com/nuitsjp/token-monitor-analytics/actions/runs/34379698182) は新規導入・実 oneshot Web 更新・OS 再起動後の自動起動まで success | ⏳ |
| Secret を DB/API/log/static 配信/package に出さず、旧 ingest・Collector status・二重待受・定期設定同期・Go 起動依存を残さない | `native-db-integration.log` の旧 bridge なし、`hubs-review-suite2.log` の secret/API 境界、`migration-package-amd64.log` / `migration-package-arm64.log` の package 内容検査 | ✅ |
| Web 候補確認→SHA 検証・配置→停止/再起動→同じ jobId の完了、runner 継続、SSE・履歴復帰を確認する | `native-db-integration.log`（`UPDATE INTEGRATION OK`）、`integrated-tools.log`、`web-update-1b36e56.log`。実 runner、backup、停止/再起動、release identity、browser SSE、Hub/history resume を確認 | ✅ |
| 事前失敗時の旧アプリ維持、配置後起動失敗、runner 強制終了、終端状態競合、health 200 の誤判定、SHA 固定、CLI/Web 競合を試験する | `runner-47dbc86.log`（10 tests / 10 pass）、`integrated-tools.log`、`shutdown-notification-review.log` | ✅ |
| 配布 runner 一式を隔離 directory で起動し、旧 Go/Collector/checkout import や未配置ファイルへ依存しないことを確認する | `tools-baseline.log` の runner dependency closure、`integrated-tools.log`、`migration-package-amd64.log` / `migration-package-arm64.log` | ✅ |
| 旧 runner からの初回更新を拒否し、CLI 移行後の互換版更新と service/runner/構築記録の復旧を確認する | `migration-windows-cleanup-retry.log`、`migration-real-first.log`、`integrated-tools.log` の旧 layout/preflight/restore。実 Ubuntu guest と Windows direct CLI の通し結果は未完 | ◐ |
| 通常発行で Hub/Secret を保持し、観測増加・Hub 編集だけでは再起動せず、完了状態を中断へ戻さない | `native-db-integration.log`、`integrated-tools.log`、`publication-a7-review.log`、`shutdown-notification-review.log` | ✅ |

## 大規模履歴の測定値

`final-history-performance.json` はこの host の Node 24.20.0 で測定した opt-in artifact であり、性能保証値ではない。16 MiB 上限の直下では 16,746,765 bytes、256 device × 370 日の 94,720 行を処理した。同期 SQLite transaction は 980.5 ms、transaction と競合した 2 本の HTTP 応答は最大 985.96 ms、終了処理は 19.3 ms で、終了時の履歴取得は中断された。上限超過 16,841,741 bytes は拒否された。

## 検証中の fixture 事象

旧 fixture が既定の本番パスを参照し、protected backup の symlink 処理でリンク先へ chmod したため、実ホストで稼働中の `/opt/token-monitor-analytics/current` の参照先ディレクトリーの mode が `0755` から `0777` へ変わった。mode を `0755` に復元し、nested symlink がないことを確認した。`b92a98b` で symlink 先の live permission を保持し、`4d01945` で service unit と migration inventory を fixture directory に隔離した。この事象で本番 DB・設定・service を migration または restart していない。

## 残課題と実行範囲

- `8158ffa` の [pinned-source run 34379698257](https://github.com/nuitsjp/token-monitor-analytics/actions/runs/34379698257) は Ubuntu と Windows の portable fixture が成功したが、Windows direct CLI の復元時 ACL 処理が失敗した。run 全体は failure として扱う。
- [Ubuntu migration run 34379698237](https://github.com/nuitsjp/token-monitor-analytics/actions/runs/34379698237) も failure。両 OS の移行・復旧と停止中の日跨ぎ補完の残項目が通るまで、親 Issue は閉じない。
- 実ホストの production DB/config/service の移行・再起動は実施していない。実行したのは一時 fixture、portable integration、分離 guest、CI のみである。

運用手順は [PUBLICATION](PUBLICATION.md)、通常運用は [OPERATIONS](OPERATIONS.md)、初回切替と復旧は [MIGRATION](MIGRATION.md) を参照する。
