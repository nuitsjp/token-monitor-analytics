# 一次資料と実装根拠（2026-09-05確認）

- **S1 — Node.js組込みSQLite**: https://nodejs.org/api/sqlite.html 。DatabaseSync、プリペアド文、backup。実行バージョンのドキュメントと安定度表記を確認する。今回の実行環境は22.16.0でexperimental警告あり。
- **S2 — Node.js TypeScript実行**: https://nodejs.org/docs/latest-v24.x/api/typescript.html 。Node 24.12で型除去はStable。erasable syntax、明示的な`.ts`拡張子、`import type`を使用する。型検査は行われないためtscを別に用意。
- **S3 — WHATWG Server-sent events**: https://html.spec.whatwg.org/multipage/server-sent-events.html 。EventSource、event/data/retry、再接続。
- **S4 — SQLite WALとバックアップ**: https://www.sqlite.org/wal.html と https://sqlite.org/backup.html 。稼働中のDB本体だけをコピーしない。NodeのSQLiteバックアップAPIを使う。
- **S5 — Node.jsの保守版と配布**: https://nodejs.org/en/about/previous-releases と https://nodejs.org/en/download 。2026-09-05時点で24系はLTS。運用には保守中の最新パッチを使用。
- **S6 — Token Monitor v0.54.0**: https://github.com/Javis603/token-monitor/blob/v0.54.0/worker/src/index.js と https://github.com/Javis603/token-monitor/blob/v0.54.0/docs/API.md 。上流SSEと金額フィールドは前版で確認した固定バージョンの契約を引継ぐ。利用者の実Hub版への接続は今回未検証。
- **S7 — systemd**: https://www.freedesktop.org/software/systemd/man/systemd.service.html と https://www.freedesktop.org/software/systemd/man/systemd.exec.html 。Restart、EnvironmentFile、StateDirectory。
- **S8 — OpenSSH**: https://man.openbsd.org/ssh と https://man.openbsd.org/sshd_config 。`-L`、loopback bind、AllowTcpForwarding。
- **S9 — Go保守版**: https://go.dev/doc/devel/release 。運用バイナリーは保守中のGoでビルド。作成環境のGo 1.23.2は検査用であり、運用推奨版を意味しない。
- **S10 — 型検査依存の固定**: https://registry.npmjs.org/typescript/5.8.3 。公式レジストリーのバージョン・integrityからpackage-lock.jsonを作成し、npmのoffline lock-onlyで検査。既存コードに合わせTypeScript 5.8.3を継承。

この資料は実機での受入試験を代替しません。Node 24/Windows/systemdでの実行確認と、作成環境のNode 22/Linuxでの試験は区別して記録します。
