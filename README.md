# Token Monitor Analytics

Token Monitor Analytics は、[Token Monitor](https://github.com/Javis603/token-monitor) の Hub と連携し、定額制 AI サブスクリプション（Claude、ChatGPT 等）の利用枠を可視化するセルフホスト型ダッシュボードです。

API 換算額と消費率の実測増分から利用許容量（ドル換算）を逆算・推定し、ローカルに継続記録します。

---

## 前提条件

本ツールは端末から直接トークン量を収集しないため、以下の環境が必要です。

- **稼働中の Token Monitor Hub**: 端末側の利用状況を集約する上流 Hub（接続 URL と共有シークレットが必要。複数 Hub に対応）。
- **Node.js 24 LTS**: 実行環境（[mise](https://mise.jdx.dev/) 利用時は自動適用）。

※ 動作確認・開発用に模擬 Hub（ローカルモック）を同梱しています。

---

## 主な機能

- **利用許容量の逆算推定**: 実測した増分比（$\Delta\text{Cost} / \Delta\%$）から、利用枠あたりのドル建て許容量を推定・記録。
- **複数 Hub の一括管理**: 複数 Hub への並行接続、接続状態の監視、Web 画面からの登録・一覧表示・個別停止に対応。
- **利用実績の自動補完**: 停止中や再接続時に生じたデータの欠落を、Hub 側の端末別履歴から自動補完。
- **単一プロセス構成**: 外部 DB や Docker は不要。Node.js（組込 SQLite / HTTP）の単一常駐プロセスとして動作（Windows / Linux 対応）。
- **アクセス制御**: Basic 認証を備え、LAN や VPN（Tailscale 等）経由で利用可能。

---

## 全体構成

```text
各端末 (Claude Code / ChatGPT 等)
   │ トークン利用実績・制限枠
   ▼
Token Monitor Hub 1, Hub 2, ... (上流・既存環境 / 複数対応)
   │ SSE: リアルタイム観測 (Hub ごと)
   │ GET: 端末別の利用実績補完 (Hub ごと)
   ▼
Token Monitor Analytics (本ツール / Node.js 単一常駐アプリ)
   ├─ Hub 購読マネージャー (複数 Hub の直接受信・自動再接続)
   ├─ 保存・推定ステートマシン (Hub 別の識別・分離)
   ├─ 履歴の正本 (ローカル SQLite 1つ)
   └─ Web 配信 (HTTP サーバー / Basic 認証 / ブラウザ向け SSE)
   ▼ (LAN / Tailscale / ループバック経由)
Web ブラウザ (ダッシュボード閲覧 / Hub 管理 / システム更新)
```

## 設計ドキュメント

- [設計・実装ガードレール](docs/design-policy.md): 目標、制約、品質要求、実装・検証の判断基準。
- [アーキテクチャ設計の進め方](docs/architecture-process.md): 採用する方法、文書の役割分担、設計手順、初期設計の完了基準。
