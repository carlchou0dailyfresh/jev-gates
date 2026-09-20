# 配送沿線公開事件來源

查核日期：2026-09-20（臺灣時間）。路線頁使用官方公開通報；來源可讀取與通報正確、位置精準、道路仍然封閉，是不同的判斷。

## 已介接：警察廣播電臺

- 官方資料集：[警廣即時路況，資料集 15221](https://data.gov.tw/dataset/15221)。由民眾與各單位提供路況，免費、不定期更新，政府資料開放授權條款第 1 版。官方說明指出每次提供最後更新的 1,000 筆通報，與警廣查詢頁可有至多 1 分鐘時間差。
- 資料集目前連結的 JSON：[警廣公開路況](https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata)。不再使用過去流傳的 `data.moi.gov.tw` 位址。
- 官方主要欄位包含 `UID`、`roadtype`、`road`、`areaNm`、`x1`（經度）、`y1`（緯度）、`happendate`、`happentime`、`modDttm`、`comment`、`srcdetail`、`direction`。
- 實際成功讀取 1,000 筆，約 472 KB。HTTP 回應雖使用 `text/plain;charset=UTF-8`，內容為 `{ "result": [...] }` JSON，因此不僅依 Content-Type 判定格式。這次可讀取不保證後續來源持續可用。

此次資料品質觀察：108 筆通報共用 `25.09108, 121.5598`，其中內容涵蓋多個不同臺北路段。這些點位不能直接當作精確封路位置。程式把相同約 1 公尺座標、至少 3 種不同內容的通報標為 `shared_point`。其餘 `reported_point` 仍只表示來源提供的點位，沒有替來源驗證道路、方向或實際影響範圍。沒有可用或位於臺灣及離島合理範圍內的座標時保留事件，但標為 `unlocated`。

來源沒有結構化的封路終止時間。`startAt` 只是 `happendate + happentime` 的臺灣時間轉 UTC，不代表已核實的交通管制起點；`endAt` 為 `null`。`active`、`blocking` 保留 `unknown`；「交通管制」分類也不直接等於整條道路禁止通行。文字如包含解除、部分車道、特定時段等限制，不能僅以關鍵字推成全面封路。

## 讀取與判斷契約

`createRouteEvents()`（別名 `createRouteEventsProvider()`）提供 `health()` 與 `fetch({ force, signal })`：

- `status: available` 表示本次有有效來源資料，事件數可為 0；`unavailable` 表示本次無法取得可用資料，不能解讀成沒有事件。
- 回傳事件保留來源 URL、資料集 URL、原始文字、來源更新時間、抓取時間、來源分類、位置品質、`credibility: reported`。來源文字只作待評估資料，不能當作給模型的指令。
- 主頁只接收**來源更新在最近 15 分鐘內**的事件：`0 <= 現在 − updatedAt <= 900 秒`。這是本產品的顯示與模型輸入門檻，**不是警廣的更新 SLA，也不是即時車流或事件持續發生的保證**。來源更新時間不等於事件發生時間；昨天發生而今天更新的通報仍須顯示其原始時間、保持有效狀態待確認，不能改標成今天新發生的事故。
- 超過 900 秒、缺失／無效更新時間，以及任何未來更新時間（即使只超前 1 毫秒）都不送入沿線清單、地圖或模型。它們僅以排除計數與來源時間範圍揭露。`fetchedAt` 是抓取時間，`sourceLatestUpdatedAt` 是來源通報最新更新時間，`evaluatedAt` 是本次重算時效的時間，三者不互相替代。
- 固定官方端點，禁止重新導向，不接受任意使用者 URL。不傳送使用者位置、地點輸入或路線給事件來源。
- 10 秒上限包含完整本文，最多 2 MiB、2,000 個原始項目。去除不合法項目並回報數量；整份非空資料完全無法解析時回 `unavailable`。
- 成功與失敗皆使用 60 秒程序內快取，保留最初抓取時間；共享正在進行的請求，計算實際請求次數。每次讀取快取都用目前時鐘重新篩選，事件跨過 15 分鐘界線後立即從回傳清單移除，沒有等下一次外部抓取。強制重新整理失敗不會沿用舊清單冒充新資料。取消的查詢不快取；時鐘倒退不會延長快取期限或把未來事件當作近期事件。
- 沒有模型、地圖或事件來源的自動替代假資料，沒有請求重試。

`filterEventsNearRoute(events, coordinates, radiusMeters = 500)` 使用 GeoJSON `[longitude, latitude]` 折線及球面點到線段距離，回傳附近事件與距離、無座標數、排除數、位置不確定數。它只判斷通報點與路線的接近程度，不證明同一條道路、行車方向、平面或高架層，也不證明道路被封閉。`shared_point` 會保留品質標記，不能作為確定封路證據。

公開通報覆蓋不完整，沒有附近資料不是道路暢通或安全的證據。自動調整路線需要各必要邏輯閘都具足夠證據；位置或有效期間不明時應保留待確認，不能把 `UNKNOWN` 偷換成 `FALSE` 或成功。

### 時效回應欄位

`provenance.events.freshness`（直接使用事件提供者時為 `provenance.freshness`）的 `scope` 固定為 `source_feed`。其中 `eligibleCount`、`excluded.stale/unknown/future/total` 與 `parsedCount` 均針對整份來源，**不是使用者沿線事故數**；`sourceOldestUpdatedAt/sourceLatestUpdatedAt` 是可解析來源時間範圍，`oldestEligibleUpdatedAt/newestEligibleUpdatedAt` 是符合門檻的時間範圍。`status: current` 表示來源清單有符合門檻的通報；`no_recent_events` 表示沒有符合門檻的通報；`unavailable` 表示讀取失敗且數量未知，不能當成 0。

路線回應另有 `provenance.events.routeFreshness`，其 `scope: candidate_routes` 表示全部已取得候選線附近的範圍，含 `eligibleCount`、`displayedCount`、`omittedCount` 與 `expiredDuringEvaluationCount`。尚未展示或未完成的候選保留待確認。服務在地理篩選前、模型送出前與路線選擇前重查時效；模型處理期間過期的事件與它的候選影響標記會移除，但已發生的模型請求仍計入用量。沒有符合時效的沿線通報時回 `summary.state: review`，保留道路建議而不稱路況已確認。

## 已查核但未作為自動避讓來源

[臺北市即時交通訊息](https://data.taipei/dataset/detail?id=a6fae9f8-8d0f-4605-98ac-577388a7734f) 的官方 [news.json](https://tcgbusfs.blob.core.windows.net/dotapp/news.json) 可以公開讀取，提供道路壅塞、交通管制與臺北好行公告。查核時包含公車活動及路跑管制等文字，但是沒有座標，`starttime`／`endtime` 是公告區間，與內文實際管制時間不同。沒有將公告期間推成封路期間，也沒有由語言模型捏造定位點位。

[TDX 省道發布路段即時路況](https://data.gov.tw/dataset/161171) 要求先註冊建立 API Key，本輪沒有使用尚未設定的憑證或宣稱已接上。

這些來源及單次程式測試只驗證資料接入和控制邏輯，不能代表真實 JEV 語意準確率、實際避免事故、即時車流覆蓋、費用節省或 AGI。
