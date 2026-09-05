# 開発・検証ツール

- `check-runtime.mjs`: Node.jsの最低版、組込みSQLite、TypeScriptコアの直接importを確認。
- `integration.mjs`: 一時ディレクトリーへGo模擬Hub/Collectorをビルドして2 Hubの実HTTP結合を検査。Analytics停止中のoutbox、復旧後の再送、重複防止、再接続、SQLiteバックアップを検証する。GoとNode.jsが必要でnpm installは不要。固定本番設定や実Hubを使用せず、終了時に子プロセスと一時データを片付ける。

```powershell
node --experimental-strip-types .\tools\integration.mjs
```

Windows/Ubuntu両方のCIへ含めていますが、CI実行済みではありません。今回の実行範囲は[検証結果](../docs/VERIFICATION.md)を参照してください。
