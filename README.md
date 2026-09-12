# Token Monitor Analytics

Token Monitor Analytics は、[Token Monitor](https://github.com/Javis603/token-monitor) Hub と連携し、定額制 AI サービス（Claude、ChatGPT など）の利用枠を可視化するセルフホスト型ダッシュボードです。API 換算額と消費率の実測増分から利用枠ごとの利用許容量（米ドル換算）を推定し、ローカル環境に記録・蓄積します。

---

## 前提条件

本システムは端末から直接データを収集せず、上流 Hub 経由で集約します。

- **Token Monitor Hub**: 端末側の利用状況を集約する上流 Hub（接続 URL と共有シークレットが必要。複数 Hub に対応）。動作確認用の模擬 Hub（Mock Hub）も同梱。
- **Node.js 24 LTS**: 実行環境（[mise](https://mise.jdx.dev/) に対応）。

---

## 主な機能

- **利用許容量の推定**: SSE で受信した現在値の観測に基づき、同一期間の API 換算額と消費率の実測増分比から、利用枠ごとの許容量を推定・記録。
- **取得情報の可視化**: プロバイダーやプランを問わず、取得できた利用枠・消費率・API 換算額を更新時刻や取得状態とともに表示（推定不可の場合も取得情報は閲覧可能）。
- **複数 Hub の集中管理**: 複数 Hub への並行接続、接続監視、Web 画面からの登録・一覧表示、および Hub 個別の収集停止・再開。
- **利用実績の自動補完**: Hub の保持履歴（`GET /api/devices`）を定期取得し、過去の日次・月次実績を自動収集・補完（端末の現地日付を維持）。
- **単一プロセスの軽量構成**: 外部 DB や Docker は不要。Node.js と組込 SQLite による単一常駐プロセス（Windows / Linux 対応）。
- **アクセス制御**: Basic 認証により、LAN や VPN 経由で安全にアクセス可能。

---

## 全体構成

```text
各端末 (Claude Code / ChatGPT 等)
   │ トークン利用実績・利用枠
   ▼
Token Monitor Hub (既存の上流環境 / 複数対応)
   │ SSE: 現在値のストリーミング受信
   │ GET: 保持履歴の定期取得
   ▼
Token Monitor Analytics (本システム / Node.js 常駐プロセス)
   ├─ Hub 接続管理 (並行受信・自動再接続)
   ├─ 推定・データ処理 (共通キューによる直列化)
   ├─ ローカル永続化 (組込 SQLite)
   └─ Web 配信 (ダッシュボード表示 / ブラウザ向け SSE / Basic 認証)
   ▼ (LAN / VPN / ローカルホスト)
Web ブラウザ (ダッシュボード閲覧 / Hub 管理)
```

---

## 設計ドキュメント

- [設計・実装ガードレール](docs/design-policy.md): システム目標、制約、品質要求、実装・検証の判断基準（正本）。
- [アーキテクチャ設計の進め方](docs/architecture-process.md): 設計手順、各文書の役割分担、設計完了基準。
- [用語定義](CONTEXT.md): ドメイン用語集。
- [アーキテクチャ設計書](docs/architecture.md): Hub API 仕様、データ識別・保存原則、受信処理の設計仕様。
