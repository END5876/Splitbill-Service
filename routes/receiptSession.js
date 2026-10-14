'use strict';
const express = require('express');
const { sanitizeReceiptState } = require('../lib/validate');

// ════════════════════════════════════════════════════════════════
// 🆕 [多人協作] 帳單辨識認領進度的即時同步端點。
// 刻意沿用既有的「分享連結」權限模型：不另外產生新的協作連結，任何擁有
// 這個行程「可編輯」權限的人（成員／Bot，或 write 權限的分享連結持有者）
// 都可以讀取／更新目前進行中的認領狀態；唯讀連結持有者只能被動看見有人
// 在協作（前端會顯示提示），但無法加入操作。
//
// 資料本身完全不落地（見 lib/receiptSessions.js），也不夾帶進 trip 物件，
// 廣播管道直接重用既有的「這個行程的 SSE 訂閱者」（lib/sse.js 的
// tripSubscribers），不需要另外開一組 SSE 端點或另外換票。
//
// 同一組 GET／PUT／DELETE 掛在兩種路徑上，只差在「怎麼找到行程、怎麼驗證權限」：
//   /api/trip/:tripId/receipt-session         成員／Bot
//   /api/shared-trip/:token/receipt-session   分享連結訪客（token 本身就是憑證，需要 write 權限）
// ════════════════════════════════════════════════════════════════
module.exports = function createReceiptSessionRouter(ctx) {
  const {
    storage, requireTripAccess, requireGuestLink,
    getReceiptSession, setReceiptSession, clearReceiptSession, broadcastReceiptSession,
  } = ctx;
  const router = express.Router();

  // 只接受已知的兩種結束原因，其餘一律當成 null（前端會顯示語意含糊但仍
  // 安全的預設訊息），避免任意字串未經檢查就被塞進 SSE 廣播內容。
  const KNOWN_END_REASONS = new Set(['finalized', 'abandoned']);
  function sanitizeReceiptSessionEndReason(raw) {
    return KNOWN_END_REASONS.has(raw) ? raw : null;
  }

  // 找出行程並確認有可編輯權限；不通過時已經寫好錯誤回應，回傳 null。
  // isEnding：結束協作（DELETE）時，唯讀分享連結看到的錯誤訊息不同。
  function tripByTripId(req, res) {
    const trip = storage.getTrip(req.params.tripId);
    if (!trip) {
      res.status(404).json({ error: '找不到這個行程' });
      return null;
    }
    return requireTripAccess(req, res, trip, 'write') ? trip : null;
  }
  function tripByShareToken(req, res, isEnding) {
    const found = requireGuestLink(req, res, isEnding
      ? '此分享連結為唯讀，無法結束帳單辨識協作'
      : '此分享連結為唯讀，無法加入帳單辨識協作');
    return found && found.trip;
  }

  function mount(path, resolveTrip) {
    router.get(path, (req, res) => {
      const trip = resolveTrip(req, res, false);
      if (!trip) return;
      const entry = getReceiptSession(trip.id);
      res.json(entry ? { active: true, state: entry.state, updatedAt: entry.updatedAt } : { active: false });
    });

    router.put(path, (req, res) => {
      const trip = resolveTrip(req, res, false);
      if (!trip) return;
      const body = req.body || {};
      // 🔒 這份狀態會原樣廣播給同一個行程的其他人，只留下已知欄位（見 lib/validate.js）
      const state = sanitizeReceiptState(body.state);
      if (!state) {
        return res.status(400).json({ error: '缺少 state 資料' });
      }
      const writerId = typeof body.writerId === 'string' ? body.writerId.slice(0, 64) : null;
      const entry = setReceiptSession(trip.id, state, writerId);
      broadcastReceiptSession(trip.id, entry);
      res.json({ ok: true, updatedAt: entry.updatedAt, needImage: !entry.state.imageDataUrl });
    });

    router.delete(path, (req, res) => {
      const trip = resolveTrip(req, res, true);
      if (!trip) return;
      clearReceiptSession(trip.id);
      broadcastReceiptSession(trip.id, null, sanitizeReceiptSessionEndReason(req.query.reason));
      res.json({ ok: true });
    });
  }

  mount('/trip/:tripId/receipt-session', tripByTripId);
  mount('/shared-trip/:token/receipt-session', tripByShareToken);

  return router;
};
