# 検証記録 — 0.3.0

この文書は、現在の単一 Analytics 構成をこの checkout で実行した結果を記録します。Windows、Ubuntu の実ホスト、systemd の再起動、Tailscale の別端末、実 Hub の受入結果は、実行した証跡が追加されるまで成功とは扱いません。

## 実行環境

`.mise.toml` の Node.js 24.20.0、TypeScript 5.8.3を使用します。Node.js 22.16.0以上でも組込み`node:sqlite`の使用条件を満たしますが、配布・受入の固定runtimeは24.20.0です。Analyticsの本番依存はNode組込みHTTP/SQLiteだけで、TypeScriptと`@types/node`は開発時の型検査用です。

## この checkout で実行した検査

次の検査はLinux開発環境で実行しました。

```text
npm --prefix analytics test                         103 passed, 0 failed
npm --prefix analytics run typecheck                passed
node --experimental-strip-types --test tools/test/*.test.mjs
                                                     43 passed, 3 skipped, 0 failed
node --experimental-strip-types tools/integration.mjs
                                                     passed
node --experimental-strip-types tools/integration-manage.mjs
                                                     passed
node --experimental-strip-types tools/integration-update.mjs
                                                     passed
```

Analytics tests cover native `DatabaseSync`/`StatementSync` calls, empty `get()` results, synchronous transaction rollback, Hub SSE parsing and reconnect, management, history, HTTP/SSE, backup, update recovery, and listener shutdown. Publication tests cover the one-app infrastructure contract and user service fixture. The integration scripts cover Hub SSE to Analytics to SQLite/browser SSE, Hub management/history, update/restart, backup integrity, and release identity.

The history performance test remains opt-in because it creates a large database and reports host-dependent timings:

```text
TMA_RUN_HISTORY_PERFORMANCE=1 node --experimental-strip-types --test tools/test/history-performance.test.mjs
```

The history writer reuses prepared statements inside its single synchronous transaction. A performance claim requires the opt-in artifact from the same host; the tests above do not certify a specific transaction time.

## 実行していない範囲

- Windowsの実機、PowerShell、ACL、Ctrl+C、ファイルlock
- Ubuntu実ホストのprovision/configure/publish/status、systemd、OS再起動、SSH転送、Tailscale別端末
- amd64/arm64配布物の今回の変更後の作成・展開検査
- 実Hub、実アカウントの料金・帰属、24時間連続稼働、電源断・ディスク故障
- GitHub Actionsのrunner実行

これらの未実行項目をCI定義や過去の記録だけで成功扱いにしません。Ubuntuの手順は[PUBLICATION](PUBLICATION.md)、通常運用は[OPERATIONS](OPERATIONS.md)、旧環境の切替だけは[MIGRATION](MIGRATION.md)を参照してください。
