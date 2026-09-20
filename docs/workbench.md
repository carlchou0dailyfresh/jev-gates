# 語意邏輯閘工作台操作手冊

## 安裝與啟動

使用 Node.js 22.12+ 或 24+（Vite 的建置要求高於核心本身的 Node 22）。在獨立 checkout 根目錄執行 `npm ci`、`npm run workbench`；開啟 <http://127.0.0.1:4317>。首次會安裝 UI 的固定版本依賴並建置。後續可用 `npm run workbench:start`。使用 `PORT=4319 npm run workbench:start` 指定其他埠。

CLI：`node dist/cli.js --help`。打包前先執行 `npm run workbench:build`，包內含靜態介面；安裝 npm 套件後可用 `jev-gates workbench`，不需要另装 UI 依賴。

## 一次完整操作

1. 在情境入口選「長上下文與 RAG」、正常路徑與 fixture。先閱讀合成資料標示、問題、輸入與限制。
2. 執行，從核心事件時間軸看節點完成；點 UNKNOWN 節點查看原因、原文與需要補充的資料。分布是腳本值或模型原始數值，沒有端到端正確率意義。
3. 更換為缺失／衝突／限制條件，或編輯節點的 policy。填寫變更原因並建立子 run；原紀錄保持不變。修改原文或題目後，舊 fixture 不會被當作新模型判斷，改用 live 或明確棄答。
4. 匯出執行包，使用 `verify-report` 驗證所有內部關聯，再用 `replay` 離線重算。時間軸前進／後退只移動觀看位置，不撤銷任何工具動作。
5. 在執行庫重新匯入，選兩次執行比較節點、結論、棄答、呼叫與延遲。樣本不足的品質欄會顯示 not_evaluated。

## 四個情境

- 研究：六個合成主張與獨立的 public-source 文獻模式。public-source 保存版本與引用，沒有模型品質標籤。
- 事故：觀察→競爭假說→手動選擇本機沙箱動作→回執→目的端健康檢查。「逾時但已修复」保留 pending，查詢後才變 verified；重複查詢不重送操作。
- 探測站：修改能源／時間／儀器，以程式重新求解，保留旧計畫與原因；實際提案由獨立驗證器核對。
- 迷你世界：固定種子、變更規則家族、改名／干擾／資訊遮蔽／矛盾。答案由獨立執行器產生，送給模型的輸入不含評測標籤。

更多預期結果見 [情境導覽](scenarios.md)。

## 本機模型與金鑰

預設 LocalJev 位址 `http://127.0.0.1:8080`、bridge 模型 `localjev-0.2`。可由服務端環境設定 `LOCALJEV_BASE_URL`、`LOCALJEV_MODEL`、`LOCALJEV_UPSTREAM_MODEL`、`LOCALJEV_API_KEY`。工作台只允許 loopback LocalJev，沒有自動雲端 fallback。ready 只證明服務回應，`npm run research:smoke` 才是一次真正推論。

TypeSafe 僅在明確選擇後才呼叫，服務端讀取 `TYPESAFE_API_KEY` 和可選 `TYPESAFE_MODEL`；未設定即不可用。金鑰不送至瀏覽器，不進 artifact 或 Git。沒有執行雲端大批付費評測；若要執行需先決定費用上限與可計量方式。

## 預算與故障

每次執行限制總時間、節點、呼叫與每次 gate 期限。token／cost 無法量測時標示 unknown，不能宣稱精準限制花費。啟用 token／cost cap 而用量不明時停止新增呼叫。取消與期限會保存局部結果，UNKNOWN 不會變成 FALSE。HTTP 錯誤導致 UNKNOWN 不算模型答對。

Controller 的 gate、tool、verify 各有期限與 AbortSignal。取消不代表目的端動作已撤銷；不明操作保留 pending，恢復只查同一 operationId。工作台沙箱只有 JSON 模擬服務，不會操作外部服務。

## 保存與匯入邊界

執行紀錄預設存在啟動位置所屬的 `.jev-runs/`，檔案权限 0600；可設定 `JEV_RUN_DIR` 指向自己管理的目錄。分享前自行審閱輸入與原文是否含個人資料。已完成 run 使用不可覆寫檔案；修改會建立新 run。

服務預設 loopback，檢查 Host / Origin，不提供任意命令、任意 URL 抓取或檔案路徑寫入。匯入只接受最大 8 MiB、深度不超過 64 的 JSON，檢查 schema、雜湊、引用位置、請求／回應與邏輯重算。不執行輸入中的 JS、HTML 或文字指令。

每個資料目錄只允許一個 writer。若程序崩潰留下 `writer.lock`，先確認檔內 PID 已停止，再移除該鎖；不要把另一個正在跑的服務解鎖。sandbox 的操作意圖仍保留，恢復只查詢目的端，不重送。

離線 replay 不接受 provider 或 tool handle、不呼叫網路，也不重新執行 actions。雜湊證明內部內容一致，不能证明來源真實、作者身分或科學結論。

## 驗證與限制

`npm test` 驗證核心、schema、預算、replay、controller、服務與沙箱；`npm --prefix ui run build` 驗證 UI 型別與正式建置。工程報告及瀏覽器證據見 [交付驗證](workbench-verification.md)。模型評測適用範圍與未執行項另見 [評測協議](eval-protocol.md)。

本工作台是實驗研究工具。fixture 可以驗證流程與邏輯，不能證明真實模型準確率；多層閘、案例跑通與可視化也不是通用智能證據。


## 編輯情境並橋接語言模型

[JEV Studio 操作說明](studio.md) 提供另一個本機互動介面（3088）：可直接編輯任務、證據、語意問題與三值支線，並由 Ollama 產生有引用的文字。研究工作台（4317）的執行包與 Studio 的紀錄格式不同，請使用各自的匯入與重播工具。
