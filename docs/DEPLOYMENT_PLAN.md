# Ubuntu公開の再計画

状態: 計画。2026-09-05時点の実装を再整理する方針であり、この文書の手順が実装・公開済みという意味ではありません。

## 固定する前提

- 新規Ubuntuから環境構築・設定・検証・発行をmiseタスクで管理する。
- sudoが必要なOS・権限・再起動後の常駐準備は`provision:ubuntu`へ集約する。
- `publish:ubuntu`は指定された通常ユーザーで完結する。sudo、管理者用更新ヘルパー、sudoers追加は使わない。
- タスクは現状と期待状態を比較し、満たしていればスキップする。設定・秘密値・SQLite・outboxを再生成／消去しない。
- 閲覧はTailscale経由の直接HTTP接続。Jellyfinと既存Tailscale Serveの設定は保持する。
- 環境準備とHub・認証設定を分離する。Hub未設定でもOS・常駐基盤は構築できる。

## 現状の確認

このPCのTailscale IPv4は100.69.11.74、DNS名はhome-ubuntu.tail1bf795.ts.net。デモは127.0.0.1:8787で稼働しており、lingerは未有効。正式環境の構築は未完了。

正式閲覧先は`http://home-ubuntu.tail1bf795.ts.net:8788`を予定する。8788は現時点で空いているが、実行時にも検査する。9443を用いる前計画を置き換える。IP・DNS名はコードに固定せずTailscaleから検出し、設定として保持する。

## 接続構成

- ブラウザー → Tailscale IP:8788 → Analytics閲覧専用HTTP/SSE。
- Collector → 127.0.0.1:8788 → Analytics ingest。
- Hub → Collectorは既存のSSE。

Analyticsは同じ1プロセス・1 SQLite接続管理・1取込みtransaction直列化を維持し、2つの待受を共有する。閲覧用待受ではingestを認証値に関係なく拒否する。受信ヘッダーから待受の役割やユーザーを推測しない。

現在のnon-loopback HTTP禁止を、明示的なTailscale閲覧モードに限って拡張する。検出したTailscale IPへのbindとBasic認証を必須にする。0.0.0.0、LAN IPへのbindや認証省略を既定にしない。デモモードのloopback制限を保持する。

今回追加したnginx/TLS/Serve必須の配置処理と例示設定は、この構成に合わせて整理する。既存OS上のJellyfin、他サービスのnginx／Serveを削除・再設定しない。

## タスクの責務

| タスク | 権限 | 処理 |
| --- | --- | --- |
| `provision:ubuntu` | 必要箇所だけsudo | 不足OS依存、Tailscale導入・接続状態確認、発行ユーザーの配置権限、ユーザーsystemd定義、lingerを準備 |
| `configure:ubuntu` | 通常ユーザー | IP・DNS・ポートを検出し私的設定を初期化。Hub設定を受取り、未作成のingest／viewer認証だけ生成。既存値は保持 |
| `publish:ubuntu` | 通常ユーザー | 前提検査、検証、同一成果物の作成・配置、バックアップ、アプリ再起動、疎通確認 |
| `status:ubuntu` | 通常ユーザー・読取りのみ | 構築状態、設定充足、サービス、待受、履歴受信、正確な閲覧URLを報告 |

mise自体が未導入の新規Ubuntuには薄いbootstrap入口を用意する。mise導入後の処理はmiseタスクへ委譲し、同じ環境構築処理をシェルとmiseで二重管理しない。

Tailscaleの新規ログイン承認だけは、管理者による初回操作になり得る。接続済みのPCでは再ログインや既存設定のリセットを行わない。Hub Secret等は非表示入力または保護されたファイルから読み、ログへ出さない。自動化では対話せず、不足項目を安全に報告して失敗終了する。

## 実装順序

1. タスクの境界と設定モデルを整理する。rootによる環境構築と通常ユーザーの発行を分け、nginx・証明書パスを必須から外す。私的ファイルとエディターの一時ファイルをGit除外する。
2. 新規構築と再実行を実装する。OS依存・Tailscale・配置権限・user unit・lingerを検査し、不足だけ補う。起動時のTailscale準備遅延を再試行で扱う。
3. 手作業のJSON編集を減らすconfigureを実装する。利用者が入力するのはHubのURL・秘密値等の固有情報に絞り、IP・DNS・内部パス・認証生成はタスクで処理する。
4. 閲覧とingestを待受で分離し、Tailscale直接接続に対応する。IP変更・ポート競合は検出して停止し、他サービスを上書きしない。
5. 通常ユーザーの発行を完成させる。構築タスクと排他し、検証対象と配置対象を同じ不変成果物にする。変更時だけCollector→Analytics停止、DBバックアップ、コード切替、起動、受信・閲覧検証を行う。
6. このPCで管理者がprovisionを実行し、通常ユーザーでconfigure→publishを実行する。初回成功後に各タスクを再実行し、設定・データ・PID・成果物・バックアップ件数を比較する。
7. Tailscale接続済みの別端末から閲覧・Basic認証・SSEを確認する。利用者の都合に合わせた実OS再起動後に、ログインなしでの起動と履歴保持を確認する。

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

## 実装・検証結果（2026-09-05）

- bootstrap、provision、configure、publish、statusを実装。構築から旧公開JSON・nginx・証明書依存を除去。
- `mise run release:ubuntu:amd64`成功。Go race/test/vet、Analytics 46件、発行関連9件、型検査、実HTTP/SSE/SQLite結合試験を通過。
- Tailscale実インターフェースで二つの待受を起動し、閲覧認証・外部ingest遮断・loopback取込み・共有SQLite/SSEを確認。
- 通常ユーザーの実systemdサービス起動・再起動・SQLite保持を試験。試験用サービスは終了時に撤去。
- amd64/arm64アーカイブと内容・チェックサム検査成功。arm64 Collector本体の実行とWindows試験は未実施。
- 実ホストの`status:ubuntu`ではTailscale接続済み、環境構築記録・linger・正式アプリ設定・正式サービスは未準備。
- `publish:ubuntu`の実行は構築不足の事前検査で停止。sudo非対話検査はパスワード必須。正式公開、実Hub受信、OS再起動後の実動作は未確認。

次の操作は発行ユーザーのターミナルで`mise run provision:ubuntu`。その後、実HubのURLと保護ファイルを`configure:ubuntu`へ渡し、通常ユーザーの`publish:ubuntu`と`status:ubuntu`で発行を完了する。具体的な引数は[手順](PUBLICATION.md)を参照。
