# 実装前スパイク結果

## SP-01 Hub API 契約

状態: **収集契約合格・利用額推定契約不合格**

2026-08-25 に評価用 Hub `192.168.0.16:17321` を二回連続で確認した。

- `/api/health` は HTTP 200 で、`schemaVersion=1`、`runtime=node-hub`、`coreRevision=11`、`runtimeRevision=1` を返した。二回の `hubBuild` は一致した。
- 認証済み `/api/stats` は HTTP 200 で、応答サイズは 1,349,168 bytes と 1,349,169 bytes だった。
- `/api/stats` のトップレベルは `updatedAt`、`periods`、`devices`、`projectsIncomplete`、`limits`、`staleAfterMs`、`historyPreview`、`historyRevision`、`deviceHistoryRevision`、`subscriptionsUpdatedAt` だった。
- 二回とも応答全体に `usageUpdatedAt` が存在しなかった。一方、トップレベルの `updatedAt` は約 1.3 秒で変化したため、利用額観測時刻へ代用できない。

HTTP クライアントの固定値は、接続 5 秒、応答全体 15 秒、応答本文上限 8 MiB とする。実測応答に対して約 6 倍の余裕があり、無制限読込みを避けられる。暗黙の再試行は行わない。

この Hub ビルドを収集専用契約として許可リストへ固定する。原 JSONと `providers[].updatedAt` を持つ利用枠観測は収集する一方、`usageUpdatedAt` がない利用額から正規化済み利用額観測や推定観測点を作らない。取得時刻や `devices[].updatedAt` へのフォールバックは実装しない。

## SP-02 Wails Windows 複数ウィンドウ

状態: **一部合格**

Wails CLI と Go module を `v3.0.0-beta.12` に一致させ、固定した Go 1.26.7 で Windows GUI 実行ファイルを生成できた。T01 の `AlwaysOnTop` と最小化・最大化ボタン無効化はビルドへ含めた。

T01 と単一 M00 の生成、既存 M00 の復元・前面化、T01 の全体終了確認、M00 の dirty-state 終了確認を実装した。公式 ZIP の公開 SHA-1 を照合した NSIS 3.12 で、ユーザー単位の Windows インストーラーをクリーン入力から生成できた。

Alt+F4、DPI・モニター復元、フォーカス非奪取、複数モニター、全体終了のパッケージ済みアプリによる手動確認は未完了である。

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

状態: **一部合格**

Windows Generic Credential の Target を `TokenMonitorAnalytics/Hub/{Hub 識別子}` に固定し、Hub ごとの書込み、読出し、削除、相互分離を Windows 実機試験で確認した。秘密値は UTF-16LE の blob だけに格納し、Target、エラー、監査へ含めない。評価用共有シークレットもソース、fixture、SQLite、ログ、文書へ保存していない。

原 JSON の許可・禁止・未知フィールド分類は、収集専用契約として確認した評価 Hub のフィクスチャを基準に固定する。利用額推定対応契約は `usageUpdatedAt` を提供する Hub を確認するまで未完了とする。
