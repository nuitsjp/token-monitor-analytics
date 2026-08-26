# モック Hub 全画面スクリーンショット

このページの全 38 枚は、実 Hub ではなく組み込みのモック Hub が返すサンプルデータで生成しています。
再生成コマンドは `mise run mock:screenshots` です。

## T01 コンパクトウィンドウ 採用案（静的 HTML）

上段は案B（Today / This month を 1 行ずつ、トークンと金額を同じ行に）、リストは案A（枠名＋残量 % → フル幅ゲージ → リセット日時）。
金額は USD、月次トークンは 10 億単位（B）。Today / This month / Reset は英語表記で、リセットの日付・時刻は固定列＋等幅数字で桁を揃えています。
本文フォントは Inter Variable（OFL、`docs/design-samples/fonts/`）。
元ファイルは `docs/design-samples/t01-compact-adopted.html`（未実装のたたき台）。

![T01 採用案](./T01-adopted.png)

## T01 コンパクトウィンドウ デザイン案（静的 HTML）

上段に日次／月次の利用トークンと利用金額、下段に利用枠を縦方向へ 4 件以上並べた 3 案です。
元ファイルは `docs/design-samples/t01-compact-options.html`（未実装のたたき台）。

### 3 案の比較

![T01 デザイン案 3 案の比較](./T01-options-overview.png)

### 案A　KPI 2×2 タイル

![案A KPI 2×2 タイル](./T01-option-A-kpi-tiles.png)

### 案B　KPI 横 2 行＋高密度リスト

![案B KPI 横 2 行＋高密度リスト](./T01-option-B-dense-list.png)

### 案C　今日を主役にしたスタック

![案C 今日を主役にしたスタック](./T01-option-C-hero-today.png)

## T01 コンパクトウィンドウ

### 通常

![T01 コンパクトウィンドウ](./T01-compact.png)

### 展開

![T01 コンパクトウィンドウ（展開）](./T01-compact-expanded.png)

### プライバシーモード

![T01 コンパクトウィンドウ（プライバシーモード）](./T01-compact-privacy.png)

## M00・M01 メインウィンドウ・概要

![M00・M01 メインウィンドウ・概要](./M00-M01-overview.png)

## M03 利用上限・価値

### 一覧

![M03 利用上限・価値](./M03-limits.png)

### 詳細・現在

![M03 詳細・現在](./M03-limit-detail-current.png)

### 詳細・利用枠系列

![M03 詳細・利用枠系列](./M03-limit-detail-series.png)

### 詳細・品質

![M03 詳細・品質](./M03-limit-detail-quality.png)

### 詳細・履歴

![M03 詳細・履歴](./M03-limit-detail-history.png)

### 詳細・根拠

![M03 詳細・根拠](./M03-limit-detail-evidence.png)

## M04 要確認

### 作業項目

![M04 要確認](./M04-review.png)

### 警告

![M04 警告](./M04-review-warnings.png)

## M05 アカウント・関連付け

### 論理アカウント

![M05 論理アカウント](./M05-accounts.png)

### Hub アカウント

![M05 Hub アカウント](./M05-accounts-hub.png)

### プラン履歴

![M05 プラン履歴](./M05-accounts-plan-history.png)

### 利用額関連付け

![M05 利用額関連付け](./M05-accounts-cost-link.png)

### 利用枠関連付け

![M05 利用枠関連付け](./M05-accounts-limit-link.png)

### 活動主体の完全性

![M05 活動主体の完全性](./M05-accounts-completeness.png)

### 収集端末・Hub 切替

![M05 収集端末・Hub 切替](./M05-accounts-hub-switch.png)

## M06 サービス・プラン

### サービス

![M06 サービス](./M06-catalog.png)

### 同定候補

![M06 同定候補](./M06-catalog-candidates.png)

### 利用枠定義

![M06 利用枠定義](./M06-catalog-limit-definitions.png)

### プラン

![M06 プラン](./M06-catalog-plans.png)

### プラン版・倍率

![M06 プラン版・倍率](./M06-catalog-plan-versions.png)

## M07 Hub・収集

### Hub 一覧

![M07 Hub 一覧](./M07-hubs.png)

### 取得履歴

![M07 取得履歴](./M07-hubs-collection-history.png)

## M08 観測と根拠

### 取得

![M08 取得](./M08-evidence.png)

### 原 JSON 一覧

![M08 原 JSON 一覧](./M08-evidence-raw-json.png)

### マスク済み原 JSON 詳細

![M08 マスク済み原 JSON 詳細](./M08-evidence-raw-json-detail.png)

### 元観測

![M08 元観測](./M08-evidence-observations.png)

### 利用枠系列

![M08 利用枠系列](./M08-evidence-limit-series.png)

### 計算根拠

![M08 計算根拠](./M08-evidence-calculation.png)

## M09 データ管理

### 容量

![M09 容量](./M09-data-management.png)

### バックアップ

![M09 バックアップ](./M09-data-management-backup.png)

### 復元

![M09 復元](./M09-data-management-restore.png)

### 明示パージ

![M09 明示パージ](./M09-data-management-purge.png)

## M10 監査記録

![M10 監査記録](./M10-audit.png)

## M11 表示設定

![M11 表示設定](./M11-settings.png)
