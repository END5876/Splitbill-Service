'use strict';
/**
 * 即時匯率：免費、不用金鑰的 open.er-api.com，伺服器端記憶體快取。
 * 從 webui/server.js 抽出，供 routes/utility.js 使用。
 *
 * 同一個來源幣別 6 小時內重複查詢不會再打外部 API。
 *
 * 外部服務掛掉時：手上有 7 天內抓過的舊匯率就先用它（回傳 stale: true，
 * /api/fx-rate 會照樣帶出 stale 與 asOf，呼叫端可以標示「可能過時」），
 * 連舊的都沒有才丟錯，由呼叫端（routes/utility.js、前端）退回使用行程裡手動設定的匯率，
 * 不會擋住記帳。用舊匯率期間每 5 分鐘最多再試一次外部服務，恢復後自動換回新匯率。
 */

const upstream = require('./upstreamStatus');

upstream.register('fx');

const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小時；這個 API 本身也是一天更新一次，不用查太頻繁
const FX_FETCH_TIMEOUT_MS = 8000; // 外部服務卡住時不要讓請求一直掛著
const FX_STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000; // 外部服務掛掉時，最舊可以沿用多久前抓到的匯率
const FX_RETRY_AFTER_FAIL_MS = 5 * 60 * 1000;     // 改用舊匯率後，多久再試一次外部服務
const fxCache = new Map(); // baseCurrency -> { rates, fetchedAt, asOf }
const inFlight = new Map(); // baseCurrency -> Promise：同一個幣別同時只打一次外部 API

async function fetchFxRates(base) {
  let data;
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, {
      signal: AbortSignal.timeout(FX_FETCH_TIMEOUT_MS),
    });
    data = await res.json().catch(() => null);
    if (!res.ok || !data || data.result !== 'success') {
      throw new Error((data && data['error-type']) || `匯率服務回應異常 (HTTP ${res.status})`);
    }
  } catch (err) {
    // 不認得的幣別是使用者輸入的問題，不算匯率服務故障
    if (!(data && data['error-type'] === 'unsupported-code')) upstream.recordFailure('fx', err);
    throw err;
  }
  upstream.recordSuccess('fx');
  const entry = { rates: data.rates, fetchedAt: Date.now(), asOf: data.time_last_update_utc || null, stale: false };
  fxCache.set(base, entry);
  return entry;
}

// 外部服務失敗時：7 天內的舊匯率先頂著用（不認得的幣別照樣丟錯——那是輸入問題，舊資料也沒有答案）
async function fetchOrStale(base) {
  try {
    return await fetchFxRates(base);
  } catch (err) {
    const old = fxCache.get(base);
    const unsupported = err && err.message === 'unsupported-code';
    if (!unsupported && old && Date.now() - old.fetchedAt < FX_STALE_MAX_MS) {
      old.stale = true;
      old.retryAt = Date.now() + FX_RETRY_AFTER_FAIL_MS;
      console.warn(`[splitbill-fx] 即時匯率服務失敗（${err.message}），${base} 暫時沿用 ${new Date(old.fetchedAt).toISOString()} 的匯率`);
      return old;
    }
    throw err;
  }
}

async function getFxRatesFor(base) {
  const cached = fxCache.get(base);
  const now = Date.now();
  if (cached && !cached.stale && (now - cached.fetchedAt) < FX_CACHE_TTL_MS) return cached;
  if (cached && cached.stale && now < cached.retryAt) return cached;
  if (!inFlight.has(base)) {
    inFlight.set(base, fetchOrStale(base).finally(() => inFlight.delete(base)));
  }
  return inFlight.get(base);
}

module.exports = { getFxRatesFor, FX_CACHE_TTL_MS, FX_STALE_MAX_MS, _cache: fxCache };
