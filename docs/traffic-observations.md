# 臺北道路速度觀測

`POST /api/traffic/nearby` 顯示官方發布的附近路段平均速度。這項功能不修改 OSRM 路線、行車估時、公車到站預估或模型判斷。

資料由[臺北市道路速率資料集](https://data.taipei/dataset/detail?id=b5aaf33a-a6dc-4836-bce6-09986241fe11)所列的[官方 GZip 檔](https://tcgbusfs.blob.core.windows.net/blobtisv/GetVD.xml.gz)取得，不需要 API 金鑰。實際使用仍須遵守來源授權及服務可用性；本介面不改用其他來源補值。

## 資料能說明什麼

[交控中心欄位說明](https://www-ws.gov.taipei/001/Upload/public/mmo/dot/臺北市交通控制中心資料庫介接說明文件.pdf)定義 `AvgSpd` 為路段內偵測器平均車速，單位 km/h；`-1` 為無資料。`MOELevel` 為來源判定的績效，`0/1/2` 對應順暢、車多、壅塞，`-1` 表示無資料。介面直接沿用來源分級，不重新從速度猜測壅塞。速度缺失、負值或來源分級無效時，回傳 `speedKph: null`；有效的 `0` 保留為零。

官方說明使用五分鐘平滑速度。資料包含路段起終點，沒有完整道路線形；高架與平面道路、相反方向可能非常接近。因此以起點、中點、終點到候選路線的最短距離篩選 300 公尺內資料，最多顯示最近五筆，固定標示「候選路線附近，非確認同一路段」。這是近似篩選，不是道路或方向匹配，也不能據此宣稱路線全程的交通狀況。

`ExchangeTime` 代表整份檔案交換時間，不是每個偵測器的觀測時間。2025 年資料集清單記載每分鐘更新，2014 年欄位文件描述五分鐘更新；本介面不將其中任一數字當作服務時效保證，也不把成功下載等同於準確。

## 時效與前端顯示

`freshness.state` 有 `fresh`、`stale`、`unknown` 三種值。只有來源時間可解析，且 `0 ≤ 目前時間 − 來源時間 ≤ 120 秒` 時，才提供觀測數字。120 秒是本產品顯示條件，不代表感測器測量誤差或官方保證。來源時間在未來、缺失、格式不合法或超過期限時，觀測清單為空。

伺服器快取整份來源 30 秒，每次讀取都重新計算來源年齡，並在距離運算後再次檢查。快取命中保留原始 `fetchedAt`；不能用本次查詢完成時間替換來源時間。重新抓取失敗時不回傳上一份成功資料，失敗也會短暫冷卻，避免重複查詢。

前端應在顯示期間持續重新計算 `sourceUpdatedAt` 的年齡，並在頁面恢復可見時立即檢查。超過 `maxAgeSeconds` 後應隱藏車速數字或改顯示明確的歷史紀錄，不能因為尚未發出下一次查詢而保留「即時」標示。沒有附近觀測或所有值缺失，不代表道路暢通。

## 介面契約

請求只能包含 `coordinates`，採 GeoJSON 的 `[經度, 緯度]` 次序，至少 2 點、最多 2000 點。無效座標、額外欄位、跨來源請求或重疊查詢會被拒絕。

```json
{
  "coordinates": [[121.5172, 25.0468], [121.5298, 25.0441]]
}
```

回應包含：

- `status`：`available`、`stale` 或 `unavailable`。來源失效通常以 HTTP 200 回傳空結果與明確狀態；輸入及 HTTP 邊界錯誤使用 4xx。
- `observations`：最多五筆，包含 `id`、`name`、`speedKph`、`congestionLabel`、`lat`、`lng`、`distanceMeters`、`matchLabel`。標記座標是用來近似篩選的路段端點或中點。
- `freshness`：`state`、`sourceUpdatedAt`、`ageSeconds`、`maxAgeSeconds: 120`。
- `provenance`：固定來源、資料集連結、`fetchedAt`、`cached`、`measurement: "5分鐘平滑平均"`、`timeBasis: "feed_exchange_not_sensor_observation"`、距離與顯示數量限制。
- `metrics`：本次實際來源請求數、經過時間、來源紀錄數、排除紀錄數、附近候選數。快取命中時 `requests` 為零。

`createTrafficObservationsApi()` 可掛入本機 HTTP 伺服器；`createTrafficObservations({ fetchImpl, now })` 支援測試注入。請將 `/api/traffic/` 路由交給此處理器，不接受呼叫端指定上游 URL。

## 邊界與驗證

僅存取固定官方 HTTPS 端點，不跟隨重新導向。來源讀取逾時上限 10 秒，壓縮內容最多 512 KiB，解壓後最多 2 MiB，最多 2000 筆路段。只接受已知 XML 結構，不解析 DTD 或自訂實體；僅解碼五種 XML 內建文字跳脫。取消請求會中止來源讀取，並行查詢回傳 429。沒有新增第三方套件、模型呼叫或公車 ETA 計算。

測試執行：

```sh
node --test tests/traffic-observations.test.mjs
```

測試涵蓋零與缺失速度、時間邊界、未知與未來時間、快取後老化、失敗不保留舊值、壓縮大小限制、空來源、異常 XML、取消、並行及同來源 HTTP 邊界。2026-09-20 本機 HTTP 實測成功取得來源時間 08:49:03 的 617 個路段；查詢時來源年齡約 10.5 秒，第二次查詢使用快取且沒有新增來源請求。這只證明當次來源與程式整合可用，沒有證明道路現場準確率或公車到站誤差。
