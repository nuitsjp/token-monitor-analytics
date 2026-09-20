# React / Node.js基盤

現在の構成を [アーキテクチャ](architecture.md) に補足します。UC-1の仕様とUCP-1は合意済みですが、受信・保存を単一Node.jsプロセスへ組み込みます。

## 1. 構成と責務

React・TypeScript・Vite、TanStack Router/Query、Mantine・CSS ModulesのSPAと、Node.js・Fastify・tRPC・SQLiteのサーバー基盤を使用します。

| 配置 | 現在の責務 |
| --- | --- |
| frontend/src/app/, routes/ | Provider・Router・起動用画面 |
| frontend/src/features/ | tRPCクライアントとQueryキャッシュ |
| backend/app.ts | SQLite接続、Hub登録・受信の起動終了、空tRPCルーター、health、静的UI配信の組み立て |
| backend/db/ | ファイルDB接続、スキーマ移行、Hub登録と最新状態の保存 |
| backend/hub/ | Hub通知の境界検証、SSE受信と逐次保存 |
| tests/e2e/fixtures.ts | 1テストごとの本番Nodeプロセス・ポート・一時DBの分離 |

UC-1は画面やtRPCを経由しません。Hub認証はサーバー側の接続設定を使います。利用者向けWeb認証は未実装です。

## 2. 起動と永続化

DBの初期化とHub登録に成功してからlistenを開始し、listen後にSSEを開始します。終了時は受信を中止・完了待ちしてからDB接続を閉じます。DBの接続はアプリケーションインスタンスが所有します。Node標準の `node:sqlite` を使用し、テーブル定義は [設計書](architecture.md#tables) を正本とします。

開発時はVite（5173番）からNode（3000番）へAPIを転送します。本番形式ではNodeがビルド済みUIも配信します。現在はループバック専用で、共有環境への配備は未設計です。

## 3. 検証基盤

並列E2Eの設定とfixtureを継承し、サンプル専用の操作・SQL・シナリオは除去しています。fixtureはテストごとに本番Nodeプロセス・OS自動割当ポート・一時SQLiteファイルを割り当てます。ブラウザーContextはPlaywright標準のテスト単位分離を使います。

製品のE2Eは未作成です。UC-1の完成系承認後に、UCP-1の境界に従って外部HubからDB保存結果までの検証を追加し、`verify` とCIへ組み込みます。設定の基盤テストはテンプレートから継承しています。
