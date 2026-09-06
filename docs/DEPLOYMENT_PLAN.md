# Ubuntu公開の再計画

状態: 実装・正式発行済み（2026-09-06）。Tailscaleを閲覧の認証境界として運用する。新規ホストでの構築と実OS再起動の受入試験は未実施。操作手順は[PUBLICATION](PUBLICATION.md)を参照。

## 固定する前提

- 新規Ubuntuから環境構築・設定・検証・発行をmiseタスクで管理する。
- sudoが必要なOS・権限・再起動後の常駐準備は`provision:ubuntu`へ集約する。
- `publish:ubuntu`は指定された通常ユーザーで完結する。sudo、管理者用更新ヘルパー、sudoers追加は使わない。
- タスクは現状と期待状態を比較し、満たしていればスキップする。設定・秘密値・SQLite・outboxを再生成／消去しない。
- 閲覧はTailscale経由の直接HTTP接続。Jellyfinと既存Tailscale Serveの設定は保持する。
- 環境準備とHub・認証設定を分離する。Hub未設定でもOS・常駐基盤は構築できる。

## 現状の確認

このPCのTailscale IPv4は100.69.11.74、DNS名はhome-ubuntu.tail1bf795.ts.net。正式アプリのユーザーサービスはactive/enabled、lingerは有効。デモの127.0.0.1:8787とは別の正式DB・outboxを使用する。

正式閲覧先は`http://home-ubuntu.tail1bf795.ts.net:8788`。認証入力なしのHTTP/SSE疎通を確認済み。IP・DNS名はコードに固定せずTailscaleから検出し、設定として保持する。

## 接続構成

- ブラウザー → Tailscale IP:8788 → Analytics閲覧専用HTTP/SSE。
- Collector → 127.0.0.1:8788 → Analytics ingest。
- Hub → Collectorは既存のSSE。

Analyticsは同じ1プロセス・1 SQLite接続管理・1取込みtransaction直列化を維持し、2つの待受を共有する。閲覧用待受ではingestを認証値に関係なく拒否する。受信ヘッダーから待受の役割やユーザーを推測しない。

現在のnon-loopback HTTP禁止を、明示的なTailscale閲覧モードに限って拡張する。検出したTailscale IPへのbindを必須とし、`viewerAuth.mode=tailscale`で閲覧認証を省略する。0.0.0.0やLAN IPへbindしない。デモモードのloopback制限を保持する。

今回追加したnginx/TLS/Serve必須の配置処理と例示設定は、この構成に合わせて整理する。既存OS上のJellyfin、他サービスのnginx／Serveを削除・再設定しない。

## タスクの責務

| タスク | 権限 | 処理 |
| --- | --- | --- |
| `provision:ubuntu` | 必要箇所だけsudo | 不足OS依存、Tailscale導入・接続状態確認、発行ユーザーの配置権限、ユーザーsystemd定義、lingerを準備 |
| `configure:ubuntu` | 通常ユーザー | IP・DNS・ポートを検出し私的設定を初期化。Hub設定を受取り、取込みトークンを初期化し既存値を保持。閲覧モードをtailscaleへ統一 |
| `publish:ubuntu` | 通常ユーザー | 前提検査、検証、同一成果物の作成・配置、バックアップ、アプリ再起動、疎通確認 |
| `status:ubuntu` | 通常ユーザー・読取りのみ | 構築状態、設定充足、サービス、待受、履歴受信、正確な閲覧URLを報告 |

mise自体が未導入の新規Ubuntuには薄いbootstrap入口を用意する。mise導入後の処理はmiseタスクへ委譲し、同じ環境構築処理をシェルとmiseで二重管理しない。

Tailscaleの新規ログイン承認だけは、管理者による初回操作になり得る。接続済みのPCでは再ログインや既存設定のリセットを行わない。Hub Secret等は非表示入力または保護されたファイルから読み、ログへ出さない。自動化では対話せず、不足項目を安全に報告して失敗終了する。

## 実装・受入の順序（未実施項目は末尾に記載）

1. タスクの境界と設定モデルを整理する。rootによる環境構築と通常ユーザーの発行を分け、nginx・証明書パスを必須から外す。私的ファイルとエディターの一時ファイルをGit除外する。
2. 新規構築と再実行を実装する。OS依存・Tailscale・配置権限・user unit・lingerを検査し、不足だけ補う。起動時のTailscale準備遅延を再試行で扱う。
3. 手作業のJSON編集を減らすconfigureを実装する。利用者が入力するのはHubのURL・秘密値等の固有情報に絞り、IP・DNS・内部パス・認証生成はタスクで処理する。
4. 閲覧とingestを待受で分離し、Tailscale直接接続に対応する。IP変更・ポート競合は検出して停止し、他サービスを上書きしない。
5. 通常ユーザーの発行を完成させる。構築タスクと排他し、検証対象と配置対象を同じ不変成果物にする。変更時だけCollector→Analytics停止、DBバックアップ、コード切替、起動、受信・閲覧検証を行う。
6. このPCで管理者がprovisionを実行し、通常ユーザーでconfigure→publishを実行する。初回成功後に各タスクを再実行し、設定・データ・PID・成果物・バックアップ件数を比較する。
7. Tailscale接続済みの別端末から認証入力なしの閲覧・SSEを確認する。利用者の都合に合わせた実OS再起動後に、ログインなしでの起動と履歴保持を確認する。

## 冪等性と失敗時の基準

- 導入済みOS依存や既存Tailscale接続を変更しない。OS全体のupgradeを自動で実施しない。
- 同一unit・設定では書換え・稼働中サービスの再起動をしない。停止中／無効化されたサービスは必要に応じて復旧する。
- 同一成果物・設定での発行は、コード交換・認証再生成・DBバックアップ増殖をしない。疎通検証は省略しない。
- 秘密値・設定・DB・outbox・過去リリースを保持し、途中失敗でも同じタスクから再試行できる。
- データマイグレーション後に旧コードを自動復元しない。失敗箇所を安全に示し、公開成功とは記録しない。
- 任意の入力から管理者処理へ進まず、必要な前提を変更前に確認する。設定不足をsudo/flockエラーに言い換えない。

## 受入条件

Goの整形・test・vet・Linux race、Analyticsテスト・tsc、既存結合試験に加え、2待受の分離、Tailscale限定bind、認証、SSE、設定初期化の再実行、発行の再実行、途中失敗後の復旧を検証する。

同じPCからの疎通、別Tailscale端末からの疎通、systemdユーザーサービスの再起動、OS再起動を別々に記録する。未実施の新規Ubuntu／Windows／OS再起動試験を成功と書かない。

完成時は、初回の環境構築後に通常ユーザーの`mise run publish:ubuntu`だけで更新可能であり、`status:ubuntu`が実際に確認した閲覧URLと受信状態を表示すること。

## 実装・検証結果（2026-09-06）

- bootstrap、provision、configure、publish、statusを実装。構築から旧公開JSON・nginx・証明書依存を除去。
- 管理者によるprovisionと、通常ユーザーによるconfigure・publishを実ホストで完了。正式サービスはactive/enabled、linger有効。
- 発行時のGo race/test/vet、Analytics 46件、発行関連10件、型検査、実HTTP/SSE/SQLite結合試験を通過。
- Tailscaleの実インターフェースで認証なしの閲覧・外部ingest遮断・loopback取込み・共有SQLite/SSEを確認。既存Basic/loopbackモードの試験も維持。
- `status:ubuntu`で閲覧URLへの認証なしの疎通と実Hub観測データの保存を確認。
- 旧版バックアップ処理が新しい設定モードを読めない問題を修正。検証済み新版のバックアップ処理を使用し、正式更新を完了。
- amd64の最新版成果物を作成・検査・配置済み。arm64は2026-09-05時点の内容・ELF・チェックサム検査までで、今回の認証変更後は未再検証。
- 未実施: 新規Ubuntuからの全工程、Windows、arm64実行、OS再起動、24時間連続稼働。別端末からの認証除去後のブラウザー確認も別途行う。
- 設定再実行による秘密値保持と実ユーザーサービスの再起動・SQLite保持は試験済み。実ホストで同一発行を繰り返した際のPID・バックアップ件数比較は未実施。
