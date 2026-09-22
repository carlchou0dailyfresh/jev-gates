# 用藥資訊五組研究：2026-09-22 工程驗證

## 結論先行

**已建立五組可執行研究流程與工程驗證；尚未完成五組真實模型推論比較。**
本輪沒有證據可說 E 比 A/B/C/D 更準、漏判更少、更快、更便宜或可用於臨床。
此前對話中不同模型漏掉幾例的數字只是示意，不是研究結果，本報告不採用。

本模組放在 `research/medication/`，承接既有 `feat/research-validation-round`，
不改動原 `eval-v1.1`、工作台、配送或 ETA 的數據／結論。

## 本輪實際驗證

本地 Node 22.16.0 執行新增測試：46 通過、0 失敗，1 個需要完整 dist 的核心整合測試未在本地執行。
該整合測試已加入既有 `npm test`，遠端 CI 完整 build 後可執行；不能把尚未讀取的 CI 結果當已通過。
Python 3.13.5 完成 worker 語法編譯；不代表 Laya 套件、模型載入或 GPU 推論已測試。

五組共用 24 個公開合成案例（24 families；dev 8、test 16），fixture 跑出 120 筆 case-arm 記錄，
原始記錄、摘要及指標離線重算驗證通過。Fixture 對每個輸入固定回傳 INFO，不讀標準答案；
它測試線路是否接通，不測 AI 智能。沒有把這批機械測試轉成模型排名。

真實模式 preflight 缺少 `LLM_MODEL`、`OPENAI_API_KEY`、`JEV_MODEL`、`TYPESAFE_API_KEY`、
本機 `LAYA_CHECKPOINT`，因此輸出 blocked receipt，真實模型成功樣本數 0。未取用任何真實病人資料。
詳見 [機器可讀結果](../research/medication/results/2026-09-22-engineering.json)。

## 已驗證的邊界

不同組別資料隔離、只有 B 檢索、不洩漏 expected labels、缺資料拒判、模型分歧保留 UNKNOWN、
任一模型 emergency 不被其他投票壓掉、provider 失敗不丟棄樣本、不假造 token/cost、
禁止 live 混入 fixture、原始與共同 policy 後指標分離、重複結果拒收、檔案改動可偵測、
輸出路徑不覆寫、live 顯式許可與請求數預算。

兩個模型同時判錯仍可能一起通過。本測試刻意保留這種情況，避免把 consensus 寫成「必定更安全」。
Laya 機率四捨五入由 adapter 明確容許，但不重新正規化，也不把 confidence 當病人風險。

## 研究完成度

| 項目 | 本輪狀態 |
|---|---|
| A–E 管線、mode 隔離、配對計算 | 已實作並執行離線工程測試 |
| LLM / TypeSafe 接口 | 合約測試；真實 API 尚未呼叫 |
| Laya multilingual worker | 已按核對過的 SDK 實作；僅語法驗證 |
| 合成案例與來源摘要 | 已納入，臨床標註尚未審核 |
| 藥物說明的事實性／危險建議評分 | 已產生盲審表；評分空白 |
| 五組真實模型效果 | 尚無結果，不排名 |
| OCR、完整 TFDA、LINE bot 上線 | 非本輪範圍／未完成 |

完整方法、指標定義、真實執行指令與來源請見 [研究 README](../research/medication/README.md)。
