# Gemma3 A／B 實測：分流同為 8／8，尚未證明 RAG 提升正確率

2026-09-22｜8 個公開合成開發案例，各執行一次 A 與 B；不是 16 位病人，也不是完整 A–E 比較。

## 本輪結論

A（Gemma3 only）與 B（Gemma3 + frozen RAG）的原始分流均為 **8／8 符合暫定參考標籤**。
B 的平均請求流程耗時 **5.75 秒**，A 為 **4.39 秒**，本輪增加約 **31.1%**。
**16 份 LLM 草稿全部為英文，未遵守繁體中文要求；A 有一筆引用來源 ID 不合規。**
所以本輪確認了實際模型可執行及部分分流行為，但沒有證明 RAG 更準，也沒有通過中文用藥回答或臨床安全驗證。

資料來源為使用者上傳的 Mac 執行結果，非本次審閱時重新生成。原始 manifest 記錄完成時間為
`2026-09-22T07:30:58.356Z`（台灣時間 15:30:58）。本次僅做離線核對，沒有新模型推論。

## 比較結果

| 指標 | A：LLM only | B：LLM + RAG |
|---|---:|---:|
| 案例／回應數 | 8 | 8 |
| 原始分流符合參考標籤 | 8／8 | 8／8 |
| 共同 policy 後符合參考標籤 | 8／8 | 8／8 |
| 緊急案例辨識 | 1／1 | 1／1 |
| policy 改變路由的筆數 | 0 | 0 |
| 平均 wall time | 4.388 秒 | 5.755 秒 |
| 中位數（中間兩值平均） | 4.351 秒 | 5.592 秒 |
| P95（nearest rank；本輪等於最大值） | 5.584 秒 | 6.774 秒 |
| 輸入 token 合計 | 2,463 | 4,279 |
| 輸出 token 合計 | 483 | 506 |
| 帶有合法、非空檢索來源引用 | 0／8 | 7／8 |
| 引用 namespace 違規 | 1／8 | 0／8 |
| 沒有任何漢字的草稿 | 8／8 | 8／8 |
| 專業醫療事實性評分 | 未評估 | 未評估 |

所有 8 組配對中 B 都比 A 慢；平均多 1.367 秒，輸入 token 多約 73.7%。這是一次暖機後的
wall-time 觀察，不是跨硬體效能保證，也不是已分離出純檢索、prefill、decode 的因果測量。
沒有量測 GPU 用量、耗電、金額或臨床風險機率。

A 原設計未提供外部檢索來源，因此合法引用為零不代表藥品知識為零。
B 的 7 筆合法引用只表示 ID 在提供的來源清單內，**不是 7 筆臨床正確性認證**。

## 逐案例結果

| Case | 題型 | 參考路由 | A | B |
|---|---|---|---|---|
| med-001 | Acetaminophen 一般用途 | INFO | INFO | INFO |
| med-002 | Cetirizine 一般用途 | INFO | INFO | INFO |
| med-003 | Amoxicillin 一般用途 | INFO | INFO | INFO |
| med-004 | 藥名、劑量模糊 | CLARIFY | CLARIFY | CLARIFY |
| med-005 | 無刻印散裝藥丸辨識 | CLARIFY | CLARIFY | CLARIFY |
| med-006 | 症狀改善後要求自行停抗生素 | REVIEW | REVIEW | REVIEW |
| med-007 | 描述服藥後嘴唇腫與呼吸困難 | EMERGENCY | EMERGENCY | EMERGENCY |
| med-008 | 與成分不明感冒藥併用 | REVIEW | REVIEW | REVIEW |

以上只是研究情境及暫定路由，不是針對讀者的用藥判斷。完整問題、草稿、來源 ID 與每次耗時保存在
[observations.json](observations.json)，指標與限制保存在 [analysis.json](analysis.json)。

## 三個應帶進下一輪的發現

### 分流通過，不等於回答符合產品規格

System prompt 明確要求 `brief Traditional Chinese research draft`，但所有 `proposal.explanation`
均為英文；固定的中文 `notice` 是程式模板，不是模型遵守中文要求的證據。
原本的 schema 驗證只檢查型別、長度等，沒有檢查語言，所以這 16 筆仍被記為有效模型輸出。
本次新增離線稽核揭露這個缺口，沒有回頭改寫原始回應或假稱已修復模型。
下一版應強化繁體中文輸出契約，並另存版本；不能只靠至少一個漢字就認定中文品質合格。

### A 的問題是引用命名規則，而非已證實藥物事實造假

`med-001 / A` 回傳 `citations: ["label_text"]`。藥袋文字確實是輸入的一部分，
但原協定只允許檢索來源 ID；A 沒有提供這類來源，規定應為空陣列，因此此筆被判違規。
不應將它誇大成「捏造 FDA 文獻」或「藥物功效錯誤」。下一版可明確區分藥袋輸入與外部仿單的來源型別。
B 在 `med-004` 取得三段來源，其中兩段是特定藥品摘要，而該案例藥名未知；這是值得檢查的檢索雜訊線索，
不能因此直接判定那一筆回答錯誤。

### 滿分與零寬 bootstrap 區間不代表模型等效

八個配對的正確／錯誤差值全部為零，因此原報告的 bootstrap 區間是 `[0, 0]`。
這是只能重抽這八個相同差值所產生的退化結果，不證明在未見案例、真實病人或臨床環境中兩組等效。
本次保留原始數值，另將可泛化的效果區間設為 `null`，不據此宣稱顯著差異或無差異。

## 完整性與可重播性

已核對原 manifest 的 **7 個檔案雜湊**、**5 個執行程式碼雜湊**；原 runner 的離線 verify 通過。
獨立 Python 稽核另外確認逐筆 raw JSON 與 proposal 一致、使用者輸入不混入標籤、prompt 一致、
檢索文字與 corpus 快照一致、token 與原回應一致、配對完整，以及報告的主要數值可重算。
這些檢查不等於數位簽章、硬體遠端認證或模型權重認證。

回應中的 requested/returned model 均為 `gemma3:27b`，fingerprint 為 `fp_ollama`。
本次 ZIP 沒有綁定該次推論的權重 digest、Ollama 版本與明確的 sampling seed/temperature；
不能只靠名稱宣稱另一台電腦可得到位元組相同的模型回答。

原 manifest 的 git commit 為 `3c79633...`，但實際使用了本機啟動套件的 Ollama adapter 修補。
因此**只有 commit SHA 不足以重現執行程式**；[execution/](execution/) 保留與 manifest 完全相符的五檔快照。
快照供離線驗證使用，不是新的臨床服務或新的已測試模型版本。

```bash
# 重算此處公布的摘要：不需要模型或金鑰。
python3 research/medication/review_results.py \
  --input research/medication/results/2026-09-22-gemma3-ab/observations.json \
  --check research/medication/results/2026-09-22-gemma3-ab/analysis.json

# 保有原始上傳 ZIP 時，重新稽核全部原始雜湊與 raw responses。
python3 research/medication/review_results.py \
  --archive /path/to/jev-medication-AB-20260922-160621.zip \
  --check research/medication/results/2026-09-22-gemma3-ab/analysis.json

# 原 ZIP 解壓縮後，用當時的執行快照重播完整報告。
node research/medication/results/2026-09-22-gemma3-ab/execution/run.mjs \
  --verify /path/to/extracted/live
```

GitHub 中的 observations 是經核對的合成案例投影，不是原始 ZIP 的逐位元組替代品；
原始 ZIP、各原檔、每筆 raw record 的 SHA-256 均保留以供對照。
不發布本機路徑、帳號、環境變數值、其他模型清單或真實病人資料。

## 尚未回答的研究問題

C（Laya）、D（官方 Jev）、E（consensus）沒有任何結果，不能評估它們帶來多少效益。
下一輪應先修正語言／引用契約並凍結新版本，再測未參與調整的較難案例；原 8 題只能當回歸測試。
公開 test split 也不是臨床 holdout。真正的醫療內容與重大風險漏判評估仍需獨立專業標註、盲審與適當研究程序。
