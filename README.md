# Token Monitor Analytics

Token Monitor Analytics は、[Token Monitor](https://github.com/Javis603/token-monitor) の複数 Hub（Cloudflare Workers 等）に接続し、定額制 AI サブスクリプション（Claude や ChatGPT 等）の利用枠を可視化するセルフホスト型ダッシュボードです。実測した「API 換算額」と「消費率」の増分からドル建ての利用許容量を逆算・推定し、継続的に記録します。

外部データベースや Docker は不要で、Node.js の単一常駐プロセスとしてローカル環境（Windows / Linux）で動作します。Basic 認証によるアクセス制御を備え、同一 LAN や VPN（Tailscale 等）経由でのアクセスに対応しています。

---

## 前提条件

本ツールは端末から直接トークン利用量を収集しません。利用には以下の環境が必要です。

- **稼働中の Token Monitor Hub**: 各端末の利用状況を集約する上流 Hub（接続 URL と共有シークレットが必要。複数 Hub の登録に対応）。
- **Node.js 24 LTS**: 実行環境（[mise](https://mise.jdx.dev/) 利用時は自動適用）。

※ 動作確認・開発用に、単体動作する模擬 Hub（ローカルモック）を同梱しています。

---

## 主な機能

- **利用許容量（ドル換算）の逆算推定**: 実測した増分（$\Delta\text{Cost} / \Delta\%$）をもとに、利用枠あたりの許容量を推定します。
- **複数 Hub の一括管理**: 複数の Hub を登録して並行接続し、接続状態の監視やデータの集約表示を行えます（Web 画面からの登録・一覧確認・停止に対応）。
- **停止中の利用実績を自動補完**: 停止中や再接続時に生じたデータの欠落を、Hub 側の端末別履歴から安全に補完します。
- **シンプルな単一プロセス構成**: 外部 DB 不要。Node.js の標準機能（SQLite / HTTP / 型除去 TypeScript）を中心に単一プロセスで完結します。
- **アクセス制御**: Basic 認証を備え、LAN や Tailscale 等の VPN 経由で手軽に利用できます。

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