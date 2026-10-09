'use strict';
/**
 * 簡單的記憶體內滑動視窗限流：每個 key 在 windowMs 內最多 limit 次。
 * 用在「任何登入者都能觸發、但會耗用資源」的動作（建立行程、帳單辨識）。
 * 重新啟動會歸零，這是可以接受的——目的只是擋住連點或腳本灌爆，不是計費。
 */
function createRateLimiter({ limit, windowMs }) {
  const hits = new Map(); // key -> number[]（時間戳）

  function take(key) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= limit) {
      hits.set(key, list);
      return { ok: false, retryAfterMs: windowMs - (now - list[0]) };
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
    }
    return { ok: true };
  }

  return { take };
}

module.exports = { createRateLimiter };
