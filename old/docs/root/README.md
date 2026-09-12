# Token Monitor Analytics

Token Monitor Analytics は、[Token Monitor](https://github.com/Javis603/token-monitor) Hub と連携し、定額制 AI サービス（Claude、ChatGPT 等）の利用状況を可視化するセルフホスト型ダッシュボードです。API 換算額と消費率の実測増分から利用枠ごとの許容量（米ドル換算の参考値）を推定し、ローカル環境に蓄積します。

---

## 現在の実装と起動方法

段階 A の現在値受信・SQLite 保存・Basic 認証付き表示を実装しています。推定、履歴 GET、Web からの Hub 登録・停止・再開、手動更新は後続段階です。最初の対応・完了判定は Windows のみとし、Linux は後続で検証します。

Windows で Node.js 24.18.0 以上の 24 系を使います。リポジトリのルートで実行してください。

```powershell
npm ci
# .env がまだない場合だけ、Mock Hub 用の設定例をコピーする
if (!(Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
```

`.env` の `BASIC_USER` / `BASIC_PASSWORD` が画面のログイン情報です。`HUB_URL` / `HUB_SECRET` に接続先を設定してください。認証情報を URL に埋め込まないでください。`.env` と DB の既定保存先 `data/` は Git 管理から除外しています。

```powershell
mise run start
```

[現在値画面](http://127.0.0.1:17322/) を開き、`.env` の Basic 認証情報を入力します。設定の `HOST` は既定で `127.0.0.1`、`PORT` は `17322`、DB は `data/analytics.sqlite` です。`HUB_ID` は情報源の識別子で、同じ ID に別 URL を割り当てると起動を拒否します。別 Hub には別 ID を指定してください。現在の起動設定は一つの Hub を対象にします。

Mock Hub を使う場合は、`.env.example` の接続先・共有シークレットに合わせ、別のターミナルで次を実行します。架空の2端末の値が5秒ごとに更新されます。

```powershell
mise run mock
```

停止は各ターミナルで `Ctrl+C` を押します。Hub 切断時は3秒間隔で再接続し、最後の保存値を時刻とともに表示します。不正データは採用せず次の正常通知を待ちます。保存失敗時は書き込みを止め、最後の保存値と原因を表示します。DB の権限・保存先・空き容量など原因を解消して Analytics を再起動してください。復旧時に DB を削除・初期化する必要はありません。

```powershell
mise run check
```

検証は架空の Mock Hub と一時 DB を使い、実 Hub の設定や保存済み DB を変更しません。CI も Windows で同じ検証コマンドを実行します。開発時の頻用操作は `mise run start` / `mise run mock` / `mise run test` / `mise run check` で実行できます。依存関係のインストールは初回またはlockfile変更時に `npm ci` を実行します。

## 初期版の対象機能（未実装を含む）

- **利用許容量の推定**: SSE で受信する現在値の観測に基づき、同一期間の実測増分比から利用枠ごとの許容量を算出・記録
- **取得情報の可視化**: プロバイダーやプランを問わず、取得した利用枠・消費率・API 換算額を状態や更新日時とともに表示（推定不可の場合も取得情報は表示）
- **複数 Hub の集中管理**: 複数 Hub への並行接続・状態監視、Web 画面での登録・一覧表示、Hub 個別の収集停止・再開
- **利用実績の自動補完**: Hub の保持履歴（`GET /api/devices`）を定期取得し、過去の日次・月次実績を収集（端末の現地日付を維持）
- **軽量な単一プロセス構成**: 外部 DB や Docker は不要。Node.js と組込 SQLite による単一常駐プロセス
- **アクセス制御**: Basic 認証による Web 画面および API の保護（LAN / VPN 環境対応）

---

## 実行環境・前提条件

本システムは端末から直接データを収集せず、上流の Token Monitor Hub 経由で集約します。

- **Token Monitor Hub**: 接続 URL と共有シークレット（複数 Hub 対応。動作確認用の模擬 Hub を同梱）
- **実行環境**: Node.js 24 LTS（Windows 先行、Linux は後続検証。[mise](https://mise.jdx.dev/) 対応）

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

## 関連ドキュメント

- [設計・実装ガードレール](docs/design-policy.md): システム目標、制約、品質要求、実装・検証の判断基準（正本）
- [機能要件](docs/requirements.md): 機能範囲、業務ルール、利用者から見た動作と受け入れ条件
- [文書方針](docs/document-policy.md): 記録の粒度、実装着手、計画具体化の基準
- [開発計画](PLAN.md): 実装・検証の段階的計画と直近の作業
- [アーキテクチャ設計書](docs/architecture.md): Hub API 仕様、データ識別・保存原則、受信処理の設計仕様
- [機能詳細設計](docs/functional-design.md): API 項目対応、取得タイミング等の具体仕様
- [用語定義](CONTEXT.md): ドメイン用語の定義
- [アーキテクチャ設計の参考手法](docs/architecture-process.md): 必要に応じて参照する設計手法
