# Dependencies and licensing

Go Collectorは標準ライブラリーのみ。Go本体のライセンスは公式配布に従います。

AnalyticsはNode.js組込みモジュールとSQLiteを利用します。Node/SQLiteの配布条件は各公式配布に従います。Nodeのランタイム本体はZIPに含めません。

npmの開発依存はTypeScript 5.8.3（型検査専用、Apache-2.0）だけです。パッケージ本体はZIPに含めず、package-lock.jsonで版とintegrityを固定しています。通常の起動・テスト・Ubuntu運用にnpm installは不要です。

Token Monitorの上流コード本体は含みません。前版のAPI契約に合わせた独自Collectorを引き継いでいます。

生成リポジトリー自体の公開ライセンスは未選択です。OSS公開前にリポジトリー所有者が選択してください。
