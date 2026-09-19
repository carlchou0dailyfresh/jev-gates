# 配送案例的地圖來源與限制

查閱日期：2026-09-20。配送案例的地點與任務設定是示範輸入；取得真實道路矩陣，不代表這些站點是真實客戶、已確認訂單或實際配送成果。

## 三種資料來源

| 來源 | 矩陣 | 路線線條 | 路況與保存方式 |
| --- | --- | --- | --- |
| 固定示範（fixture） | 核心以直線距離與固定參數產生的合成矩陣 | 依指定站序連接的直線 | 無道路與即時路況；可供離線研究 |
| OSRM | 公開服務回傳的汽車道路時間與距離 | 同一提供者依指定站序計算的道路幾何 | 明確標示 `no_live_traffic`；本機記憶體快取 60 秒、最多 32 筆 |
| Google Maps Routes | 明確選用且伺服器有金鑰時，取得考慮路況的矩陣 | 如另外要求，會再呼叫 Compute Routes | 不進本 adapter 的快取；本案例不提供 Google 原始矩陣／幾何匯出或比較重播 |

`health().osrm = true` 只代表 OSRM 介接可選；`googleConfigured = true` 只代表伺服器有設定金鑰。它們不代表已連線成功、Google 已啟用計費或完成一次道路查詢。

## 矩陣、道路與計畫分工

矩陣的索引順序固定為 `[depot, ...stops]`，`durations` 使用秒、`distances` 使用公尺，並保留去程與回程可能不同的數值。OSRM 的距離是最快路徑所對應的距離，不保證是幾何上的最短距離。無法連通的 OSRM 項目保留為 `null`，交由核心辨識不可達；不能用零或直線估算替代。[OSRM Table API](https://project-osrm.org/docs/v5.24.0/api/#table-service)

站點排序、容量、時間窗與服務時間由本機確定性規則處理。道路幾何只按照求解後的站序繪製；OSRM 使用 Route 服務，沒有另用 Trip 服務偷偷更換順序。固定示範線條只是直線，不能作為導航道路。[OSRM Route API](https://project-osrm.org/docs/v5.24.0/api/#route-service)

道路矩陣與幾何是分開的請求；幾何不取代求解時使用的矩陣。即使站序相同，兩次取得資料的時間與路網狀態也可能不同。介面應保存並顯示各自來源與抓取時間，不把線條視為已實際行駛的軌跡。

## OSRM 公開服務

本介接固定使用 `https://router.project-osrm.org`，profile 為 `driving`。公開示範服務的政策要求合理用量、來源標示及可辨識的應用程式資訊；服務可用性沒有保證。本專案限制同一 adapter 的實際請求開始時間每秒最多一次，發送具應用名稱的 User-Agent，不自動重試。[OSRM 服務使用說明](https://routing.openstreetmap.de/about.html)、[OSRM API 使用政策索引](https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy)

應讓同一伺服器共用一個 `createDeliveryMaps()` 實例，才能共用限流與快取。此本機限制不是全網配額，也不代表可供高流量正式商業服務使用。

快取涵蓋矩陣與幾何，採最近使用順序淘汰。命中時保留原 `fetchedAt`，`cached` 為 true，此次 `requests` 與 `elements` 為 0。到期或明確強制重新抓取後若失敗，顯示錯誤，不把舊資料當成新結果。`dataVersion` 只在 OSRM 實際回傳資料版本時提供；抓取時間不能替代路網資料版本。

OSRM 回傳時間在本案例一律標記 `traffic: false`。它不是當下壅塞、道路封閉或交通事故的即時資訊，也不是到站時間保證。

## OpenStreetMap 底圖與來源標示

OSM 地圖上保留清楚可見的「© OpenStreetMap contributors」並連結版權頁；不可被側欄、浮層或手機版裁切遮住。路線來源另外標示 OSRM。[OpenStreetMap 版權與授權說明](https://www.openstreetmap.org/copyright)

若使用 OSMF 公開圖磚，僅載入使用者目前檢視範圍所需的圖磚，不提供批量下載、背景掃圖、離線打包或預先抓取功能。使用 HTTPS 圖磚位址，保留瀏覽器快取與有效 Referer；不能以全站 `no-referrer` 阻擋 Referer，也不能預設強制略過圖磚快取。本 adapter 的 60 秒道路快取與圖磚快取是兩件事。[OSMF 圖磚使用政策](https://operations.osmfoundation.org/policies/tiles/)

## Google 路況模式

必須在伺服器環境設定 `GOOGLE_MAPS_API_KEY`，並由使用者明確選擇 Google。金鑰只放在伺服器請求的 `X-Goog-Api-Key` 標頭，不放在網址、瀏覽器、報告或錯誤訊息；未設定或請求失敗時不切換來源。

矩陣使用 `DRIVE` 與 `TRAFFIC_AWARE_OPTIMAL`。本案例最多 7 個配送站加 1 個起點，因此每次最多 8 × 8 = 64 個矩陣元素，低於此模式的 100 個元素限制。明確要求索引、status、condition、duration、distanceMeters 與 fallbackInfo，拒絕缺項、重複項、無效狀態與替代計算模式；零秒與零公尺是合法數值。[Google Compute Route Matrix 參考](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix)

Google 請求不送案例的 `departureMinutes`，由服務預設按請求時刻估算。回傳 provenance 的 `departureTime` 是本機發出請求的 ISO 時間，用來說明時間基準，不是 Google 確認的實際離站時間。介面應標示「路況為抓取當下估算；班次時鐘為情境設定」。每一對站點使用同一次矩陣的時間基準，不會隨車輛行進時間重新預測整個班次。

若另行要求 Google 道路幾何，會向 `computeRoutes` 再發出一次請求；`optimizeWaypointOrder` 設為 false，以 `GEO_JSON_LINESTRING` 回傳依指定順序的線條，並再次標記抓取時間。這次呼叫不包含在先前矩陣呼叫內，可能有額外費用；其時間估算也不是原矩陣的重播。[Google Compute Routes 參考](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes)

本機 `metrics.requests` 記錄此次嘗試發出的 HTTP 請求數；矩陣 `elements` 為來源數乘目的數，幾何為 1。錯誤也附安全計數，避免把失敗請求誤算為零。這些是執行用量，不是 Google 的帳單金額或收費保證；實際適用 SKU 與計費由 Google 決定。[Google Routes 使用量與計費](https://developers.google.com/maps/documentation/routes/usage-and-billing)

## Google 顯示、保存與比較邊界

Google Routes 結果若疊在地圖上，需使用 Google 地圖。因此本版選擇 Google 時移除 OSM 地圖，僅顯示行程列表，並清楚標示 Google Maps 來源；不可把 Google 路線疊在 OSM 底圖。Google 原始矩陣與幾何不寫入本案例的匯出／比較報告，也不保存為之後可重播的計畫。需要四種策略公平比較時，使用同一份 OSRM 或 fixture 快照。[Google Routes 政策與標示規則](https://developers.google.com/maps/documentation/routes/policies)

在正式公開提供 Google 功能前，還須完成其要求的使用條款、隱私政策與來源標示。這份文件說明本次實作選擇，不替代提供者最新契約。

## 可重現的工程檢查

`node --test tests/delivery-maps.test.mjs` 以注入的 fetch 回應驗證矩陣／幾何格式、快取、限流、逾時、錯誤計數、來源與金鑰邊界；不呼叫真實地圖服務或模型。

單一 HTTP 請求連同讀取完整回應的期限為 10 秒，回應上限 1 MiB；限流等待時間也計入操作耗時。服務只接受固定端點及數值座標，不接受使用者提供的任意 URL。這些檢查證明工程約束，不證明提供者道路資料、實際交通或配送結果正確。
