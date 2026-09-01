# 端末更新時刻を利用実績観測時刻に使う

Token Monitor Hub は利用実績専用の `usageUpdatedAt` を提供しないが、対応する node-hub 契約の `devices[].updatedAt` は利用実績部分の更新時だけ進み、利用枠更新では保持される。Analytics は外部製品の変更を要求せず、この端末単位時刻を利用実績観測時刻として使い、API 最上位時刻や受信時刻による代用は行わない。
