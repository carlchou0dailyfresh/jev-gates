# 工作台交付驗證

驗證日期：2026-09-20（Asia/Taipei）。這是可操作的實驗工作台；工程檢查通過不代表模型品質通過，也沒有通用智能結論。原 19 檔 patch／zip 未取得，本次依 [任務規格](workbench-task.md) 獨立實作。

## 已執行的工程驗證

|項目|實際結果|證據與重現|
|---|---|---|
|核心與整合回歸|115/115 通過，包含原版 49 項|`npm test`；`tests/`|
|四情境離線端到端|49 個變體通過，其中公開文獻僅驗流程|[engineering.json](../eval/reports/engineering.json)，`npm run research:eval`|
|比較／消融管線|48 變體 × 4 架構 × 4 設定，共 768 列；全部為 fixture|[fixture-comparisons.json](../eval/reports/fixture-comparisons.json)，`npm run build && node eval/run.mjs`|
|世界資料與標籤|192 筆，包含 120 筆 test；家族隔離及獨立執行器標籤驗證|[manifest](../eval/manifest.json)、[world-cases](../eval/world-cases.jsonl)|
|正式 UI 建置|TypeScript 與 Vite 建置通過|`npm --prefix ui ci && npm --prefix ui run build`|
|實際 Chromium 操作|10 條流程通過，無未預期瀏覽器錯誤|[browser-verification.json](../eval/reports/browser-verification.json)，`npm --prefix ui exec -- playwright install chromium && npm --prefix ui run test:browser`|
|匯出→verify→離線 replay|輸出一致；禁止 fetch／provider／tool 的稽核中外呼 0 次|[fixture 執行包](../examples/artifacts/research-fixture.json)、artifact 及 browser tests|
|已錄製推論的離線驗證|現行 9 份 live／recorded-live artifact 全部通過並重播一致|下列 live 報告；歷史 archive 另列|
|沙箱復原|修復已發生但回應逾時→pending→查目的端→verified；重新載入及重複查詢 executionCount 仍為 1|browser 與 workbench-server tests|
|匯入及服務邊界|竄改、錯誤 Host／Origin、過深 JSON、循環 DAG、憑證回顯被拒絕|artifact、HTTP、audit、server tests|
|實際打包與乾淨安裝|核心執行期依賴為 0；安裝 tarball 只新增本套件；已安裝 CLI 的 HTML／JS／CSS／favicon 與 fixture 執行／verify／replay 均通過|`npm pack` 的 prepack 建置核心與 UI；獨立暫存目錄安裝驗證|

CI 在 Node.js 22／24 執行核心、demo、研究 fixture、UI 建置與套件檢查，Node 24 另執行 Chromium 操作。具體遠端結果以 PR checks 為準；本文件不把本機結果當作 CI 證據。

瀏覽器流程涵蓋：三態與 inspector 一致、匯出重播與前後移動、無效圖拒絕及焦點返回、policy 子分支與不可變父紀錄、沙箱 pending 復原、能源限制重規劃、迷你世界資料缺失、響應式與手機分頁 inspector、大圖載入搜尋、損壞匯入與正常匯入。

## 畫面與互動耗時

|視窗|結果|截圖|
|---|---|---|
|360px|無水平溢出，手機節點清單與分頁檢視器|[360px](screenshots/workbench-360.png)|
|768px|無水平溢出，鍵盤焦點返回來源控制項|[768px](screenshots/workbench-768.png)|
|1440px|DAG、節點清單、原文 inspector 與時間軸|[1440px](screenshots/workbench-1440.png)|

Apple M4 Max／macOS arm64／Chromium 153.0.8010.12，1440×900：20／100／256 節點載入並完成搜尋操作分別約 86／126／207 ms；UI 兩次畫面更新量測約 51.5／50.6／66.7 ms。測量包含 API 與 UI，未關閉核心驗證。這是單機一次觀察，沒有統計基準或跨設備效能承諾。自動測試開啟 reduced motion；人工螢幕閱讀器稽核 not_run。

## 真實本機推論與失敗

使用既有 LocalJev 服務，bridge 為 `localjev-0.2`。上游 `gemma3:27b` 來自服務 readiness／設定 metadata；HTTP 原始回應未自行回報上游名稱。輸入為合成情境，不是真實事故或已獨立標註的研究資料。沒有自動切换雲端。

|紀錄|實際觀察|證據限制|
|---|---|---|
|[literal smoke](../eval/reports/live-smoke.json)|一次 HTTP 503 原文判讀成功，原推論約 11.09 秒，224 input／14 output tokens|assessment not_evaluated；現行檔案是離線修正來源 metadata 的 recorded-live 子紀錄|
|[第一輪比較](../eval/reports/live-comparison-smoke.json)|同一正常世界的四組比較：1 個已知正確、3 個棄答，coverage 25%|早期 harness 只保存摘要，未保存逐臂 raw artifact；無法補造原始回應|
|[改名案例比較](../eval/reports/live-comparison-recorded.json)|四組均未完成判斷，coverage 0；保留失敗紀錄|早期錯誤只保留 generic code，原因未確定；不能推定為模型能力失敗，也不能當作答對 UNKNOWN|
|[保留 transport 的受阻案例](../eval/reports/live-comparison-final-transport.json)|**一個合成案例、四組比較：3 個假陽性，1 個 planner 未完成／棄答未分清。** coverage 75%，已知回答正確率 0/3|不是四個獨立任務。前三組保留共 4 次成功 HTTP 呼叫、3,558 個已知 tokens；planner 原始回應未保存，額外用量未知|

受阻案例三組完成回答均把 FALSE 判為 TRUE，觀察錯誤率超過預設目標；每組只有一筆，正式品質狀態仍是 `experimental`／`insufficient_samples`。不能聲稱多層電路提高正確率。P50 約 5.794 秒、P95 約 6.971 秒僅描述這次四組執行，成本 unknown。

每個比較批次有明確總呼叫上限 8；受阻案例各臂最多 3 次、單次期限 35 秒（planner 未完成後電路呼叫預算為 0）。歷史報告內的 protocol 預設 8 次／5 秒不是實際覆寫後的設定，應讀 artifact.budget.limits。保留失敗後沒有重跑相同案例來挑選成功結果。

歷史 eval-v1 的 `frozenAt` 使用錯誤 UTC 時區標記，晚於上述 smoke 的實際時間。因此這些紀錄**不能證明事前凍結的 held-out 實驗**。現行協議以新版本、更正時點重新凍結，門檻、資料與切分未依結果調整，供未來正式評測使用；歷史 live 報告保持原樣。

新版 planner 記錄已區分正常棄答、網路錯誤、期限、無效回應與違反提案契約，並用 fixture 測試 raw transport 留存；此修正不會追補舊報告不存在的回應，也沒有因此再呼叫模型。

## 歷史紀錄與離線衍生

開發中收緊了 evidenceIds 規則：只能引用實際選入該語意請求且 contentDigest 相符的来源。五份早期 artifact 的來源 metadata 不符合最終規則，原始檔保存在 [development-archive](../eval/reports/development-archive/README.md)。現行相對應紀錄使用原始輸入、policy、模型回應及 transport 在離線重算，建立帶 parentRunId／changeReason 的 `recorded-live` 子紀錄；沒有新推論。原模型結果與歷史延遲均保留，不以新離線耗時冒充推論耗時。

## 尚未建立的能力與 not_run

- TypeSafe hosted 推論及雲端付費評測：未配置金鑰，not_run。
- 120 個 held-out 世界的完整 live 零／一／三示例評测及 live 消融：工具可執行，模型批次 not_run；fixture 結果只驗工程。
- 校準資料每家族 24 筆，低於每分層 30 筆的門檻；沒有實證校準或獨立人工標籤覆核。Brier／NLL 欄位保留 null。
- 受限 planner v1 只在兩個已審查、語義等價的 DAG 排序中選擇；未實作自由產生新問題或開放式任務拆解。探測站的確定性求解器與獨立計畫驗證器則已可操作。
- 子電路只在 dev 驗證後版本化收錄；尚無模型在未見家族持續學習的實證結論。
- 真實外部工具、跨服務 exactly-once、人工螢幕閱讀器驗證及跨瀏覽器／跨設備效能：not_run。現有動作證據全部是本機沙箱。
- token／cost cap 在用量未知時停止後續呼叫；最後一次已送出的呼叫可能在回報用量後才知道超額，不能宣稱費用硬上限。

可開啟 <http://127.0.0.1:4317>；乾淨 checkout 使用 `npm ci && npm run workbench`。其他操作見 [工作台手冊](workbench.md)。
