# 台北公車到站：供應者預估與資料閘門

`/delivery/bus` 讓使用者搜尋站名或站址，再選擇公車路線和行車方向。顯示的是台北市官方來源提供的預估秒數。**它不是保證到站時間，也不是 AI 產生的預估。**

此案例使用 `jev-gates` 的實際 `runCircuit` 執行精確規則及 AND 組合：確認來源新鮮度、站牌／路線／方向吻合、預估值可用，再決定是否顯示分鐘。數值比對和時間計算不需要語意模型，`modelRequests` 一律為 0。這驗證了資料閘門的實作，不證明語意模型準確率或 AGI。

## 官方資料可直接使用

[臺北市資料大平臺的公車預估資料集](https://data.taipei/dataset/detail?id=f11a5af0-7b37-48ef-98cc-f6f102ed43c6) 指向公運處開放資料；[台北市官方 API 文件 v5.4](https://www-ws.gov.taipei/001/Upload/458/relfile/22545/6554360/a8aabcb9-8dfb-4812-9a37-83fb9a03c471.pdf) 列出三個公開 gzip 來源：

| 資料 | 官方公開檔案 | 用途 |
| --- | --- | --- |
| 站牌 | [GetStop.gz](https://tcgbusfs.blob.core.windows.net/blobbus/GetStop.gz) | 官方站牌 ID、所屬主路線、位置、站址與去返程。 |
| 路線 | [GetRoute.gz](https://tcgbusfs.blob.core.windows.net/blobbus/GetRoute.gz) | 主路線 ID、名稱、去程起點與終點。 |
| 預估 | [GetEstimateTime.gz](https://tcgbusfs.blob.core.windows.net/blobbus/GetEstimateTime.gz) | 站牌／主路線對應的預估剩餘秒數與來源狀態。 |

這三個來源本次均在沒有 API key 的情況下成功讀取。`configured: true` 表示使用已知公開介接方式，不承諾未來可用性。[另一套交通部 TDX 到站服務](https://data.gov.tw/dataset/161159) 要求註冊與 API key，本案例沒有呼叫它，也沒有自動申請或讀取憑證。

## 時間與方向如何處理

來源 JSON 外層 `EssentialInfo.UpdateTime` 是整份快照更新時間，格式為台灣時間 `YYYY/MM/DD HH:mm:ss`。程式明確按 UTC+8 解析並驗證日曆，與主機時區無關。`fetchedAt` 是本機抓取完成時間，HTTP `Last-Modified` 另列，三者不混用。

**檔案快照新，不等於個別車輛剛剛回報 GPS。** 本來源的每筆 EstimateTime 沒有個別車輛測量時間，因此只能驗證快照年齡，不能證明估計本身正確。公運處亦[說明到站預估可能受車機異常、行駛和路況等因素影響](https://pto.gov.taipei/News_Content.aspx?n=6B4D38874E971F4B&s=7A2CB904A3EC7F41)。

本介面採用以下研究門檻：

- 快照年齡須介於 **0 到 120 秒**；超過、缺失或任何未來時間都不顯示分鐘。
- 站牌與路線快照須在 48 小時內；缺時間保留 UNKNOWN，已過期則不放行。
- 使用官方獨立站牌 ID、路線 ID 和 `goBack`，不以相同站名合併兩邊站牌。
- 預估記錄的 `GoBack` 為 0／1 時，必須與選站方向吻合。來源缺漏、互相衝突或方向不符，保留待確認。
- `EstimateTime` 非負值以秒處理，零不視為缺失。分鐘只取向上整數方便顯示，**不自行扣秒或延伸成即時倒數**。

來源的負代碼依官方文件保留：`-1` 尚未發車、`-2` 交管不停靠、`-3` 末班車已過、`-4` 今日未營運。來源 `GoBack` 的 2／3 屬其他行車狀態，不能冒充選站的 0／1 去返程。本次實讀也觀察到部分站牌的方向與預估 `GoBack` 不一致，甚至特殊狀態另附正預估數值；程式不自行修正這些矛盾。

邏輯閘為：來源最近、來源非未來、靜態資料有效、站牌匹配、方向匹配、數值可用，最後由 AND 決定是否顯示。缺資料保留 UNKNOWN，來源負狀態不轉成零分鐘。只有所有必要條件 TRUE 才放行 ETA。

## 限額與 API

`createBusArrivalsService` 與 `createBusArrivalsApi` 位於 `workbench/server/bus-arrivals.mjs`。

| 端點 | 請求 | 回應 |
| --- | --- | --- |
| `GET /api/bus/config` | 無 | 無網路的設定、三個公開站點案例、更新間隔與上限。 |
| `POST /api/bus/stops` | `{query}` 或 `{lat,lng}` | 最多 24 個 `stops`，每個含 `id,name,lat,lng,routeId,routeName,direction,destination,address`；附 `total/omitted`。 |
| `POST /api/bus/arrivals` | `{stopId,routeId,direction}`，方向為字串 `"0"` 或 `"1"` | `arrivals`、`freshness`、實際電路 `gates/truth`、`summary`、`provenance`、請求計數。 |

文字匹配官方站名、站址與路線名稱。可用空白組合條件，例如「臺北車站 299」會要求兩個片段都吻合，縮小大型站區的結果；不把任意地址猜成站牌。前端若已由地圖服務解析一個公開地址，可以傳入經緯度查找 1 公里內站牌；仍需使用者選擇正確方向。範圍限制於台北市區的包圍範圍，並非精確行政邊界。查詢只在手動提交時進行。

所有來源 URL 均由服務端固定，HTTP 僅接受 loopback 與同來源、JSON 輸入最多 8 KiB。每個來源請求 10 秒期限、無重試，壓縮資料上限 3 MiB、解壓上限 16 MiB；這是因完整官方站牌表約 9 MiB，並非只下載查詢結果。全服務每秒最多啟動一次來源請求。

站牌和路線記憶體快取 24 小時，預估快取 15 秒；快取保留原始抓取與來源时间，每次查詢重新驗證年齡。來源失敗不回退到舊的數值、模型數值或 fixture。建議前端手動啟用每 30 秒更新，最多 10 次，頁面不可見時暫停；停止更新後仍應按來源時間隱藏已過期的分鐘。

## 本次真實觀察與驗證範圍

2026-09-20 台灣時間 08:35 的公開檔案探測讀到 28,799 個站牌、791 個路線記錄、29,377 個預估記錄。數量只是當次快照，不是固定服務承諾。

接著以實際 adapter 查詢 **站牌 10175、路線 11411（299）、去程 0**：官方站牌為「臺北車站(忠孝)」，方向往永春高中，站址標為捷運臺北車站 M6 出口（向東）。

- 來源快照：2026-09-20 08:40:45（台灣時間）。
- 抓取完成：08:40:47.179；計算時快照年齡 2.18 秒。
- 當次供應者預估：450 秒，顯示約 8 分鐘；這個歷史觀察不是現在的到站資訊。
- `runCircuit` 所需規則與 AND 均為 TRUE；到站查詢用了 1 次來源請求、2 次靜態快取、0 次模型請求。

測試另用注入資料驗證：日曆與時區、過期與未來時間、方向衝突、負代碼、缺漏與重複預估、來源中斷、gzip 解壓上限、取消、快取時間與同來源邊界。這些測試不能證明現實世界的到站誤差有多小。
