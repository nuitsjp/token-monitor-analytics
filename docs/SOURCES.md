# 一次資料と実装根拠

この一覧は、現在の単一 Analytics 構成で参照する資料を示します。上流HubやNodeの更新で挙動が変わる可能性がある項目は、固定した検証結果と実行時のruntimeを分けて記録します。

- **S1 — Node.js組込みSQLite**: [Node.js SQLite API](https://nodejs.org/api/sqlite.html)。`DatabaseSync`、`StatementSync`、prepared statement、backupを参照する。`package.json`と更新runnerの互換性下限はNode.js 22.16.0だが、このcheckoutで実行を確認したruntimeはNode.js 24.20.0のみである。配布・受入の固定runtimeもNode.js 24.20.0とする。
- **S2 — Node.js TypeScript実行**: [Node.js TypeScript](https://nodejs.org/docs/latest-v24.x/api/typescript.html)。型除去で直接実行し、型検査はTypeScriptを別に実行する。
- **S3 — Server-sent events**: [WHATWG Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)。`event`、`data`、heartbeat、再接続の境界を確認する。
- **S4 — SQLite WALとバックアップ**: [SQLite WAL](https://www.sqlite.org/wal.html) と [SQLite backup](https://sqlite.org/backup.html)。稼働中DBを単純コピーせず、Nodeのbackup APIを使う。
- **S5 — Node.jsの保守版と配布**: [Node.js releases](https://nodejs.org/en/about/previous-releases) と [downloads](https://nodejs.org/en/download)。運用では固定したruntimeの最新パッチを使う。
- **S6 — Token Monitor Hub**: `external/token-monitor/docs/API.md`、`external/token-monitor/worker/README.md`、上流の固定gitlink。SSEと端末履歴の入力契約を参照する。Analyticsの実行依存には含めない。
- **S7 — systemd**: [systemd.service](https://www.freedesktop.org/software/systemd/man/systemd.service.html) と [systemd.exec](https://www.freedesktop.org/software/systemd/man/systemd.exec.html)。user service、EnvironmentFile、再起動条件を参照する。
- **S8 — OpenSSH**: [ssh](https://man.openbsd.org/ssh) と [sshd_config](https://man.openbsd.org/sshd_config)。loopback listenerの転送境界を参照する。
- **S9 — TypeScriptとNode型定義**: `analytics/package-lock.json`でTypeScriptと`@types/node`のexact version/integrityを固定する。`@types/node`は開発時の型検査だけで、production runtimeへ読み込まない。

この資料は実機受入試験の代替ではありません。Windows、Ubuntu/systemd、Tailscale、実Hubの結果は、実行した環境と証跡を[VERIFICATION](VERIFICATION.md)へ別に記録します。

## 上流Hub参照用サブモジュール

`external/token-monitor`は仕様調査用です。

```sh
git submodule update --init external/token-monitor
```

submoduleの取得や更新はAnalyticsの起動、発行、通常運用に必要ありません。
