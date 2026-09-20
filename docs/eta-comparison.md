# 到站與行車預估比較

這個頁面把不同提供者的預估放在同一情境下觀察。**兩個預估不同，不代表其中一個比較準。** 要量測準確度，仍需同一趟實際行程耗時或同一站牌實際到站時間；JEV 邏輯閘不會產生額外的 ETA。

## 六個公開示例

| ID | 情境 | 比較量 |
| --- | --- | --- |
| `car-station-101` | 台北車站 → 台北 101 | 汽車全程預估秒數 |
| `car-station-palace` | 台北車站 → 國立故宮博物院 | 汽車全程預估秒數 |
| `car-cityhall-arena` | 台北市政府 → 台北小巨蛋 | 汽車全程預估秒數 |
| `bus-station-299-outbound` | 臺北車站(忠孝)，299 去程 | 同站下一班等待秒數 |
| `bus-station-299-inbound` | 臺北車站(忠孝)，299 返程 | 另一方向站牌的下一班等待秒數 |
| `bus-cityhall-blue10-outbound` | 捷運市政府站，藍10 去程 | 同站下一班等待秒數 |

汽車案例固定相同起終點座標，但不同提供者可能選擇不同道路、入口或道路貼合點。回應因此明確標示 `sameEndpointsRequested: true`、`samePathVerified: false`。

公車案例沒有把歷史站牌 ID 寫成永久常數。每次查詢先透過[官方公車 adapter](bus-arrivals.md)解析符合指定站名、路線名、去返程的唯一站牌，再以正式站牌和主路線 ID 要求 ETA。無結果、多個結果或結果截斷均不猜測。

## 提供者與時間語意

- **OSRM**：一次取得汽車道路服務原建議的時間與距離，不含即時車流。這是 OSRM 提供者估時，不能稱為 JEV 預測或自行訓練的 ETA。[OSRM Route 文件](https://project-osrm.org/docs/v5.24.0/api/#route-service)
- **Google Maps · Routes API**：僅使用 `DRIVE`、`TRAFFIC_AWARE_OPTIMAL`、現在出發預設值。請求只取 duration、distance 和頂層 fallbackInfo；不取路線形狀，不把 Google 路線畫到 OSM 地圖。若服務使用 fallbackInfo，拒絕當作要求的模式結果。[Compute Routes 文件](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes)
- **臺北市官方公車**：使用來源給的等待秒數，沿用官方站牌／方向、新鮮度與數值閘門；資料須為 0–120 秒內的來源快照且方向相符。不是實際車輛到站的確定時刻。[官方資料集](https://data.taipei/dataset/detail?id=f11a5af0-7b37-48ef-98cc-f6f102ed43c6)

汽車的 `requestedAt`、`fetchedAt` 是本機送出／收到提供者回應的時間。這兩個服務未提供本次結果所用個別交通感測器的觀測時間，所以 `sourceUpdatedAt` 保留 null。不能把剛收到回應說成所有路況都剛更新。

公車的 `sourceUpdatedAt` 是 `EssentialInfo.UpdateTime` 檔案快照時間，不是每台車的 GPS 測量時間。`fetchedAt` 另列，快取不會洗新來源時間。API 不自行扣除等待秒數或把舊預估延伸成即時倒數。

## 一次操作與 Google 設定

`GET /api/compare/config` 不做網路請求，只回案例、限額和 Google key 是否已設定。key 只從服務端環境讀取，從不傳給瀏覽器；`configured: true` 不代表已驗證權限、配額或成功存取。

`POST /api/compare/observe` 的輸入只有 `{scenarioId}`。汽車的一次明確操作最多發出一個 OSRM 請求與**一個可能計費的 Google Routes 請求**，兩者接近同時開始，記錄 `pairing.startSkewMs`。沒有背景輪詢、自動批次或失敗重試。無 Google key 時只取得 OSRM，Google 欄位標示 unavailable，並提供官方 [Google Maps URL](https://developers.google.com/maps/documentation/urls/get-started) 供手動觀察。

Google API 預估與消費者 Google Maps App／網頁的讀值是不同來源，介面不可將兩者混稱。Google API 是否成功、消費者介面是否可見、使用者人工讀值是否完整，都是分開的觀察。

## 公車的手動對照

公車情境不呼叫 Google Routes。Google Maps 連結只開啟已解析站牌的座標位置，**不保證會自動顯示正確公車路線或方向**。人工記錄必須確認：

1. 同一站牌、路線與方向。
2. 顯示的是下一班等車時間。
3. 記下實際觀察時間。

若 Google Maps 只顯示完整 Transit 行程、步行加轉乘時間、時刻表或無法辨認方向，請保留缺值。完整大眾運輸旅程不等於單一站牌等待時間，不能直接相減或當成公車 ETA 誤差。`manualReference.requiredConfirmations` 回傳這些必要確認項目。

## 資料保留與安全邊界

Google Routes 回應只供當次顯示／暫存計算：本服務沒有 cache、資料庫、檔案記錄或匯出；也不回傳原始 Google 物件。前端不得把這些值寫入 localStorage、下載報告或歷史資料庫。資料卡須清楚標示 **Google Maps**，並與其他來源區分。[Google Routes 政策與標示要求](https://developers.google.com/maps/documentation/routes/policies)

API 僅接受 loopback／同來源，JSON 輸入最多 4 KiB。上游網址固定，使用者不能傳入任意 URL、地址或 key。上游回應上限 1 MiB、10 秒期限，取消與失敗均停止，不將錯誤原文、憑證或回應 body 洩漏到前端。Google 配對觀察沒有伺服器快取，公車仍使用其已界定的官方資料快取。

`metrics` 分別記錄 `osrmRequests`、`googleRequests`、`busRequests`、`modelRequests`；模型請求為 0。HTTP 失敗也算實際嘗試，這些計數不是費用帳單或節費證明。

## 測試範圍

注入測試涵蓋：無 key、單次 Google 請求、相同起終點、最小 field mask、fallback 拒絕、失敗不重試、敏感錯誤遮蔽、不快取 Google、官方站牌唯一匹配、去返程和資料新鮮度、等待時間語意、取消、上限與同來源邊界。

Google 分支的 injected fixture 測試不代表真實 Google API 已連通；只有當下的有效提供者回應才可聲稱該次存取成功。無實際行程或到站 ground truth 時，這個頁面只觀察預估差距，不評定準確率。

## 比較介面與實測

開啟 Studio 的 `/delivery/compare`，汽車路線與公車頁都提供入口。選擇情境並手動查詢；未設定 Google key 時，可在兩分鐘內核對 Google Maps 畫面，記錄分鐘或區間。公車另外顯示實際解析的站牌、路線與行駛終點，只有班表的值不能加入即時比較。

完成配對後凍結兩個來源的擷取／更新時間與預估。表格保留最多 24 輪分頁內紀錄；重新整理即清除。選取歷史紀錄會取消未完成的新查詢，避免混入另一個情境。API 回應時間與人工畫面觀察時間皆標記為 `observed_only`，不冒稱個別交通感測器剛更新。

真的出發或在站牌候車時，才能按「開始實測」。超過兩分鐘的預估必須重新查詢。抵達後需自行確認相同行駛路徑，或同站同方向下一班公車，才記錄實際到達。這是人工自報，未經 GPS 或獨立覆核。介面依汽車／候車及 Google 來源分組顯示 MAE 與 nearest-rank P90；Google 的區間保留上下界，不取中點。沒有合格實際抵達紀錄時，樣本數為 0、誤差為空，不產生準確率或勝負。

2026-09-20 本機驗證：307 項測試通過，其中比較核心 20 項、比較 API 12 項。桌面 Computer Use 完成三個汽車情境的少量 Google Maps 人工畫面對照、官方 299 公車方向核對、查詢中切換歷史紀錄及凍結快照檢查；未記錄任何實際行程或到站，因此實際準確度樣本為 0。Google Routes API 未設定 key，僅其注入測試通過，不代表真實 API 存取成功。尚未完成本頁的手機尺寸實測。

乾淨 tarball 安裝在獨立目錄通過 `/delivery/compare`、6 個前端資源與 6 情境 config 檢查，不需前端開發依賴。研究 demo、套件 verify/replay、Studio 五案例 demo/verify/replay 全部成功，測試時外部請求為 0；注入資料不代表實地預測準確率。
