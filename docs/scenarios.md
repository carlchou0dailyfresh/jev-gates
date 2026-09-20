# 四個可操作情境

工作台選擇案例、變體後執行；CLI 也可使用 `npm run research:demo -- research --variant normal`（完整 CLI 參見 README）。每次執行保存不可變輸入、電路、證據、provider 回應及輸出；修改後建立子 run。fixture 是生成器提供的腳本答案，分布中的 1 不是模型正確率。來源、provider、工具三種 provenance 分開記錄。

## A：長上下文與 RAG

六個問題各自檢查限定正確題數、成本、普遍取代、延遲、資訊新鮮度及隱私。`normal` 的合成測量使正確題數主張成立、成本與普遍取代主張被反駁，新鮮度與隱私仍未知。這些數值不是任何真實模型的結果。

| 操作 | 預期結果 |
| --- | --- |
| normal 執行，查看六個主張 | 同時看到 TRUE、FALSE、UNKNOWN；限定 conclusion TRUE |
| missing | 缺來源時不呼叫語意 provider，缺失條件留在 gateDecisions |
| conflict 或 counterexample | 支持與反駁原文並列，明確 policy 要求補資料，conclusion UNKNOWN |
| fault | 注入 provider 真正拋錯，記錄 provider_error，不能算正確棄答 |
| stale | 程式比較明確觀察／有效期限後棄答 |
| out-of-scope 或 long-context | 改變任務／上下文，scope-match FALSE |
| tight-budget | 精確成本限制否決限定替代方案 |
| privacy-evidence、latency-failed、replication | 增加對應合成資料，保留原 run 作比較 |
| public-source | 兩篇獨立論文短摘要、可定位版本；沒有獨立標籤，fixture 全棄答，assessment not_evaluated |

程式實際執行 evidenceRequired、freshness、scopeMatch、handleConflict。引用存在只代表可定位，不代表支持主張。原文中的指令不增加工具權限。`normalizeScenarioInput()` 重新算 derived flags，不能藉匯入 `scopeMatches: true` 偽造適用性。不同論文沒有同一測試設定，介面不提供跨論文優勝排名。

## B：虛構服务事故

日誌與指標區分連線池耗盡、設定變更、上游失敗三個競爭假說。`repair-candidate` 僅為修復候選；不代表服務已恢復。

| 操作 | 預期結果 |
| --- | --- |
| normal → 沙箱修復 | 回執 applied 後，query 與 health 都成功才 verified |
| missing、stale | 缺少或過期觀察時模型 fixture 棄答 |
| conflict、mixed-signals | 同時保留矛盾日誌，修復候選 UNKNOWN |
| fault | provider 拋錯，與工具狀態分開 |
| config-change、upstream-failure、healthy | 資料庫修復假說 FALSE |
| timeout-after-applied → reload → query pending | 原動作已套用但呼叫拋錯；查詢同一 operationId 後恢復，executionCount 保持 1 |
| verification-failed | 動作 applied，健康檢查 false；不顯示已解決 |
| execute-failed | 意圖已保存但執行失敗，不產生成功回執 |

`SandboxService` 只改一個本機 JSON 檔。目的端操作與回執一起原子替換；操作前另存 pending 意圖。相同 operationId 不重送，`.lock` 防止跨程序同時寫入。若程序崩潰遺留 lock，先查詢已記錄狀態，再由操作者移除失效 lock；不自動猜測另一 writer 已死亡。這是本機模擬契約，不能宣稱外部系統 exactly-once。

## C：探測站規劃

`StationProblem` 列出能源、分鐘、儀器、初始狀態、目標及帶先後条件的動作。窮舉求解器為至多 16 個一次性動作找可行序列，另一個順序驗證器逐項核對輸出。這個限制下的 solver 完備性不延伸到任意規劃問題。

| 操作 | 預期結果 |
| --- | --- |
| normal | 提供可驗證樣本→分析→傳送序列 |
| instrument-off | 關閉光譜儀後改用相機 |
| low-energy、conflict、short-window、no-radio、extra-goal | 精確限制無解，拒絕虛構資源 |
| missing | 缺初始條件，不能完成任務 |
| fault | 語意 provider 故障，確定性可行性仍單獨顯示 |
| ample-budget、exact-budget | 改變資源，保留可核對帳本 |
| invalid-proposal | 提前傳送違反 prerequisite，即使另有可行方案也拒絕此提案 |

改輸入的 `problem` 或 `proposal` 後，服務端必須调用 `normalizeScenarioInput('planning', input)`。`verified` 與 `solver` 都重新計算，不能信任匯入欄位。來源舊 run 不改寫。

## D：未見規則的迷你世界

`normal` 是鏈式轉換；`missing` 將初始事實設為未知，列舉可能世界後答案不一致即 UNKNOWN；`conflict` 表示明確矛盾規則而棄答；`fault` 注入 provider 故障。

其他變體為 renamed、distractors、inhibitor、alternative、reversible、blocked、one-shot、new-family。獨立 BFS 依前提、任一前提、禁制、增加／消耗事實產生答案。任何未觀察事實都不直接當 false。初版每家族的拓撲有限、重複度高，改名不等於全新的推理任務。

`eval/manifest.json` 包含 192 個記錄，其中 120 個 heldout；train=chain、dev=conjunction、calibration=consumption、test=inhibitor/alternative/reversible。家族相交會立即拒絕。`evaluateWorldHeldout` 接受 0、1、3 個 train 示例，禁止把測試答案或解法送給 provider。候選子電路只在 dev 驗證，通過後建立帶測試 digest 的版本；修改同版本遭拒絕。

## 匯出與離線驗證

對任一執行包操作匯出 → `verify-report` → `replay`。replay 不接受 provider/tool handle，不呼叫修復。時間軸往回只移動已錄事件；live 動作不會因倒帶撤銷。效能樣本 `createPerformanceFixture(20|100|256)` 仍跑正式 DAG 驗證，瀏覽器報告應另外保存設備及實測時間。
