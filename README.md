# splitbill-service

Mousebot 分帳系統的獨立服務：**網頁記帳介面（`public/`）＋ REST API ＋ SSE 即時同步 ＋ 帳本資料**。
網頁可以獨立使用（Discord 登入、自己建立行程、邀請朋友），也可以把行程綁定到 Discord 伺服器，
讓 Mousebot 的 `/splitbill` 面板一起操作（Bot 端：`handlers/splitbill/utils/splitbillClient.js`）。

## 資料模型
- 行程是頂層實體，以 `tripId` 為主鍵；`trip.guildId` 是綁定的 Discord 伺服器（`null`＝未綁定，Bot 看不到）。
- 成員 `{ id, name, discordId? }`：帳目一律引用 `id`；`discordId` 是已連結的 Discord 帳號。
  未連結的成員在 Discord 只顯示名字、不能操作面板。
- `discordId` 只能經由受控流程寫入：本人用行程連結認領、Bot 從 Discord 使用者選單加人／連結；
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
- **只能跑單一實例**：所有路由讀寫的是記憶體裡的 cache，SSE 推播、限流、帳單辨識協作也都在記憶體裡。
  同一個資料庫檔若同時被兩個實例寫入（例如滾動部署時新舊版本重疊），寫入前會用 `PRAGMA data_version`
  發現對方寫過，拒絕這次寫入（回 503、請使用者重試）並重新載入，不會悄悄蓋掉對方的資料；
  但重疊期間各自的 SSE 推播看不到對方的更新。正式環境請設定成「先停舊的再起新的」，或確保同時只有一個實例。
- 用 sqlite3 查資料：`sqlite3 splitbill.db "select id, guild_id, owner_id, updated_at from trips"`。

## 權限
| 身分 | 怎麼辨認 | 能做什麼 |
|---|---|---|
| 行程建立者 | `ownerId`，或 `OWNER_USER_ID` 名單 | 全部，含刪除行程、管理行程連結、綁定碼、解除綁定、解除任何人的連結。`OWNER_USER_ID` 用 Discord 登入網頁後可以切換「列出所有行程」（`/api/my/trips?all=1`） |
| 成員 | 有一位成員的 `discordId` 是自己 | 讀寫帳目、取得邀請連結、解除自己的連結 |
| 連結訪客 | 只走網址路徑 `/api/shared-trip/:token/...`（含 `fx-rate`、`parse-receipt`、`receipt-session`、`events`） | 依連結的 `guest` 唯讀／可編輯 |
| Bot | `x-api-key: SPLITBILL_API_KEY`＋`x-actor-id` | 依 `x-actor-id` 那位使用者套用上面的規則 |
| 管理端 | `x-api-key: SPLITBILL_API_KEY`（不帶 `x-actor-id`） | 全部（只給 Bot／維運腳本，網頁不接受金鑰） |

`x-api-key` 只代表 `SPLITBILL_API_KEY`，金鑰不對一律回 401，不會被當成分享連結。

### 行程連結
分享連結與邀請連結是同一種連結（`trip.links`），網址都是 `/#link=<token>`（舊的 `#share=`、`#invite=` 照樣能用）。每條連結有兩個獨立的設定：
- `guest`：不登入直接打開時的權限，`none`（不開放）／`read`／`write`
- `join`：用 Discord 登入後可以認領成員或以新成員加入

點開連結時：已經是成員就直接開啟行程；連結允許加入就先問要不要登入加入（同時開放訪客的話，也可以選「不登入直接開啟」）；否則以訪客身分開啟。
舊資料的 `shareLinks`（→ `join: false`）與 `invite`（→ `guest: 'none', join: true`）在載入時自動轉換，token 不變。

## 部署
1. 部署成與 Mousebot **同一個 Project** 底下的獨立服務，掛 Volume 到 `/app/data`（`SPLITBILL_DATA_DIR`）。
2. 環境變數：
   | 變數 | 說明 |
   |---|---|
   | `SPLITBILL_API_KEY` | Bot 連線用的共用金鑰（`x-api-key`）。沒設定時 Bot 無法連線 |
   | `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord Developer Portal → OAuth2（可以直接用 Mousebot 那個 Application） |
   | `PUBLIC_BASE_URL` | 網頁對外網址，例如 `https://splitbill.app`。Discord 後台 OAuth2 → Redirects 要加上 `<PUBLIC_BASE_URL>/auth/discord/callback` |
   | `SESSION_SECRET` | 至少 32 字元的隨機字串（簽登入 cookie）；換掉會讓所有人被登出 |
   | `OWNER_USER_ID` | 選填。Bot 擁有者的 Discord ID（逗號分隔），對所有行程有建立者權限 |
   | `SPLITBILL_TRIP_LIMIT_PER_USER` | 選填。每人最多建立幾個行程，預設 100 |
   | `GEMINI_API_KEY` | 選填。網頁版帳單照片辨識（登入者每小時 30 次） |
   | `PORT` / `SPLITBILL_DATA_DIR` | 預設 3000 / Dockerfile 的 `/app/data` |
   | `SPLITBILL_BACKUP_KEEP` | 選填。每日備份保留幾份，預設 7；`0` 關閉 |
   | `SPLITBILL_REVISIONS_KEEP` | 選填。每個行程保留幾個歷史版本，預設 20；`0` 關閉 |
   | `SPLITBILL_SQLITE_JOURNAL` | 選填。預設 `WAL`；Volume 若是不支援共享記憶體的網路檔案系統，改成 `DELETE` |
3. 健康檢查路徑：`/healthz`。回應裡的 `upstream` 是外部服務最近的狀態（`fx`＝匯率、`gemini`＝帳單辨識）：
   `ok`／`degraded`（最近一次失敗）／`unknown`（啟動後還沒用過）。外部服務壞掉不影響 `ok: true`，網頁都有退路。
4. Bot 端：`SPLITBILL_SERVICE_URL=http://<本服務名稱>.internal:3000`、`SPLITBILL_SERVICE_KEY=<同一把金鑰>`。
5. **升級順序：先部署本服務，再更新 Mousebot。** 舊網址 `/api/trip/:guildId/:tripId` 仍可用，
   過渡期間舊版 Mousebot 照常運作；新版 Mousebot 需要本服務的新端點。

## API 摘要
- 身分：`GET /api/me`、`GET /auth/discord/login?next=`、`POST /auth/logout`
- 行程：`GET /api/my/trips`、`POST /api/trips`、`GET|PUT|DELETE /api/trip/:tripId`、`GET /api/trip/:tripId/events`（SSE）
- 行程連結：`GET|POST /api/trip/:tripId/links`、`PATCH|DELETE /api/trip/:tripId/links/:token`（建立者）、
  `GET /api/trip/:tripId/invite`（成員取得預設邀請連結）、`GET /api/link/:token`（解析）、`POST /api/link/:token/claim`（認領）
- 單筆帳目：`PUT|DELETE /api/trip/:tripId/expenses/:id`、`PUT|DELETE /api/trip/:tripId/deposits/:id`
  （body `{ entry, writerId }`；回傳 `prevUpdatedAt`／`updatedAt`）。網頁記帳一律走這裡，整包 PUT 只用在設定與 Bot
- 連結訪客：`GET|PUT /api/shared-trip/:token`，以及同路徑下的 `events`、`fx-rate`、`parse-receipt`、`receipt-session`、`expenses/:id`、`deposits/:id`
- 成員：`POST /api/trip/:tripId/members/:memberId/unlink`
- 綁定：`POST /api/trip/:tripId/bind-code`、`POST /api/attach`（Bot）、`POST /api/trip/:tripId/detach`
- Bot 專用：`GET /api/guild/:guildId`、`PATCH /api/guild/:guildId/active-trip`
- cookie 登入的寫入請求必須帶 `x-requested-with: splitbill`（CSRF）

## 安全性
- **資料格式**：成員／支出／轉帳的 id 只能是 `[A-Za-z0-9_-]`（1～64 字元），幣別是 2～10 個大寫英數（`lib/validate.js`）。
  整包 PUT 為了相容舊版 Bot 只做修復：不合格的 id 換新（成員 id 會連帳目裡的引用一起改），數字欄位不是有限數字就當 0。
  單筆帳目 API 則嚴格驗證（成員必須存在、代墊與分攤的總和要等於總金額），不合格回 400。
- **帳單辨識協作狀態**會廣播給同一個行程的其他人，伺服器只保留已知欄位並檢查格式。
- **前端不使用 inline 事件屬性**（onclick 等）：一律寫成 `data-click="函式名" data-args='[…]'`，由 `public/js/actions.js`
  統一處理，可呼叫的函式要登記在 `UI_ACTIONS`。伺服器送出 `Content-Security-Policy: script-src 'self'`，
  inline script 與 inline 事件屬性在瀏覽器裡都不會執行。新增按鈕時用 `act('click', '函式名', 參數…)` 產生屬性。

## 本機執行與測試
```
npm install
SPLITBILL_API_KEY=dev node server.js
npm test
```
