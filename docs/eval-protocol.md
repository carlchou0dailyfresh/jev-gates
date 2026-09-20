# 有界研究評測協議 eval-v1.1

此協議在 heldout 執行前凍結；程式常數與 `eval/protocol.json` 的 digest 必須一致。報告 workflow、工程驗收、模型品質分開。工程 fixture 全過不代表 JEV、LLM 或通用智能的準確率。

eval-v1.1 於實際 UTC **2026-09-19T17:38:10.000Z** 重新凍結，只適用於此後的正式 heldout；`supersedes=eval-v1`、`reason=timestamp_metadata_correction`、`performanceTuning=false`。eval-v1 原先寫入的 `2026-09-20T00:00:00.000Z` 晚於當時 smoke，疑似將台北日期誤當 UTC 日期，不能證明執行前已凍結。已保存的 live 報告原文、數據與 digest 全部保留，不補寫、不回溯改判；這些是探索性 smoke，不是預註冊 heldout 結果。

此次更版只更正版本、凍結時間與更正說明，品質門檻、預算、案例、標籤、家族切分和校準政策都不變，也沒有根據 smoke 表現調整條件。既有錯誤與棄答仍保留；不能用新版本時間替舊實驗補作事前承諾。

## 執行

`npm run build && node eval/run.mjs` 產生四情境 49 變體工程報告、192 個世界記錄的 manifest 及 48 變體 × 4 架構 × 4 消融設定的離線比較報告。其中 public-source 變體沒有標籤，工程只驗證流程可運行。報告 `fixture-comparisons.json` 為精簡結果；呼叫 library 的 `evaluateComparisons()` 可取得所有每臂 RunArtifact。

真實推論用同一 provider factory 與實際模型，`totalMaxCalls` 限制整次比較呼叫數（含規劃選擇）；每臂另有 maxCalls 與期限。預設 runner 沒有網路 provider。TypeSafe 未設金鑰時 not_run，不自行切雲端。成本未知即 unknown。LocalJev 的 bridge、actual/upstream model 與原始回應都應留在 artifact；這不表示其數值和 hosted JEV 同義。

## 凍結目標與分層

- 試驗目標：coverage ≥ 0.70、已回答且有已知標籤的錯誤率 ≤ 0.10。
- 每 provider／actual model／語言／情境／架構／消融分層至少 30 個樣本；小型 smoke 不做 passed 主張。
- 初版 minProbability=0.60、minMargin=0.15 是明示的未實證校準政策。不得用 heldout 回饋靜默修改。
- 沒有独立覆核者；即使達到數值門檻仍需獨立標籤覆核及適當樣本設計。

家族相關樣本不符合完全獨立 Bernoulli 假設，Wilson 95% 區間只作描述。120 個 heldout 是工程起點，不代表 120 個獨立任務家族。能力、泛化、自治程度分开記錄；沒有一般智能 pass/fail 判定。

## 來源、標籤與隔離

研究／事故／規劃 fixture 的 expected 是手工設計的工程標籤，來源版本 `scenario-hand-authored-v1`，不是獨立專家標註。迷你世界答案由獨立轉換執行器生成，規劃可行性由獨立資源驗證器核對。公開文獻模式沒有獨立標籤，assessment 必須 not_evaluated。

世界按生成器版本和規則家族隔離，不只换 seed。manifest 帶每個世界 content digest，labels 不进入 provider state。少示例只取 train；候选電路只接受 dev 資料；校準只接受 calibration。`calibrateChoicePolicy` 每路由獨立搜索機率／margin 網格，樣本不足回 not_evaluated，無達標組合回 failed；輸出的候選政策必須新版本凍結後才可進 heldout。

## 架構與消融

四比較組為單次語意整體判斷、原子判斷加程式、固定第二層覆核、受限計畫。使用相同輸入、工具、provider、模型與整次預算。第二層不會把相關節點機率相乘。fixture 每組都是預置答案，不能用來比較架構品質。

初版受限規劃器讓 provider 在兩個已審查、語義等價的 DAG 排序中選擇；節點、邏輯、工具、輸出、證據與預算均被限制。`BoundedPlanner.propose()` 是可替換介面，驗證器禁止移除／改寫必要節點。它實現有界計畫選擇，尚未實現自由生成新問題或開放式任務拆解。此限制在報告中明示。

消融分別移除第二層、train 記憶示例、反例證據。标签不隨消融修改；fixture 答案不根據刪除證據重新推理，消融的品質比較只可使用真實 provider。未能構成實質變化的情境（例如原本沒有記憶）是相同輸入控制，不能當能力增益。

## 指標與故障

逐層記錄 n、已知標籤、正確已知結果、FP、FN、coverage、正常棄答、provider／planner 故障、約束違反、P50/P95、token/cost 帳本。API 故障即使輸出碰巧等於 UNKNOWN 也算 failure，不計正確棄答。尚未執行真實工具評測時 toolSuccessRate=null；本機沙箱冪等驗收不冒充外部工具成功率。

規劃選擇的正常 unknown 回應記為 planner abstention，保留 request、questions、已驗證 response、可取得的原始 transport、實際與上游模型，停止後續模型呼叫但不計 API failure。網路失敗、期限到期、無效回應、違反既定 DAG 契約的提案各有獨立 reason code；任意例外訊息不寫入報告。棄答列的 `decisionSource=planner-abstention`，相連的電路 artifact 記錄未獲分配後續呼叫預算的狀態，不能把未執行電路的局部確定性結果当成規劃成功。既有歷史報告保留原樣；新記錄格式不會追補當時未保存的原始回應。

Brier／NLL 只有在真實 binary-event-v1 機率契約、二元標籤及合法數值都存在時才計算。NLL 在 1e-15 截斷避免 Infinity。Noul、Choice confidence、Score、LocalJev 合成分布不會自動轉為此契約。目前預設比較資料沒有此契約，欄位為 null。

報告保留失敗與未執行項，不以降低條件、刪除難例或測試期間修改政策製造通過。逐項 artifact 的 digest 證明內容一致性，不證明來源真實或科學結論。
