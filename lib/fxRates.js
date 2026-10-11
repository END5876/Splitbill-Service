'use strict';
/**
 * 即時匯率：免費、不用金鑰的 open.er-api.com，伺服器端記憶體快取。
 * 從 webui/server.js 抽出，供 routes/utility.js 使用。
 *
 * 同一個來源幣別 6 小時內重複查詢不會再打外部 API；即時匯率抓不到時，
 * 呼叫端（routes/utility.js 的 /api/fx-rate、webui/public/js 前端）會自動
 * 退回使用行程裡手動設定的匯率，不會擋住記帳。
 */

const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小時；這個 API 本身也是一天更新一次，不用查太頻繁
const FX_FETCH_TIMEOUT_MS = 8000; // 外部服務卡住時不要讓請求一直掛著
const fxCache = new Map(); // baseCurrency -> { rates, fetchedAt, asOf }
const inFlight = new Map(); // baseCurrency -> Promise：同一個幣別同時只打一次外部 API

async function fetchFxRates(base) {
  const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, {
    signal: AbortSignal.timeout(FX_FETCH_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.result !== 'success') {
    throw new Error((data && data['error-type']) || `匯率服務回應異常 (HTTP ${res.status})`);
  }
  const entry = { rates: data.rates, fetchedAt: Date.now(), asOf: data.time_last_update_utc || null };
  fxCache.set(base, entry);
  return entry;
}

async function getFxRatesFor(base) {
  const cached = fxCache.get(base);
  if (cached && (Date.now() - cached.fetchedAt) < FX_CACHE_TTL_MS) return cached;
  if (!inFlight.has(base)) {
    inFlight.set(base, fetchFxRates(base).finally(() => inFlight.delete(base)));
  }
  return inFlight.get(base);
}

module.exports = { getFxRatesFor, FX_CACHE_TTL_MS };
