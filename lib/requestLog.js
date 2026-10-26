'use strict';
/**
 * 請求結果 log：每個請求一個短 id（回應標頭 X-Request-Id，和 music-library 的寫法相同），
 * 「值得留下紀錄」的結果記一行：
 *
 *   [splitbill-http] <id> <方法> <路徑> <狀態> <毫秒>ms <呼叫者>
 *
 * 記錄的狀態：403（沒權限）、409（版本衝突，多人同時編輯）、429（被限流）、503，以及所有 5xx 與超過 3 秒的慢請求。
 * 以前這些結果完全沒有紀錄：使用者回報「存不進去」時看不出是衝突、權限還是被限流。
 *
 * 隱私：路徑裡的分享連結 token 一律換成 :token，query string 不記；呼叫者只記種類（service／user／guest）
 * 與 Discord ID，不記名稱。SPLITBILL_LOG_REQUESTS=all 時每個請求都記（除錯用）。
 */
const crypto = require('crypto');

const LOGGED_STATUSES = new Set([403, 409, 429, 503]);
const SLOW_MS = 3000;
// 本來就會掛著的連線（SSE）不算慢請求
const LONG_RUNNING = /\/events\/?$/;

function redactPath(p) {
  return String(p || '')
    .split('?')[0]
    .replace(/\/(shared-trip|link|links)\/[^/]+/g, '/$1/:token')
    .slice(0, 200);
}

function describeCaller(req) {
  const p = req.principal;
  if (p && p.kind === 'service') return p.actorId ? `bot:${p.actorId}` : 'service';
  if (p && p.kind === 'user') return `user:${p.userId}`;
  return /\/(shared-trip|link)\//.test(req.originalUrl || '') ? 'guest' : 'anonymous';
}

function requestLog({ all = process.env.SPLITBILL_LOG_REQUESTS === 'all', log = console } = {}) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : crypto.randomBytes(4).toString('hex');
    res.setHeader('X-Request-Id', req.id);
    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      const status = res.statusCode;
      const path = redactPath(req.originalUrl);
      const slow = ms > SLOW_MS && !LONG_RUNNING.test(path);
      if (!all && !slow && status < 500 && !LOGGED_STATUSES.has(status)) return;
      const line = `[splitbill-http] ${req.id} ${req.method} ${path} ${status} ${ms}ms ${describeCaller(req)}${slow ? '（慢）' : ''}`;
      (status >= 500 ? log.error : status >= 400 || slow ? log.warn : log.log)(line);
    });
    next();
  };
}

module.exports = { requestLog, redactPath };
