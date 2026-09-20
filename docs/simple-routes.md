# 簡化路線介面與自動事件檢查

使用者只需要選擇出發點、終點並規劃。地圖優先呈現建議路線與附近事件；原先的配送研究控制保留在研究頁，不要求一般使用者編輯閘門、成本或經緯度。

## 資料與實際能力

- **路線**：OSRM 公開汽車路網服務，一次取得原建議與最多兩條替代候選。來源不一定能找到替代線。所有顯示的路線形狀都來自此回應，沒有直線或合成路網 fallback。這是道路模型估時，**不包含即時車流**。
- **地點**：六個本地公開地標可直接選取，其他地點透過 Photon 手動查詢。採 `countrycode=TW` 與台北市區包圍範圍；回傳也驗證國家和座標。包圍範圍是操作範圍，不是精確行政邊界。顯示地點不代表已核對汽車入口或停車處。
- **事件**：警廣官方公開通報；先依來源 `updatedAt` 排除超過 15 分鐘、未知與未來時間，再計算候選路線附近 500 公尺的通報。新抓取不會讓舊通報重新有效，沒有近期通報也不代表沒有事件。15 分鐘是產品門檻，並非來源 SLA 或即時車流保證。官方通報目前有共用地點、缺有效結束時間等品質限制，見 [事件來源與限制](route-event-sources.md)。
- **JEV**：只使用本機 LocalJev，先檢查就緒狀態，再對少量新事件用兩個獨立文字問題和 AND 判斷是否與最近候選相關、是否有實質汽車通行影響。每個事件只提供一條最近候選的 OSRM 道路名稱節錄；不把同一個 TRUE 套用其他候選。地理距離、時間、來源狀態和路線選擇仍由程式判斷。LocalJev 不等同 TypeSafe JEV；門檻 `.2/.8` 未經路線事件校準，結果不是準確率或道路安全證明。

目前警廣 adapter 不會把事件原文中的時間自行抽取成有效區間，也不會把報告座標猜成道路封閉邊界。缺乏可核對的起訖區間時，即使 JEV 回傳 TRUE，也只呈現待確認，保持原建議路線。

## 自動選路的條件

1. 事件來源必須成功取得。程式先檢查官方報告身分、來源更新距現在 0–900 秒、有效座標，排除共用位置或不明位置。更舊、無效或未來更新時間的通報不進入展示與模型候選；即使來源附有 `freshness: recent` 也會重新核對日期。
2. 最多 20 則附近事件被呈現，其中每次最多 **3 則新或變更事件 × 2 題**送到本機語意模型。超過上限或 UNKNOWN 保留待確認。內容、路線、模型相同的結果可在五分鐘內重用；`ageMinutes` 等觀察時間更新不會使同一事件重問。
3. 只有語意 AND 結果 TRUE、可核對時間區間涵蓋目前、與實際候選線最近路段距離不超過 70 公尺，才列為該候選的影響事件。70 公尺是研究用鄰近門檻，不能證明同一車道或方向封閉。若其他候選也貼近該位置，路段對應會保留待確認，不自動切換。
4. 原候選受影響，而已取得的另一候選沒有通過檢查的附近影響事件，且沒有來源／位置／語意待確認項目時，才切換到替代建議。所有候選仍受影響時不宣稱找到安全替代線。

自動切換只是前端研究路線建議，不啟動導航、不移動車輛、不承諾通行。模型分數不能取代現場路況與交通指示。

## 情境展示

`mode: "demo"` 仍取得真實 OSRM 道路候選，再於原候選建立一則明確的**合成**車道事件，以固定 TRUE 訊號展示 AND 與候選切換。沒有呼叫警廣或模型；不能用這個展示證明語意辨識、即時封路或效益。若 OSRM 沒有足夠分離的替代候選，介面會如實保留待確認，而不虛構繞路。

## 端點與限制

`workbench/server/simple-routes.mjs` 匯出 `createSimpleRoutesService(options)` 和 `createSimpleRoutesApi(options)`；服務可注入地圖 fetch、事件提供者、語意 evaluator、health 和時鐘做離線測試。

| 端點 | 輸入／行為 |
| --- | --- |
| `GET /api/routes/config` | 六個 `presets`、`defaults.origin/destination`、來源和限額；不在載入時呼叫模型。 |
| `POST /api/routes/search` | `{query}`，回 `places[{id,name,lat,lng,address?}]`。使用者按鈕提交，無網路 autocomplete。 |
| `POST /api/routes/plan` | `{origin:{name,lat,lng},destination:{name,lat,lng},mode?:"live"\|"demo"}`。回 `routes`、`events`、`summary`、`provenance`、實際請求 `metrics`。 |

HTTP 僅 loopback、同來源，JSON 輸入限 16 KiB；不接受使用者指定上游 URL。公開地圖／搜尋讀取上限 1 MiB、10 秒、無重試；只用固定 OSRM 來源。Photon 為單次使用者搜尋，每秒最多一次，結果記憶體快取 24 小時最多 64 組；OSRM 每秒最多一次，快取 60 秒最多 24 組。每輪模型推論最多三次、每次 25 秒，總判斷預算 85 秒，不自動切到雲端。瀏覽器離開或取消時，後續工作停止。

地圖和事件快取保留原取得時間，不把快取存取說成新抓取。事件快取每次取出都重算來源更新年齡；模型就緒檢查或推論跨過事件有效門檻時，再次剔除，連同已計算的候選影響標記一起移除。語意快取不能延長原事件時效。`metrics.mapRequests/eventRequests/modelRequests/modelQuestions` 是本次實際嘗試次數；過期後不展示的已執行推論仍會計數，健康檢查和可見底圖圖磚不在這些計數內，不是費用帳單。

`provenance.events.freshness.scope=source_feed` 的時效篩選與排除計數是整份來源資料；`routeFreshness.scope=candidate_routes` 才是候選線附近的近期事件數。兩者分開，避免把全台來源歷史通報說成此路線上的事故。來源 `fetchedAt`、`freshness.sourceLatestUpdatedAt` 和 `freshness.evaluatedAt` 分別代表抓取、來源最新更新、門檻核對時間。沒有符合門檻的沿線通報時，保留 `review`，不給出路況暢通的結論。

Photon 公共 demo 允許合理低量使用，但沒有可用性承諾。服務端可用 `PHOTON_BASE_URL=https://your-photon.example` 指向自架／獲准的 HTTPS Photon 來源，需重啟服務；瀏覽器不能傳此設定。公開搜尋會把使用者提交的地點名稱送至地點服務，介面用途是公開地址／地標，不應提交私人備註。不要為此頁建立頻繁 geocoding、批量掃描或逐字自動搜尋。

## 主要來源

- [OSRM Route API](https://project-osrm.org/docs/v5.24.0/api/#route-service)：候選線、GeoJSON 與替代線不保證存在。
- [Photon 官方專案](https://github.com/komoot/photon)：公共 demo 的合理低量使用與服務限制。
- [Photon API](https://github.com/komoot/photon/blob/master/docs/api-v1.md)：`bbox`、`countrycode`、`limit` 與 FeatureCollection。
- [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)：地點／道路資料來源標示。
- [TypeSafe JEV 簡介](https://docs.typesafe.ai/introduction)與[分數解讀](https://docs.typesafe.ai/confidence)：語意問題與模型結果的解讀限制。

本次測試將模型、事件和路網 fixture 注入來驗證 UNKNOWN、來源失敗、快取、上限、事件範圍與切換條件；不把這些測試當作真實世界導航或 JEV 準確率。手動公共服務探測中，Photon 的「國立故宮博物院」確實回傳台北市士林區至善路二段 221 號及座標，但尚未核對汽車入口。

## 即時資料範例

- 近期警廣通報僅供參考；來源可能沒有15分鐘內更新的紀錄。更新是來源修改時間，不是證明事故仍有效。
- 汽車摘要的「附近路段速度」讀取官方台北道路速率，來源交換時間超過120秒就停止顯示數字，前端在暫停更新後也會自行老化。這是5分鐘平滑平均及概略位置關聯，不改寫行車估時；詳見[道路速度](traffic-observations.md)。
- 右上「公車何時來」開啟 `/delivery/bus`，提供3個真實官方站牌查詢範例、路線方向與快照年齡；詳見[公車到站](bus-arrivals.md)。
