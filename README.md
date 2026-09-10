# Token Monitor Analytics

[Token Monitor](https://github.com/Javis603/token-monitor) の Hub（Cloudflare Worker等）に接続し、AI定額サブスクリプション（ClaudeやChatGPT等）の利用枠を、実測された「API換算額」と「消費率」の増分からドル建ての許容量として逆算推定・継続記録するセルフホスト型ダッシュボードです。

外部データベースやDocker、クラウドインフラを必要とせず、Node.js 1プロセスだけで手元の環境（Windows / Linux）に常駐します。LAN内接続やVPN（Tailscale等）経由のアクセスに対応し、Basic認証で安全に保護されます。

---

## 前提条件

本ツールは端末から直接トークンを収集するものではありません。利用には以下の環境が必要です。

- **稼働中の Token Monitor Hub**:
  各端末の利用状況を集約している上流のHub（URLおよび接続用の共有シークレットが必要）。
- **Node.js 24 LTS**:
  [mise](https://mise.jdx.dev/) を使用している場合は、本リポジトリの設定により自動的に固定バージョンが適用されます。

※ 本ツールの動作確認・開発用に、Hubがなくても動作する「模擬Hub（ローカルモック）」を同梱しています。

---

## 主な機能

- **利用枠の経済的実力値を逆算**: 「5時間枠で何ドル分使えるのか」「月額費用に対して元が取れているか」を実測増分（$\Delta\text{Cost} / \Delta\%$）から推定。
- **停止中の利用実績を自動補完**: アプリ停止中や再接続時のデータ欠落を、Hubが保持する端末別履歴から安全に補完（過去の制限枠や推定値は捏造しません）。
- **単一プロセスの極小構成**: 外部DBや別プロセスを排し、Node.js組込み機能（SQLite / HTTP / 型除去TypeScript）だけで完結。
- **柔軟なアクセス保護**: Basic認証を初期実装とし、同一LAN内やTailscale等のVPN経由から安全にアクセス可能。
- **WebからのHub管理**: ブラウザーからHubの登録・停止

---

## 全体構成

```text
各端末 (Claude Code / ChatGPT等)
   │ トークン利用実績・制限枠
   ▼
Token Monitor Hub (上流・既存環境)
   │ SSE: リアルタイム観測
   │ GET: 端末別の利用実績補完
   ▼
Token Monitor Analytics (本ツール / Node.js 単一常駐アプリ)
   ├─ Hub購読マネージャー (直接受信・自動再接続)
   ├─ 保存・推定ステートマシン
   ├─ 履歴の正本 (ローカル SQLite 1つ)
   └─ Web配信 (HTTPサーバー / Basic認証 / ブラウザーSSE)
   ▼ (LAN / Tailscale / loopback 経由)
Webブラウザー (ダッシュボード / Hub管理 / システム更新)