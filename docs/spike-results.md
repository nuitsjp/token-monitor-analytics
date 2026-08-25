# 実装前スパイク結果

## SP-01 Hub API 契約

状態: **不合格（対応 Hub 待ち）**

2026-08-25 に評価用 Hub `192.168.0.16:17321` を二回連続で確認した。

- `/api/health` は HTTP 200 で、`schemaVersion=1`、`runtime=node-hub`、`coreRevision=11`、`runtimeRevision=1` を返した。二回の `hubBuild` は一致した。
- 認証済み `/api/stats` は HTTP 200 で、応答サイズは 1,349,168 bytes と 1,349,169 bytes だった。
- `/api/stats` のトップレベルは `updatedAt`、`periods`、`devices`、`projectsIncomplete`、`limits`、`staleAfterMs`、`historyPreview`、`historyRevision`、`deviceHistoryRevision`、`subscriptionsUpdatedAt` だった。
- 二回とも応答全体に `usageUpdatedAt` が存在しなかった。一方、トップレベルの `updatedAt` は約 1.3 秒で変化したため、利用額観測時刻へ代用できない。

HTTP クライアントの固定値は、接続 5 秒、応答全体 15 秒、応答本文上限 8 MiB とする。実測応答に対して約 6 倍の余裕があり、無制限読込みを避けられる。暗黙の再試行は行わない。

`usageUpdatedAt` を提供する対応 Hub が利用可能になるまで、T-012 の利用額正規化、T-031 の対応観測、およびそれらに依存する受入れは完了にしない。取得時刻や `devices[].updatedAt` へのフォールバックは実装しない。

## SP-02 Wails Windows 複数ウィンドウ

状態: **一部合格**

Wails CLI と Go module を `v3.0.0-beta.12` に一致させ、固定した Go 1.26.7 で Windows GUI 実行ファイルを生成できた。T01 の `AlwaysOnTop` と最小化・最大化ボタン無効化はビルドへ含めた。

単一 M00、フォーカス非奪取、Alt+F4、DPI・モニター復元、全体終了は T-002 の実装とパッケージ済みアプリによる手動確認が未完了である。

## SP-03 SQLite バックアップと入替え

状態: **一部合格**

- Wails beta.12、modernc.org/sqlite v1.57.0、modernc.org/libc v1.74.4 を同一 Go module graph で Windows GUI ビルドできた。
- sqlc v1.31.1 で初期スキーマの型付き設定 SQL を生成し、実ファイル SQLite 試験に通した。
- WAL 中の commit 済み変更を Online Backup API で別 DB へ複製し、読戻し後に全接続を閉じて同一ディレクトリ内で rename できることを確認した。
- `journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000` を実接続で確認した。

復元入替え全段階の強制終了と次回起動回復は T-044 のプロトコル実装前には完了できないため、SP-03 の最終ゲートは未完了である。

## SP-04 階数判定と非負最小二乗法

状態: **合格**

列 L2 正規化後の SVD、要件の階数許容差、Lawson-Hanson active-set NNLS を `nnls-lawson-hanson-v1` として固定した。NNLS の KKT 条件を解ごとに検査し、反復上限を 10,000 とする。AC-P1-13 から AC-P1-19、行順入替え、表示丸め前の 10% 閾値を Go 試験で確認した。実行時の別解法フォールバックは設けない。

## SP-05 資格情報と機微データ境界

状態: **未完了**

Hub ごとの Generic Credential と原 JSON の許可・禁止・未知フィールド分類を T-010 より前に固定する。評価用共有シークレットはソース、fixture、SQLite、ログ、文書へ保存していない。
