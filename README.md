# splitbill-service

Mousebot 分帳系統的獨立服務：**網頁記帳介面（`public/`）＋ REST API ＋ SSE 即時同步 ＋ 帳本資料**。
從 Mousebot 拆分出來，獨立部署、獨立維護；Mousebot 的 Discord 端透過內部網路呼叫本服務
（Bot 端的 `handlers/splitbill/utils/splitbillClient.js`）。

## 部署（Zeabur）
1. 建立新的 GitHub repo，把本資料夾內容放進去，部署成與 Mousebot **同一個 Project** 底下的獨立服務。
2. 掛一個 Volume 到 `/app/data`（`SPLITBILL_DATA_DIR`），`splitbill.json` 會存在這裡。
3. 環境變數：
   | 變數 | 說明 |
   |---|---|
   | `SPLITBILL_API_KEY` | **必填**。共用金鑰；網頁前端與 Bot 都用 `x-api-key` 帶上 |
   | `PORT` | 監聽埠，預設 3000 |
   | `SPLITBILL_DATA_DIR` | 資料目錄，Dockerfile 預設 `/app/data` |
   | `GEMINI_API_KEY` | 選填。網頁版帳單照片辨識用，沒設定只會停用該功能 |
4. 健康檢查路徑：`/healthz`（不需金鑰）。
5. Bot 端設定：`SPLITBILL_SERVICE_URL=http://<本服務名稱>.zeabur.internal:3000`、`SPLITBILL_SERVICE_KEY=<同一把金鑰>`。

## Bot 專用（擁有者金鑰）端點
- `GET /api/guild/:guildId` → `{ trips, activeTripByUser, defaultTripId }`
- `PATCH /api/guild/:guildId/active-trip` body `{ userId, tripId }`
- `PUT /api/trip/:guildId/:tripId`（建立／整包覆蓋；帶 `expectedUpdatedAt` 做樂觀鎖，版本不符回 409＋`currentTrip`；建立第一個行程時自動成為 guild 預設）
- `DELETE /api/trip/:guildId/:tripId`（清 default／個人指標並廣播 `trip-deleted`）
分享連結持有者無法呼叫 guild 端點與 DELETE。

## 本機執行
```
npm install
SPLITBILL_API_KEY=dev node server.js
```
