# React / Node.js基盤

現在の構成を [アーキテクチャ](architecture.md) に補足します。UC-1の仕様とUCP-1は合意済みですが、受信・保存を単一Node.jsプロセスへ組み込みます。

## 1. 構成と責務

React・TypeScript・Vite、TanStack Router/Query、Mantine・CSS ModulesのSPAと、Node.js・Fastify・tRPC・SQLiteのサーバー基盤を使用します。

| 配置 | 現在の責務 |
| --- | --- |
| frontend/src/app/, routes/ | Provider・Router・起動用画面。`app/theme.ts` が色・余白・文字・データ系列色の正本で、CSS Modules は `var(--tm-*)`・`var(--mantine-*)` だけを参照する |
| frontend/src/features/ | tRPCクライアントとQueryキャッシュ |
| backend/app.ts | SQLite接続、Hub登録・受信・閲覧用SSE配信の起動終了、tRPCルーター、health、静的UI配信の組み立て |
| backend/http/ | 保存済み利用状況の読み取りAPIと、アプリ単位で共有するSSE配信 |
| backend/db/ | ファイルDB接続、スキーマ移行、Hub登録と最新状態の保存 |
| backend/hub/ | Hub通知の境界検証、SSE受信と逐次保存 |
| tests/e2e/fixtures.ts | 1テストごとの本番Nodeプロセス・ポート・一時DBの分離 |

UC-1は画面やtRPCを経由しません。Hub認証はサーバー側の接続設定を使います。利用者向けWeb認証は未実装です。

## 2. 起動と永続化

DBの初期化とHub登録に成功してからlistenを開始し、listen後にHubのSSE受信を開始します。終了時はHTTP終了待ちより先に閲覧用SSE配信を閉じ、Hub受信の中止・完了待ち後にDB接続を閉じます。DBの接続はアプリケーションインスタンスが所有します。Node標準の `node:sqlite` を使用し、テーブル定義は [設計書](architecture.md#tables) を正本とします。

開発時はVite（5173番）からNode（3000番）へAPIを転送します。本番形式ではNodeがビルド済みUIも配信します。現在はループバック専用で、共有環境への配備は未設計です。

## 3. 検証基盤

並列E2Eの設定とfixtureを継承し、サンプル専用の操作・SQL・シナリオは除去しています。fixtureはテストごとに本番Nodeプロセス・OS自動割当ポート・一時SQLiteファイルを割り当てます。ブラウザーContextはPlaywright標準のテスト単位分離を使います。

UC-1のE2Eは、制御可能な2つのSSE Hubから本番Nodeプロセスを通り、別の読み取り専用接続でSQLiteの保存結果までを確認します。テストごとにHub、プロセス、ポート、設定ファイル、DBを分離し、`verify` とCIへ組み込んでいます。設定の基盤テストはテンプレートから継承しています。
