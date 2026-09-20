# React / Node.js基盤

現在の構成を [アーキテクチャ](architecture.md) に補足します。UC-1の仕様とUCP-1は合意済みですが、受信・保存は未実装です。

## 1. 構成と責務

React・TypeScript・Vite、TanStack Router/Query、Mantine・CSS ModulesのSPAと、Node.js・Fastify・tRPC・SQLiteのサーバー基盤を使用します。

| 配置 | 現在の責務 |
| --- | --- |
| frontend/src/app/, routes/ | Provider・Router・起動用画面 |
| frontend/src/features/ | tRPCクライアントとQueryキャッシュ |
| backend/app.ts | SQLite接続、空tRPCルーター、health、静的UI配信の組み立て |
| backend/db/ | ファイルDB接続とPRAGMA設定、未対応スキーマの拒否 |
| tests/e2e/fixtures.ts | 1テストごとの本番Nodeプロセス・ポート・一時DBの分離 |

製品の対話制御、業務処理、公開契約、認証、SSEは未実装です。利用時に対象系列の仕様へ沿って追加します。

## 2. 起動と永続化

DBの初期化に成功してからlistenを開始し、終了時にDB接続を閉じます。DBの接続はアプリケーションインスタンスが所有します。Node標準の `node:sqlite` を使用し、業務テーブルは作成しません。

開発時はVite（5173番）からNode（3000番）へAPIを転送します。本番形式ではNodeがビルド済みUIも配信します。現在はループバック専用で、共有環境への配備は未設計です。

## 3. 検証基盤

並列E2Eの設定とfixtureを継承し、サンプル専用の操作・SQL・シナリオは除去しています。fixtureはテストごとに本番Nodeプロセス・OS自動割当ポート・一時SQLiteファイルを割り当てます。ブラウザーContextはPlaywright標準のテスト単位分離を使います。

製品のE2Eは未作成です。UC-1の完成系承認後に、UCP-1の境界に従って外部HubからDB保存結果までの検証を追加し、`verify` とCIへ組み込みます。設定の基盤テストはテンプレートから継承しています。
