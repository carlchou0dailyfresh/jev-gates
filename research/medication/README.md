# Medication five-arm study / 用藥資訊安全分流研究

**Status: engineering pilot implemented; no live comparative model result yet.**

本模組回應「LLM only / LLM+RAG / LLM+Laya / LLM+Jev / 三者 consensus」研究需求。
它是 jev-gates 的**研究程式**，不是已可上線的 LINE 藥物機器人，也不是停藥建議系統。
既有 `eval-v1.1`、工作台與配送研究均不修改；本研究使用獨立協定 `medication-routing-v0.1`。

## 本輪交付與結果

見 [本輪工程驗證結果](results/2026-09-22-engineering.json) 與 [研究報告](../../docs/medication-study.md)。
已建立 24 個公開合成案例、五組執行器、固定來源的詞彙檢索、官方 TypeSafe provider 接口、
Laya 本機 worker、失敗處理、原始／安全規則後評分、家族群集 bootstrap 與可驗證輸出。
**尚未執行真實 LLM/Laya/Jev 五組比較；不能報告準確率改善、臨床漏判率或模型排名。**
先前討論中的「不同模型漏掉幾例」是示意，不是本專案的測量資料。

## 五組配置凍結

| Arm | LLM | 檢索 | Decision model |
|---|---|---|---|
| A | 同一個明確指定的模型 | 無 | 無 |
| B | 同 A | 同一份凍結 corpus 的 lexical top-3 | 無 |
| C | 同 A | 無 | Laya multilingual |
| D | 同 A | 無 | 官方 TypeSafe Jev |
| E | 同 A | 無 | Laya 與官方 Jev 獨立平行分類，再由程式融合 |

Laya/Jev 只看到相同的輸入副本與分類問題，不看 LLM 的草稿，也不看對方的結果。
所有組別使用同一 LLM system prompt、1000 completion-token 上限、30 秒請求 timeout、
相同合成案例與固定亂數種子；各 case 的組別順序打亂。沒有自動重試、挑最好結果或遺失案例。
每次 LLM 都實際呼叫，未使用跨組快取。E 會增加呼叫數；不假設更快、更便宜或更準。
D/E **不允許把 LocalJev、Ollama 或其他 LLM 相容服務冒稱為官方 Jev**。

### 這個比較能回答與不能回答的問題

A→B 比較固定小型 RAG 對此任務的影響；A→C/D 比較加入個別分流模型；C/D→E 比較雙閘增量。
E 與 B 不具有相同檢索條件，不能把差異單獨歸因於 consensus。
第一輪只評估 **OCR 後文字的回應路由**，不是藥名辨識、藥丸成分檢驗、自由回答事實性或治療效果。
圖片/OCR、完整 TFDA 藥品目錄、交互作用資料庫、多輪 LINE 介面均不在本輪完成範圍。

## 路由、安全與不確定性

`INFO / CLARIFY / REVIEW / EMERGENCY / UNKNOWN` 分別代表一般資訊、補資料、專業覆核、
緊急求助與無法可靠判定。程式不產生 `STOP_DRUG` 或變更劑量的動作。
任何模型選出 EMERGENCY 不可被其他模型投票壓掉；REVIEW 有否決權；其他不一致保留 UNKNOWN。
正常回答門檻 `minProbability=0.8, minMargin=0.2` 只是待驗證的工程值，**不是臨床校準**。
不相乘機率、不假設錯誤獨立、不把輸出型別正確當醫療正確。
Laya 0.3.5 的每個機率有四位小數四捨五入，五類總和最多允許約 0.00025 的偏差；保留原值，不重新正規化。

每組都另外套用共同 policy：藥品身分未確認不可輸出 INFO；模型自述的調藥提案轉 REVIEW；
provider 錯誤不算正常答案。`raw_route` 與 `final_route` 各自評分，不能把 policy 效果當模型增益。
`change_medication` 只是模型自述欄位，不能保證抓出草稿中所有危險建議。來源 ID 存在也不代表內容支持主張。
因此本模組只顯示固定研究告示，**不把未經審核的 LLM 草稿送給病人**。

## 快速執行（完全離線工程測試）

```bash
npm ci
npm run medication:test
npm run medication:fixture -- --out .jev-medication-runs/fixture-001
npm run medication:verify -- --verify .jev-medication-runs/fixture-001
```

也可不安裝任何新增 JS 套件，直接使用 Node 22+：

```bash
node --test tests/medication.test.mjs
node research/medication/run.mjs --mode fixture --out .jev-medication-runs/fixture-002
```

fixture adapters 對每個案例固定回傳 INFO，**不讀 expected 標籤**。
24 cases × 5 arms × 1 repeat = 120 個路由記錄；216 次虛擬 provider 呼叫，不是 216 次模型推論。
這些數字驗證 orchestration、錯誤處理和報告重算；不建立任何模型效能排名。
輸出路徑必須不存在，程式不覆寫研究紀錄。真實執行必須同時指定 `--mode live --allow-live`。

## 真實推論（需自行具備的授權與本機 checkpoint）

```bash
# 在受控環境設定金鑰；不要貼入 issue、程式或聊天，也不要 commit .env。
export LLM_MODEL='<固定的可使用模型 ID>'
export OPENAI_API_KEY='<由秘密管理系統注入>'
export JEV_MODEL='<帳號可使用的固定官方 Jev 模型 ID>'
export TYPESAFE_API_KEY='<由秘密管理系統注入>'
export LAYA_CHECKPOINT='/absolute/path/to/local/multilingual-checkpoint'

npm run build
node research/medication/run.mjs --mode live --allow-live \
  --arms A,B,C,D,E --split test --repeats 1 --max-calls 500 \
  --out .jev-medication-runs/live-pilot-001
```

`LLM_BASE_URL` 預設為官方 OpenAI `/v1`，支援明確設定的 HTTPS 或 loopback OpenAI-compatible 端點。
LLM adapter 已按官方 Chat Completions 接口編寫；具體模型仍須支援 JSON object response_format。
SDK 文字請求/回應與回傳模型 ID 都被記錄；不把使用者填的名稱當已確認的實際模型。
不設定預設 Jev 版本，以免默默比較帳號無權使用或已變動的模型。

Laya worker 使用**已核對原始碼的 0.3.5 SDK 介面**。需安裝相符版本，並預先準備完整本機
multilingual/mmBERT checkpoint、tokenizer 與 encoder。此環境未實際安裝、載入權重或測量其推論。
worker 禁止自動下載；紀錄權重目錄內容雜湊、SDK、encoder、實際 device、含雜湊的啟動耗時。
若 SDK 會截短輸入或選項，worker 拒絕該次請求，不悄悄遺失症狀或否定詞。
請求 latency 不包含 worker 啟動；startup metadata 另存。不要與官方 GPU benchmark 混比。

缺金鑰／checkpoint 時，程式先寫出 `status=blocked`、零 live 樣本的報告並 exit 2。
不自動改成 mock，不透過 email 或 repo 搜尋秘密。錯誤回應 retained in denominator；部分失敗 exit 3。
預設每輪最多 500 次呼叫，`--max-calls` 設定的是呼叫上限而非金額保證。
未知價格、缺 token usage 均保留 `null`，不填零。此輪沒有成本節省結論。

## 原始證據與離線驗證

每個新輸出目錄會包含：

- `records.jsonl`：每次請求、回應、實際模型、模式、latency、usage、路由、錯誤與檢索來源。
- `reference-cases.json`、`corpus.json`：本次實際採用的案例與來源快照。
- `report.json`、`summary.md`：原始／共同 policy 後的計算結果；fixture 與 live 以不同欄位隔離。
- `human-review.csv`：打亂順序、隱藏 arm 名稱的輸入／來源／草稿，專業評分欄位留白。
- `review-key.json`：對回原組別的 key，**不要交給盲審者**。
- `manifest.json`：協定、prompt、question、程式及輸出 SHA-256。

`--verify` 會驗證完整檔案清單、內容雜湊、程式版本、來源、重複記錄、報告重算及摘要重算。
這是完整性檢查，不是簽章／來源真實性或醫療正確性證明。修改程式後請回到該 run 的原版本重播。
程式中途終止會留下 journal，但不產生假的 completed receipt；重新執行請用新目錄。
只使用內附公開合成案例；沒有真實病人資料匯入／發布管線。完整 runs 預設不納入 git。

## 研究指標與後續正式驗證

計算路由正確率、emergency recall/漏判數、非緊急案例被升級比例、UNKNOWN rate、
INFO coverage/precision、provider error rate、p50/p95 wall latency、可取得的 token usage。
基礎單位是 case-arm-repeat，case 數另外列出；重複執行不會被說成新病例。
配對增量以 case/repeat 對齊，再按 family cluster bootstrap 2000 次。
目前區間是探索性，沒有多重比較校正，不用來宣稱統計顯著。

正式研究需另行凍結臨床協定、取得合適審查與去識別程序，由至少兩位獨立專業人員標註／仲裁，
按照病例來源或 family 分割 train/dev/test，先在 dev 校準門檻，再盲測從未使用的 test。
公開 synthetic test split **不是** clinical heldout。不得用測試集反覆調門檻後再報同一準確率。
還需獨立審查草稿的事實性、重大危險建議、漏掉的必要補問，以及兩模型的共同失誤。

## 已核對的第一手來源

以下只支援一般背景或接口，不代表這套系統通過臨床驗證：

1. [TypeSafe 官方模型定位](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
2. [Laya 原始碼與 SDK](https://github.com/NandhaKishorM/laya)，`laya/agent.py` blob `15e2eb5666f4d3a06592baa1f1b4d1c4abcb340f`
3. [OpenAI Chat Completions 官方文件](https://developers.openai.com/api/reference/resources/chat)
4. [FDA acetaminophen](https://www.fda.gov/drugs/information-drug-class/acetaminophen)
5. [CDC antibiotic use](https://www.cdc.gov/antibiotic-use/about/index.html)
6. [NHS anaphylaxis](https://www.nhs.uk/conditions/anaphylaxis/)
7. [NHS cetirizine](https://www.nhs.uk/medicines/cetirizine/about-cetirizine/)
8. [TFDA 外觀資料集說明](https://data.gov.tw/dataset/9120)

來源閱讀日：2026-09-22。`corpus` 是短篇人工摘要快照，不是完整原文、完整 TFDA 資料庫或最新即時臨床知識庫。
