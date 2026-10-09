# splitbill-service

Mousebot 分帳系統的獨立服務：**網頁記帳介面（`public/`）＋ REST API ＋ SSE 即時同步 ＋ 帳本資料**。
網頁可以獨立使用（Discord 登入、自己建立行程、邀請朋友），也可以把行程綁定到 Discord 伺服器，
讓 Mousebot 的 `/splitbill` 面板一起操作（Bot 端：`handlers/splitbill/utils/splitbillClient.js`）。

## 資料模型
- 行程是頂層實體，以 `tripId` 為主鍵；`trip.guildId` 是綁定的 Discord 伺服器（`null`＝未綁定，Bot 看不到）。
- 成員 `{ id, name, discordId? }`：帳目一律引用 `id`；`discordId` 是已連結的 Discord 帳號。
  未連結的成員在 Discord 只顯示名字、不能操作面板。
- `discordId` 只能經由受控流程寫入：本人用邀請連結認領、Bot 從 Discord 使用者選單加人／連結；
  網頁與分享連結的 PUT 一律無法改動它（`lib/members.js`）。
- 舊版（v1，行程掛在伺服器底下）資料會在匯入 SQLite 時一併轉換。
  舊成員的 `id` 本身就是 Discord ID，遷移只補上 `discordId = id`，帳目不需改寫。

## 資料儲存（SQLite）
- 資料存在 `$SPLITBILL_DATA_DIR/splitbill.db`，使用 Node 內建的 `node:sqlite`（需要 Node ≥ 22.13，不必安裝原生模組）。
- **從舊版升級**：第一次啟動時若找到 `splitbill.json`，會在一個交易裡整份匯入，成功後改名成
  `splitbill.json.imported-<時間戳>`（之後不會再讀它，確認無誤後可以刪掉）。
- **讀不懂就不啟動**：`splitbill.json` 或資料庫損毀時服務直接啟動失敗，不會以空資料上線。
- **每日備份**：`backups/splitbill-YYYY-MM-DD.db`（UTC 日期），啟動時與之後每小時檢查一次，保留最近 7 份。
  還原方式：停掉服務，把備份檔複製成 `splitbill.db`（並刪掉同名的 `-wal`／`-shm` 檔）再啟動。
- **歷史版本**：每次行程內容變動（`updatedAt` 改變）會在 `trip_revisions` 留一份不含憑證的快照，每個行程保留最近 20 份。
- `updatedAt` 是行程的版本號，保證嚴格遞增；SSE 的 `trip-updated` 事件在資料確實寫進資料庫之後才發出。
- 用 sqlite3 查資料：`sqlite3 splitbill.db "select id, guild_id, owner_id, updated_at from trips"`。

## 權限
| 身分 | 怎麼辨認 | 能做什麼 |
|---|---|---|
| 行程建立者 | `ownerId`，或 `OWNER_USER_ID` 名單 | 全部，含刪除行程、分享連結、綁定碼、解除綁定、解除任何人的連結 |
| 成員 | 有一位成員的 `discordId` 是自己 | 讀寫帳目、取得邀請連結、解除自己的連結 |
| 分享連結 | `x-api-key: <token>` 或 `/api/shared-trip/:token` | 依連結權限唯讀／可編輯 |
| Bot | `x-api-key: SPLITBILL_API_KEY`＋`x-actor-id` | 依 `x-actor-id` 那位使用者套用上面的規則 |
| 管理端 | `x-api-key: SPLITBILL_API_KEY`（不帶 `x-actor-id`） | 全部 |

## 部署（Zeabur）
1. 部署成與 Mousebot **同一個 Project** 底下的獨立服務，掛 Volume 到 `/app/data`（`SPLITBILL_DATA_DIR`）。
2. 環境變數：
   | 變數 | 說明 |
   |---|---|
   | `SPLITBILL_API_KEY` | Bot 連線用的共用金鑰（`x-api-key`）。沒設定時 Bot 無法連線 |
   | `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord Developer Portal → OAuth2（可以直接用 Mousebot 那個 Application） |
   | `PUBLIC_BASE_URL` | 網頁對外網址，例如 `https://splitbill.zeabur.app`。Discord 後台 OAuth2 → Redirects 要加上 `<PUBLIC_BASE_URL>/auth/discord/callback` |
   | `SESSION_SECRET` | 至少 32 字元的隨機字串（簽登入 cookie）；換掉會讓所有人被登出 |
   | `OWNER_USER_ID` | 選填。Bot 擁有者的 Discord ID（逗號分隔），對所有行程有建立者權限 |
   | `SPLITBILL_TRIP_LIMIT_PER_USER` | 選填。每人最多建立幾個行程，預設 100 |
   | `GEMINI_API_KEY` | 選填。網頁版帳單照片辨識（登入者每小時 30 次） |
   | `PORT` / `SPLITBILL_DATA_DIR` | 預設 3000 / Dockerfile 的 `/app/data` |
   | `SPLITBILL_BACKUP_KEEP` | 選填。每日備份保留幾份，預設 7；`0` 關閉 |
   | `SPLITBILL_REVISIONS_KEEP` | 選填。每個行程保留幾個歷史版本，預設 20；`0` 關閉 |
   | `SPLITBILL_SQLITE_JOURNAL` | 選填。預設 `WAL`；Volume 若是不支援共享記憶體的網路檔案系統，改成 `DELETE` |
3. 健康檢查路徑：`/healthz`。
4. Bot 端：`SPLITBILL_SERVICE_URL=http://<本服務名稱>.zeabur.internal:3000`、`SPLITBILL_SERVICE_KEY=<同一把金鑰>`。
5. **升級順序：先部署本服務，再更新 Mousebot。** 舊網址 `/api/trip/:guildId/:tripId` 仍可用，
   過渡期間舊版 Mousebot 照常運作；新版 Mousebot 需要本服務的新端點。

## API 摘要
- 身分：`GET /api/me`、`GET /auth/discord/login?next=`、`POST /auth/logout`
- 行程：`GET /api/my/trips`、`POST /api/trips`、`GET|PUT|DELETE /api/trip/:tripId`、`GET /api/trip/:tripId/events`（SSE）
- 成員：`GET /api/trip/:tripId/invite`、`POST /api/trip/:tripId/invite/rotate`、`GET /api/invite/:token`、
  `POST /api/invite/:token/claim`、`POST /api/trip/:tripId/members/:memberId/unlink`
- 綁定：`POST /api/trip/:tripId/bind-code`、`POST /api/attach`（Bot）、`POST /api/trip/:tripId/detach`
- Bot 專用：`GET /api/guild/:guildId`、`PATCH /api/guild/:guildId/active-trip`
- 分享連結：`/api/trip/:tripId/share-links`（建立者）、`/api/shared-trip/:token`
- cookie 登入的寫入請求必須帶 `x-requested-with: splitbill`（CSRF）

## 本機執行與測試
```
npm install
SPLITBILL_API_KEY=dev node server.js
npm test
```
