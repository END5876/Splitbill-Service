'use strict';
// ════════════════════════════════════════════════════════════════
// 🆕 [即時同步] SSE（Server-Sent Events）：讓多個同時開著這個行程的分頁
// （包含 webui 彼此之間、以及 webui 與 Discord 面板之間）在資料被任一方
// 改動時互相即時同步，不用手動重新整理才會看到別人剛存的東西。
//
// 設計重點：
// - 廣播來源統一掛在 storage.tripEvents（見 storage.js 的 touchTrip()），
//   涵蓋所有寫入路徑，不用在每個 API 端點各自補播送邏輯。
// - 瀏覽器原生 EventSource 不支援自訂 header。用 Discord 登入的網頁直接
//   帶 cookie 即可；用 x-api-key header 帶金鑰的呼叫端（Bot／維運腳本）則改用「短效、一次性
//   票券」：先用一般帶 header 的請求換票（POST /api/sse-ticket），再用票券
//   建立 SSE 連線，避免把長效的金鑰直接放進連線網址、留在伺服器存取紀錄裡。
// - 分享連結路由（見 routes/sse.js 的 /api/shared-trip/:token/events）
//   沿用既有設計：token 本身就是寫在路徑上的憑證，不需要額外換票。
//
// 本檔案只負責「訂閱表 + 換票 + 開串流 + 廣播」這幾個底層機制，實際的
// HTTP 路由定義在 routes/sse.js。
// ════════════════════════════════════════════════════════════════

const sseTickets = new Map(); // ticket -> { principal, expiresAt }
const SSE_TICKET_TTL_MS = 30 * 1000; // 換票後 30 秒內沒拿去開 SSE 連線就作廢
const MAX_SSE_TICKETS = 10000;       // 未使用票券的上限，避免被大量換票塞爆記憶體
const MAX_SUBSCRIBERS_PER_TRIP = 50; // 同一個行程同時開著的 SSE 連線上限
const KEEPALIVE_MS = 25000;

function pruneSseTickets() {
  const now = Date.now();
  for (const [ticket, entry] of sseTickets) {
    if (entry.expiresAt < now) sseTickets.delete(ticket);
  }
}

// tripId -> Set<express.Response>，每個 res 都是一條保持開啟中的 SSE 連線。
// 🔒 每條連線另外掛著 res.sbCanRead()（開連線當下的身分「現在」還能不能讀這個行程）
// 與 res.sbAudience（'member' | 'guest'，決定送出的行程要不要拿掉 Discord ID）。
const tripSubscribers = new Map();

function addTripSubscriber(tripId, res) {
  if (!tripSubscribers.has(tripId)) tripSubscribers.set(tripId, new Set());
  tripSubscribers.get(tripId).add(res);
}
function removeTripSubscriber(tripId, res) {
  const set = tripSubscribers.get(tripId);
  if (!set) return;
  set.delete(res);
  if (!set.size) tripSubscribers.delete(tripId);
}

/**
 * 🔒 權限已經失效（連結被撤銷／過期／改成不開放訪客、成員被移除或解除連結、已登出）：
 * 通知前端一聲後關閉連線。權限只在開連線時檢查一次的話，這些人只要不關分頁，
 * 就會一直收到之後的所有帳目。
 */
function revokeSubscriber(tripId, res) {
  removeTripSubscriber(tripId, res);
  if (!beginEndStream(res)) return;
  try {
    res.write('event: access-revoked\ndata: {}\n\n');
    res.end();
  } catch (_) { /* 連線已經斷了 */ }
}

// 🐛 [寫入已結束的串流] res.end() 之後，對方不讀資料（分頁進背景、網路卡住）時 'close'
// 會一直等不到，心跳計時器就還活著；下一次心跳再 write() 會非同步噴出
// ERR_STREAM_WRITE_AFTER_END，沒人接住就讓整個服務掛掉。所以結束串流前一律先停掉心跳。
function streamClosed(res) {
  return !!(res.writableEnded || res.destroyed);
}
/** 停掉這條連線的心跳；回傳 false＝這條串流早就結束了，不能再寫。 */
function beginEndStream(res) {
  if (res.sbKeepAlive) { clearInterval(res.sbKeepAlive); res.sbKeepAlive = null; }
  return !streamClosed(res);
}

function stillAllowed(res) {
  try {
    return !res.sbCanRead || !!res.sbCanRead();
  } catch (_) {
    return false;
  }
}

/**
 * 把一則事件送給某行程的所有訂閱者；每一條連線送出前都重新檢查權限。
 * @param {(audience: 'member'|'guest') => string} payloadFor 依對象產生事件內容（同一種對象只算一次）
 */
function deliver(tripId, payloadFor) {
  const subscribers = tripSubscribers.get(tripId);
  if (!subscribers || !subscribers.size) return;
  const cache = new Map();
  for (const res of [...subscribers]) {
    if (streamClosed(res)) { beginEndStream(res); removeTripSubscriber(tripId, res); continue; }
    if (!stillAllowed(res)) { revokeSubscriber(tripId, res); continue; }
    const audience = res.sbAudience || 'member';
    if (!cache.has(audience)) cache.set(audience, payloadFor(audience));
    res.write(cache.get(audience));
  }
}

/**
 * 開啟一條 SSE 串流並掛進訂閱表。連線本身不主動關閉，靠使用者關閉分頁／
 * 網路中斷觸發 res 的 'close' 事件時清理；期間定期送出註解行當心跳，
 * 避免部分反向代理或 PaaS 因為連線閒置太久而主動斷開。心跳時也會重新檢查權限，
 * 連結過期這種「沒有任何寫入」的權限變化最晚一個心跳週期內就會斷線。
 * @param {{ canRead?: () => boolean, audience?: 'member'|'guest' }} [opts]
 * @returns {boolean} false＝這個行程的連線數已達上限（已經回 429）
 */
function openTripSseStream(res, tripId, opts = {}) {
  const current = tripSubscribers.get(tripId);
  if (current && current.size >= MAX_SUBSCRIBERS_PER_TRIP) {
    res.status(429).json({ error: '這個行程同時開著的頁面太多了，請關掉一些分頁再試' });
    return false;
  }
  res.sbCanRead = opts.canRead || null;
  res.sbAudience = opts.audience || 'member';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 避免 nginx 等反向代理把 SSE 資料流緩衝住不即時送出
  });
  res.write('event: connected\ndata: {}\n\n');

  addTripSubscriber(tripId, res);

  const keepAlive = setInterval(() => {
    if (streamClosed(res)) { beginEndStream(res); return; }
    if (!stillAllowed(res)) {
      revokeSubscriber(tripId, res); // 裡面會一併停掉這個心跳
      return;
    }
    res.write(': ping\n\n');
  }, KEEPALIVE_MS);
  if (typeof keepAlive.unref === 'function') keepAlive.unref();
  res.sbKeepAlive = keepAlive;

  // 🐛 [寫入已結束的串流] 萬一還有漏網的寫入錯誤，也只影響這條連線，不要變成 uncaughtException
  res.on('error', () => {});
  res.on('close', () => {
    beginEndStream(res);
    removeTripSubscriber(tripId, res);
  });
  return true;
}

// 🆕 [多人協作] 廣播「帳單辨識認領進度」有更新／已結束，直接重用既有的
// tripSubscribers 訂閱表——不管是擁有者的 SSE 連線，還是分享連結持有者
// 的 SSE 連線，本來就已經依 tripId 訂閱在這裡，不需要另外開一組端點或
// 另外換票。entry 為 null 時代表協作已結束（帳單已建立成支出，或被取消）。
function broadcastReceiptSession(tripId, entry, reason) {
  // 照片沒變就不夾帶（前端沿用手上那張），省下每次認領都把整張照片推給每個人
  let state = entry && entry.state;
  if (state && !entry.imageChanged && state.imageDataUrl !== undefined) {
    const { imageDataUrl, ...rest } = state; // eslint-disable-line no-unused-vars
    state = rest;
  }
  const payload = entry
    ? `event: receipt-session-updated\ndata: ${JSON.stringify({
        state,
        updatedAt: entry.updatedAt,
        writerId: entry.writerId,
      })}\n\n`
    // 🆕 [結束/放棄] reason 讓收到通知的其他協作者知道這場協作「為什麼」結束——
    // 是有人按下建立支出了（finalized），還是有人主動按下「結束（放棄）」
    // 中止了（abandoned）——而不是只看到一句語意含糊的「協作已結束」。
    : `event: receipt-session-cleared\ndata: ${JSON.stringify({ reason: reason || null })}\n\n`;
  deliver(tripId, () => payload);
}

/** 換一張 SSE 票券；未使用的票券太多時回傳 null。 */
function issueSseTicket(ticket, principal) {
  pruneSseTickets();
  if (sseTickets.size >= MAX_SSE_TICKETS) return null;
  const entry = { principal, expiresAt: Date.now() + SSE_TICKET_TTL_MS };
  sseTickets.set(ticket, entry);
  return entry;
}

function createSseHub() {
  return {
    sseTickets,
    pruneSseTickets,
    issueSseTicket,
    SSE_TICKET_TTL_MS,
    tripSubscribers,
    addTripSubscriber,
    removeTripSubscriber,
    openTripSseStream,
    broadcastReceiptSession,
  };
}

// 訂閱 storage 層的變更事件：不管是 webui 存檔，還是 Discord 面板操作，
// 只要呼叫過 storage.touchTrip()，這裡就會收到通知並廣播給該行程目前
// 所有開著的 SSE 連線（訪客收到的版本不含 Discord ID，見 storage.toGuestTrip）。
function attachTripEventBroadcast(storage, hub) {
  storage.tripEvents.on('trip-updated', (tripId, meta) => {
    const subscribers = hub.tripSubscribers.get(tripId);
    if (!subscribers || !subscribers.size) return; // 沒有人在看這個行程，省下組資料的成本

    const trip = storage.peekTrip(tripId);
    if (!trip) return; // 理論上不會發生（剛觸發過 touchTrip 代表行程存在），防呆用

    // 🆕 [即時同步] 用 envelope 包一層，除了行程本身還夾帶 writerId：
    // 讓寫入者本人的分頁可以精準比對「這筆是不是我自己剛存的」，不用靠比較
    // updatedAt 的時間先後（那個做法在 SSE 推播跟 PUT 回應是兩條獨立連線的
    // 情況下會有競速問題，見 storage.js 的 touchTrip() 說明）。
    const writerId = (meta && meta.writerId) || null;
    deliver(tripId, (audience) => {
      const envelope = { trip: audience === 'guest' ? storage.toGuestTrip(trip) : storage.toPublicTrip(trip), writerId };
      return `event: trip-updated\ndata: ${JSON.stringify(envelope)}\n\n`;
    });
  });

  // 🆕 [即時同步] 行程被刪除時：通知所有訂閱者一聲，然後直接把連線關掉——
  // 這個行程已經不存在了，之後也不會再有任何 'trip-updated' 事件可以推播，
  // 繼續留著連線沒有意義，不如讓伺服器跟前端都能立刻釋放資源。
  storage.tripEvents.on('trip-deleted', (tripId) => {
    const subscribers = hub.tripSubscribers.get(tripId);
    if (!subscribers || !subscribers.size) return;

    const payload = 'event: trip-deleted\ndata: {}\n\n';
    for (const res of subscribers) {
      if (!beginEndStream(res)) continue;
      try {
        res.write(payload);
        res.end();
      } catch (_) { /* 連線已經斷了 */ }
    }
    hub.tripSubscribers.delete(tripId);
  });

  // 連結被撤銷／修改這類不會 touchTrip() 的權限變化：立刻重新檢查這個行程的所有連線
  storage.tripEvents.on('trip-access-changed', (tripId) => {
    const subscribers = hub.tripSubscribers.get(tripId);
    if (!subscribers) return;
    for (const res of [...subscribers]) if (!stillAllowed(res)) revokeSubscriber(tripId, res);
  });
}

module.exports = { createSseHub, attachTripEventBroadcast };
