'use strict';
/**
 * 外部服務（匯率 API、Gemini 帳單辨識）最近一次呼叫的成功／失敗紀錄，給 /healthz 回報用。
 * 這兩個服務壞掉時網頁都有退路（手動匯率、手動記帳），使用者不一定會回報，
 * 所以至少要能從健康檢查一眼看出「上次成功是什麼時候、連續失敗了幾次」。
 * 只存在記憶體，重新啟動就歸零。
 */
const status = new Map(); // name -> { lastSuccessAt, lastFailureAt, consecutiveFailures }

function entry(name) {
  if (!status.has(name)) status.set(name, { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 });
  return status.get(name);
}

function recordSuccess(name) {
  const e = entry(name);
  e.lastSuccessAt = Date.now();
  e.consecutiveFailures = 0;
}

function recordFailure(name, err) {
  const e = entry(name);
  e.lastFailureAt = Date.now();
  e.consecutiveFailures += 1;
  console.warn(`[splitbill-upstream] ${name} 呼叫失敗（連續 ${e.consecutiveFailures} 次）：${err && err.message ? err.message : err}`);
}

/**
 * 給 /healthz 的摘要：state 是 'ok'（最近一次成功）、'degraded'（最近一次失敗）、
 * 'unknown'（啟動後還沒呼叫過）。刻意不帶錯誤訊息：/healthz 不需要登入。
 */
function snapshot() {
  const out = {};
  for (const [name, e] of status) {
    out[name] = {
      state: e.consecutiveFailures > 0 ? 'degraded' : (e.lastSuccessAt ? 'ok' : 'unknown'),
      lastSuccessAt: e.lastSuccessAt,
      lastFailureAt: e.lastFailureAt,
      consecutiveFailures: e.consecutiveFailures,
    };
  }
  return out;
}

/** 讓尚未呼叫過的服務也出現在 snapshot 裡（state: 'unknown'）。 */
function register(name) {
  entry(name);
}

module.exports = { recordSuccess, recordFailure, snapshot, register };
