'use strict';
/**
 * Splitbill Service
 * -----------------------------------------------------------------
 * 從 Mousebot 拆分出來、獨立部署的分帳服務：網頁記帳介面（public/）、
 * REST API、SSE 即時同步，以及分帳資料本身（JSON 檔，之後可升級成資料庫）。
 * Mousebot 的 Discord 端透過內部網路呼叫這裡的 API
 * （見 Mousebot 的 handlers/splitbill/utils/splitbillClient.js）。
 *
 * 環境變數：
 *   SPLITBILL_API_KEY   Bot（與維運）用的共用金鑰，以 x-api-key 帶上；沒設定時 Bot 無法連線
 *   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / PUBLIC_BASE_URL / SESSION_SECRET
 *                       網頁的 Discord 登入（見 routes/oauth.js）；沒設定時網頁只能用分享連結
 *   OWNER_USER_ID       Bot 擁有者的 Discord ID（逗號分隔），對所有行程有建立者權限
 *   PORT / SPLITBILL_WEB_PORT   監聽埠號，預設 3000
 *   SPLITBILL_DATA_DIR  資料目錄（放 splitbill.json），預設 ./data；請掛 Volume 到這裡
 *   GEMINI_API_KEY      網頁版帳單照片辨識需要（沒設定只會停用該功能）
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const storage = require('./lib/storage');

const { getFxRatesFor } = require('./lib/fxRates');
const { genAI, extractJsonObject, sanitizeReceiptResponse, recognizeReceipt } = require('./lib/receiptScan');
const { createIdentityMiddleware, createAuthHelpers } = require('./lib/auth');
const session = require('./lib/session');
const { createLegacyTripPathRewrite } = require('./lib/legacyPaths');
const { createSseHub, attachTripEventBroadcast } = require('./lib/sse');
const { getReceiptSession, setReceiptSession, clearReceiptSession } = require('./lib/receiptSessions');

const createTripsRouter = require('./routes/trips');
const createShareLinksRouter = require('./routes/shareLinks');
const createSharedTripRouter = require('./routes/sharedTrip');
const createSseRouter = require('./routes/sse');
const createUtilityRouter = require('./routes/utility');
const createReceiptSessionRouter = require('./routes/receiptSession');
const createGuildRouter = require('./routes/guild');
const createMeRouter = require('./routes/me');
const createOAuthRouter = require('./routes/oauth');
const createMembersRouter = require('./routes/members');
const createAttachRouter = require('./routes/attach');

// 把 index.html 裡 href="css/..." / src="js/..." 的本地資源加上 ?v=<檔案內容雜湊>
function buildVersionedIndexHtml(publicDir) {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  return html.replace(/(href|src)="((?:css|js)\/[^"?#]+)"/g, (match, attr, rel) => {
    try {
      const hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(publicDir, rel))).digest('hex').slice(0, 10);
      return `${attr}="${rel}?v=${hash}"`;
    } catch (err) {
      return match;
    }
  });
}

function startWebApi(options = {}) {
  const port = options.port || process.env.PORT || process.env.SPLITBILL_WEB_PORT || 3000;
  const apiKey = options.apiKey || process.env.SPLITBILL_API_KEY || '';

  const app = express();
  app.use(express.json({ limit: '12mb' })); // 帳單照片辨識會傳一張壓縮過的 base64 圖片，2mb 太小

  // 健康檢查：不經金鑰驗證，讓平台的 health probe 可以直接探測
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // 提供前端靜態頁面（public/index.html），同源存取可避免 CORS 問題
  // index.html 裡的 css/js 網址會加上內容雜湊（?v=xxxx），每次部署只要檔案有改，
  // 網址就會變，手機瀏覽器或前面的 CDN 不會再拿舊的快取；index.html 本身一律不快取。
  const publicDir = path.join(__dirname, 'public');
  const versionedIndexHtml = buildVersionedIndexHtml(publicDir);
  app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(versionedIndexHtml);
  });
  app.use(express.static(publicDir));

  // ---- 🆕 [行程獨立化] 舊網址 /api/trip/:guildId/:tripId → /api/trip/:tripId ----
  app.use('/api', createLegacyTripPathRewrite(storage));

  // ---- 🆕 [Discord 登入] OAuth 登入／登出（不在 /api 底下，瀏覽器直接導向） ----
  app.use('/auth', createOAuthRouter());

  // ---- 身分辨識：金鑰／分享 token／登入 cookie（細節見 lib/auth.js） ----
  app.use('/api', createIdentityMiddleware(apiKey));

  // ---- 🆕 [即時同步] 掛上 SSE 廣播：任何一條寫入路徑呼叫 storage.touchTrip()
  // 時，都會自動推播給該行程目前所有開著的 SSE 連線（見 lib/sse.js）。
  const sseHub = createSseHub();
  attachTripEventBroadcast(storage, sseHub);

  // ---- 組裝共用的 ctx，各個 router 依需要挑選使用 ----
  const auth = createAuthHelpers({ storage });
  const ctx = {
    storage,
    ...auth,       // requireTripAccess, requireService, requireUser, canLinkMembers, hasUtilityAccess, ...
    ...sseHub,      // sseTickets, pruneSseTickets, SSE_TICKET_TTL_MS, openTripSseStream, broadcastReceiptSession, ...
    getFxRatesFor,
    genAI,
    recognizeReceipt,
    // 🆕 [多人協作] 帳單辨識認領進度的共享狀態（見 lib/receiptSessions.js），
    // 刻意跟 storage 分開、不落地寫進 splitbill.json。
    getReceiptSession,
    setReceiptSession,
    clearReceiptSession,
  };

  app.use('/api', createSseRouter(ctx));
  app.use('/api', createTripsRouter(ctx));
  app.use('/api', createShareLinksRouter(ctx));
  app.use('/api', createSharedTripRouter(ctx));
  app.use('/api', createUtilityRouter(ctx));
  app.use('/api', createReceiptSessionRouter(ctx));
  app.use('/api', createGuildRouter(ctx));
  app.use('/api', createMeRouter(ctx));
  app.use('/api', createMembersRouter(ctx));
  app.use('/api', createAttachRouter(ctx));

  storage.loadAll(); // 啟動時就載入（必要時把 v1 資料遷移成 v2），不要等第一個請求進來

  app.listen(port, () => {
    console.log(`[splitbill-web] 網頁記帳介面已啟動： http://0.0.0.0:${port}`);
    if (!apiKey) {
      console.warn('[splitbill-web] ⚠️ 尚未設定 SPLITBILL_API_KEY：Bot 無法連線（網頁登入與分享連結不受影響）。');
    }
    if (!session.isEnabled() || !process.env.DISCORD_CLIENT_ID) {
      console.warn('[splitbill-web] ⚠️ 尚未設定 Discord 登入（DISCORD_CLIENT_ID／DISCORD_CLIENT_SECRET／PUBLIC_BASE_URL／SESSION_SECRET≥32 字元），網頁只能用分享連結或金鑰。');
    }
  });
}

// 保留原本的對外匯出介面：startWebApi 以外，extractJsonObject / sanitizeReceiptResponse /
// getFxRatesFor 過去可能被其他檔案（例如測試）直接 require 使用，拆分後繼續原樣匯出。
module.exports = { startWebApi, extractJsonObject, sanitizeReceiptResponse, getFxRatesFor };

if (require.main === module) startWebApi();
