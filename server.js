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
 *   SPLITBILL_API_KEY   （強烈建議設定）共用金鑰，網頁前端與 Bot 都用 x-api-key 帶上
 *   PORT / SPLITBILL_WEB_PORT   監聽埠號，預設 3000
 *   SPLITBILL_DATA_DIR  資料目錄（放 splitbill.json），預設 ./data；請掛 Volume 到這裡
 *   GEMINI_API_KEY      網頁版帳單照片辨識需要（沒設定只會停用該功能）
 */

const path = require('path');
const express = require('express');

// ⚠️ 依你實際的專案結構調整這行路徑（本檔預期放在 repo 根目錄的 webui/ 資料夾）
const storage = require('./lib/storage');

const { getFxRatesFor } = require('./lib/fxRates');
const { genAI, extractJsonObject, sanitizeReceiptResponse, recognizeReceipt } = require('./lib/receiptScan');
const { createApiKeyMiddleware, createAuthHelpers } = require('./lib/auth');
const { createSseHub, attachTripEventBroadcast } = require('./lib/sse');
const { getReceiptSession, setReceiptSession, clearReceiptSession } = require('./lib/receiptSessions');

const createTripsRouter = require('./routes/trips');
const createShareLinksRouter = require('./routes/shareLinks');
const createSharedTripRouter = require('./routes/sharedTrip');
const createSseRouter = require('./routes/sse');
const createUtilityRouter = require('./routes/utility');
const createReceiptSessionRouter = require('./routes/receiptSession');
const createGuildRouter = require('./routes/guild');

function startWebApi(options = {}) {
  const port = options.port || process.env.PORT || process.env.SPLITBILL_WEB_PORT || 3000;
  const apiKey = options.apiKey || process.env.SPLITBILL_API_KEY || '';

  const app = express();
  app.use(express.json({ limit: '12mb' })); // 帳單照片辨識會傳一張壓縮過的 base64 圖片，2mb 太小

  // 健康檢查：不經金鑰驗證，讓平台的 health probe 可以直接探測
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // 提供前端靜態頁面（public/index.html），同源存取可避免 CORS 問題
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- 金鑰驗證（僅保護 /api/* 路由，細節見 lib/auth.js） ----
  app.use('/api', createApiKeyMiddleware(apiKey));

  // ---- 🆕 [即時同步] 掛上 SSE 廣播：任何一條寫入路徑呼叫 storage.touchTrip()
  // 時，都會自動推播給該行程目前所有開著的 SSE 連線（見 lib/sse.js）。
  const sseHub = createSseHub();
  attachTripEventBroadcast(storage, sseHub);

  // ---- 組裝共用的 ctx，各個 router 依需要挑選使用 ----
  const auth = createAuthHelpers({ storage, apiKey });
  const ctx = {
    storage,
    apiKey,
    ...auth,       // authorizeTripAccess, requireOwner, hasShareableCredential
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

  app.listen(port, () => {
    console.log(`[splitbill-web] 網頁記帳介面已啟動： http://0.0.0.0:${port}`);
    if (!apiKey) {
      console.warn('[splitbill-web] ⚠️ 尚未設定 SPLITBILL_API_KEY，任何能連到這個埠的人都能讀寫帳本資料，建議至少設定一組金鑰或只在內網／VPN 開放。');
    }
  });
}

// 保留原本的對外匯出介面：startWebApi 以外，extractJsonObject / sanitizeReceiptResponse /
// getFxRatesFor 過去可能被其他檔案（例如測試）直接 require 使用，拆分後繼續原樣匯出。
module.exports = { startWebApi, extractJsonObject, sanitizeReceiptResponse, getFxRatesFor };

if (require.main === module) startWebApi();
