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
 *   SPLITBILL_DATA_DIR  資料目錄（放 splitbill.db 與 backups/），預設 ./data；請掛 Volume 到這裡
 *   GEMINI_API_KEY      網頁版帳單照片辨識需要（沒設定只會停用該功能）
 *   GEMINI_RECEIPT_MODEL  帳單辨識用的 Gemini 模型（預設 gemini-3.1-flash-lite）
 *   SPLITBILL_LOG_REQUESTS=all  每個請求都記一行 log（預設只記 403／409／429／5xx 與慢請求）
 *   ALERT_WEBHOOK_URL   Discord webhook：每日備份失敗時通知（未設定＝不送）
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');

const storage = require('./lib/storage');

const { getFxRatesFor } = require('./lib/fxRates');
const { genAI, extractJsonObject, sanitizeReceiptResponse, recognizeReceipt } = require('./lib/receiptScan');
const { createIdentityMiddleware, createAuthHelpers } = require('./lib/auth');
const session = require('./lib/session');
const { createLegacyTripPathRewrite } = require('./lib/legacyPaths');
const { createSseHub, attachTripEventBroadcast } = require('./lib/sse');
const { getReceiptSession, setReceiptSession, clearReceiptSession } = require('./lib/receiptSessions');

const createTripsRouter = require('./routes/trips');
const createLinksRouter = require('./routes/links');
const createSharedTripRouter = require('./routes/sharedTrip');
const createSseRouter = require('./routes/sse');
const createUtilityRouter = require('./routes/utility');
const createReceiptSessionRouter = require('./routes/receiptSession');
const createGuildRouter = require('./routes/guild');
const createMeRouter = require('./routes/me');
const createOAuthRouter = require('./routes/oauth');
const createMembersRouter = require('./routes/members');
const createAttachRouter = require('./routes/attach');
const createEntriesRouter = require('./routes/entries');
const createHistoryRouter = require('./routes/history');
const upstream = require('./lib/upstreamStatus');
const { requestLog, redactPath } = require('./lib/requestLog');

// 🔒 [安全性] Content-Security-Policy：腳本只能來自本站檔案，inline <script> 與
// onclick="…" 一律不執行（前端改用 js/actions.js 的事件委派）。就算哪天又有資料沒跳脫
// 就進了 HTML，也跑不起來。樣式仍允許 inline（style="…" 屬性很多，而且不能執行程式）。
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://cdn.discordapp.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// 帳單辨識端點（需要較大的 body）：/api/parse-receipt、/api/shared-trip/:token/parse-receipt
const RECEIPT_PATH_RE = /^\/api\/(?:shared-trip\/([^/]+)\/)?parse-receipt\/?$/;

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // 行程連結的 token 在網址的 # 後面，本來就不會送出；這裡再保險一次不帶完整網址給外站
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

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
  app.disable('x-powered-by');
  // 請求 id＋403／409／429／5xx 等結果的 log（lib/requestLog.js）
  app.use(requestLog());
  app.use(securityHeaders);
  // gzip：index.html／js／css／JSON 回應都很適合壓縮（手機網路差很多）。
  // SSE 一定要排除，否則事件會被壓縮緩衝卡住、不會即時送出。
  app.use(compression({
    filter: (req, res) => !/^text\/event-stream/i.test(String(res.getHeader('Content-Type') || '')) && compression.filter(req, res),
  }));
  // 帳單照片辨識會傳一張壓縮過的 base64 圖片，只有這個端點需要放寬到 12mb；
  // 其他端點（行程整包 PUT 最多 5000 筆支出＋5000 筆轉帳）5mb 綽綽有餘。
  // 🔒 12mb 的 parser 要等身分辨識之後、確認呼叫者有權使用帳單辨識才會跑（見下方
  // receiptBodyGate），匿名請求不能讓伺服器解析 12mb 的 JSON。
  const jsonDefault = express.json({ limit: '5mb' });
  app.use((req, res, next) => (RECEIPT_PATH_RE.test(req.path) ? next() : jsonDefault(req, res, next)));

  // 健康檢查：不經金鑰驗證，讓平台的 health probe 可以直接探測。
  // 外部服務（匯率、Gemini）壞掉不影響 ok——它們都有退路，服務本身仍然可用；
  // 只在 upstream 欄位標示 degraded，方便從監控看出來。
  // 🆕 [資料保護] 資料層有問題時回 503（ok:false）：資料庫讀不到，或正式環境的資料目錄沒有
  // 掛 Volume（資料會在下次部署時消失）。剩餘空間、最後一次備份只回報，不影響 ok，
  // 讓外部監控自己訂門檻。不回傳錯誤內容與路徑。
  app.get('/healthz', (req, res) => {
    const data = storage.health();
    const volumeRequired = process.env.NODE_ENV === 'production' && process.env.SPLITBILL_REQUIRE_VOLUME !== '0';
    const ok = data.db === 'ok' && !(volumeRequired && data.volume === 'not-mounted');
    res.status(ok ? 200 : 503).json({ ok, ...data, upstream: upstream.snapshot() });
  });

  // 提供前端靜態頁面（public/index.html），同源存取可避免 CORS 問題
  // index.html 裡的 css/js 網址會加上內容雜湊（?v=xxxx），每次部署只要檔案有改，
  // 網址就會變，手機瀏覽器或前面的 CDN 不會再拿舊的快取；index.html 本身一律不快取。
  const publicDir = path.join(__dirname, 'public');
  const versionedIndexHtml = buildVersionedIndexHtml(publicDir);
  app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(versionedIndexHtml);
  });
  // 帶 ?v=<雜湊> 的網址內容永遠不變，可以讓瀏覽器長期快取、不必每次回來驗證
  app.use(express.static(publicDir, {
    setHeaders(res) {
      if (res.req && res.req.query && res.req.query.v) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));

  // 🆕 [登出撤銷] 已登出的 session 記在資料庫（見 lib/session.js、storage.revokeSession）
  session.setRevocationStore({ isRevoked: storage.isSessionRevoked, revoke: storage.revokeSession });

  // ---- 🆕 [Discord 登入] OAuth 登入／登出（不在 /api 底下，瀏覽器直接導向） ----
  app.use('/auth', createOAuthRouter());

  // ---- 身分辨識：金鑰（Bot）／登入 cookie（網頁）；分享 token 只走網址路徑（細節見 lib/auth.js） ----
  app.use('/api', createIdentityMiddleware(apiKey));

  // ---- 帳單辨識的大型 body：只有登入者／Bot，或有效的可編輯分享連結才解析 ----
  const jsonReceipt = express.json({ limit: '12mb' });
  app.use((req, res, next) => {
    const m = RECEIPT_PATH_RE.exec(req.path);
    if (!m) return next();
    const token = m[1] ? decodeURIComponentSafe(m[1]) : null;
    let allowed = !!req.principal;
    if (token) {
      const found = storage.peekTripByLinkToken(token);
      allowed = !!found && !storage.isLinkExpired(found.link) && found.link.guest === 'write';
    }
    // 不允許時不解析 body，交給路由回應正確的錯誤（401／403／404）
    return allowed ? jsonReceipt(req, res, next) : next();
  });

  // ---- 🔒 /api/trip/... 一律需要身分：沒登入的請求在查行程之前就回 401，
  // 不會因為「行程存不存在」回 404／401 不同而洩漏行程 ID。用票券開 SSE 的例外。 ----
  app.use('/api/trip', (req, res, next) => {
    if (req.principal) return next();
    if (req.method === 'GET' && /\/events\/?$/.test(req.path) && typeof req.query.ticket === 'string') return next();
    res.status(401).json({ error: '請先登入', needLogin: true });
  });

  // ---- 🆕 [行程獨立化] 舊網址 /api/trip/:guildId/:tripId → /api/trip/:tripId ----
  app.use('/api', createLegacyTripPathRewrite(storage));

  // ---- 🆕 [即時同步] 掛上 SSE 廣播：任何一條寫入路徑呼叫 storage.touchTrip()
  // 時，都會自動推播給該行程目前所有開著的 SSE 連線（見 lib/sse.js）。
  const sseHub = createSseHub();
  attachTripEventBroadcast(storage, sseHub);

  // ---- 組裝共用的 ctx，各個 router 依需要挑選使用 ----
  const auth = createAuthHelpers({ storage });
  const ctx = {
    storage,
    ...auth,       // requireTripAccess, requireGuestLink, requireService, requireUser, canLinkMembers, ...
    ...sseHub,      // sseTickets, pruneSseTickets, SSE_TICKET_TTL_MS, openTripSseStream, broadcastReceiptSession, ...
    getFxRatesFor,
    genAI,
    recognizeReceipt,
    // 🆕 [多人協作] 帳單辨識認領進度的共享狀態（見 lib/receiptSessions.js），
    // 刻意跟 storage 分開、不落地寫進資料庫。
    getReceiptSession,
    setReceiptSession,
    clearReceiptSession,
  };

  app.use('/api', createSseRouter(ctx));
  app.use('/api', createTripsRouter(ctx));
  app.use('/api', createLinksRouter(ctx));
  app.use('/api', createSharedTripRouter(ctx));
  app.use('/api', createUtilityRouter(ctx));
  app.use('/api', createReceiptSessionRouter(ctx));
  app.use('/api', createGuildRouter(ctx));
  app.use('/api', createMeRouter(ctx));
  app.use('/api', createMembersRouter(ctx));
  app.use('/api', createAttachRouter(ctx));
  app.use('/api', createEntriesRouter(ctx));
  app.use('/api', createHistoryRouter(ctx));

  // ---- 統一的錯誤回應：路由裡丟出的例外（例如寫入資料庫失敗）都在這裡轉成
  // { error } JSON，路由不用各自包 try/catch。body 解析錯誤（JSON 格式錯、太大）
  // 沿用它本身的狀態碼。
  // eslint-disable-next-line no-unused-vars
  app.use('/api', (err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    // 路徑裡的分享連結 token 不進 log（redactPath）；帶上請求 id，和 [splitbill-http] 那一行對得起來
    if (status >= 500) console.error(`[splitbill-web] ${req.id} ${req.method} ${redactPath(req.originalUrl)} 失敗：`, err);
    if (res.headersSent) return res.end();
    // 🔒 非預期的例外（資料庫錯誤之類）不把內部訊息送給呼叫端；有明確狀態碼的錯誤
    // （body 解析錯誤、storage 的「請再試一次」）本身就是給使用者看的訊息
    const message = Number.isInteger(err.status) ? err.message : '伺服器發生錯誤，請稍後再試';
    res.status(status).json({ error: message });
  });

  // 啟動時就載入，不要等第一個請求進來。🆕 [SQLite] 第一次啟動會把舊的 splitbill.json
  // 匯入資料庫；資料庫或 JSON 讀不懂時這裡會丟例外，服務直接啟動失敗，不會用空資料上線。
  storage.loadAll();
  storage.startBackups();

  // 🆕 [SQLite] 正常結束時關閉資料庫（WAL 會在關閉時合併回主檔）。
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      try { storage.close(); } catch (err) { console.error('[splitbill-web] 關閉資料庫失敗：', err.message); }
      process.exit(0);
    });
  }

  app.listen(port, () => {
    console.log(`[splitbill-web] 網頁記帳介面已啟動： http://0.0.0.0:${port}`);
    if (!apiKey) {
      console.warn('[splitbill-web] ⚠️ 尚未設定 SPLITBILL_API_KEY：Bot 無法連線（網頁登入與分享連結不受影響）。');
    }
    if (!session.isEnabled() || !process.env.DISCORD_CLIENT_ID) {
      console.warn('[splitbill-web] ⚠️ 尚未設定 Discord 登入（DISCORD_CLIENT_ID／DISCORD_CLIENT_SECRET／PUBLIC_BASE_URL／SESSION_SECRET≥32 字元），網頁只能用分享連結或本機檔案。');
    }
  });
}

// 保留原本的對外匯出介面：startWebApi 以外，extractJsonObject / sanitizeReceiptResponse /
// getFxRatesFor 過去可能被其他檔案（例如測試）直接 require 使用，拆分後繼續原樣匯出。
module.exports = { startWebApi, extractJsonObject, sanitizeReceiptResponse, getFxRatesFor };

if (require.main === module) startWebApi();
