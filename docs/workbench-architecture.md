# 工作台架構決策（ADR 001）

狀態：已實作的實驗版本；契約版本 1.0。原始任務見 [workbench-task.md](workbench-task.md)，執行證據與限制見 [workbench-verification.md](workbench-verification.md)。

## 邊界

核心使用既有 TypeScript / Node 模組與三態引擎；UI 是獨立套件，不加入核心執行期依賴。CLI 與 loopback 本機 HTTP 服務都呼叫同一套 scenario、artifact、engine。瀏覽器不計算真值，也不持有模型金鑰。每次執行是不可變 DAG；重新計畫、來源修改、policy 修改與人工覆核產生有原因的子 run。

React 19.3.0、React Flow 12.11.6、Vite 8.3.0 固定版本。React Flow 提供可縮放 DAG；手機用相同節點的排序清單。核心沒有 React 依賴。選型文件：[React](https://react.dev/learn)、[React Flow](https://reactflow.dev/learn)、[Vite](https://vite.dev/guide/)（2026-09-20 查閱）。

## 資料流

選擇情境 → 編輯有界計畫 → 服務驗證 DAG → 核心逐事件執行 → 版本化 RunArtifact → 完整性與離線重算 → 本機執行庫。工具動作另走有 operationId 的 sandbox adapter；先落盤，再執行，逾時保留 pending，恢復只查目的端。

只有本機檔案與模擬服務寫入；來源文字與匯入 JSON 是資料，不執行其中的指令。服務綁定 127.0.0.1；Host、Origin、Content-Type 及請求大小都檢查。單一程序鎖定資料目錄，同一 operationId 不重送。外部 exactly-once 不在保證範圍。

## 證據解讀

來源 synthetic / public-source / user-provided、provider fixture / LocalJev / TypeSafe、工具 sandbox / live 分開紀錄。workflow completed 只表示流程完成。assessment passed 要有獨立標籤與適用範圍；public-source 無獨立標籤時 not_evaluated。雜湊只驗證檔案內容及內部關聯，不證明作者、來源真實或科學結論。

JEV 原子問題與程式組合依據：[TypeSafe Introduction](https://docs.typesafe.ai/introduction)。分布與 confidence 的解讀依據：[Confidence](https://docs.typesafe.ai/confidence)。LocalJev 是協定相容的 bridge，生成分布不同於 hosted JEV，需各自校準：[LocalJev](https://github.com/githubnext/localjev)。

研究設計把能力、泛化、自主程度分開：[Levels of AGI v5](https://arxiv.org/abs/2311.02462v5)。未見規則家族的測試是有限範圍的組合研究：[On the Measure of Intelligence](https://arxiv.org/abs/1911.01547)。這些文獻不證明本工作台具有通用智能。
