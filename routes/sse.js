'use strict';
const express = require('express');
const crypto = require('crypto');
const session = require('../lib/session');

// SSE 換票與事件串流端點。底層的訂閱表/廣播機制在 lib/sse.js。
// 🔒 每條連線都帶著一個「現在還能不能讀」的檢查（canRead），lib/sse.js 每次送資料前與
// 每次心跳都會重新呼叫：連結被撤銷／過期、成員被移除、已登出時，連線會被關掉。
module.exports = function createSseRouter(ctx) {
  const {
    storage, requireTripAccess, requireGuestLink, hasTripAccess,
    sseTickets, pruneSseTickets, issueSseTicket, SSE_TICKET_TTL_MS, openTripSseStream,
  } = ctx;
  const router = express.Router();

  // ════════════════════════════════════════════════════════════════
  // 🆕 [即時同步] POST /api/sse-ticket：用 header 帶的金鑰（Bot／維運腳本）換取一張短效、一次性的
  // 票券，再拿這張票券去開啟下面的 SSE 連線。分享連結不需要呼叫這個
  // 端點——它的 SSE 連線直接用網址上的 token 當憑證即可。
  // 🔒 只開放給金鑰：網頁登入者直接用 cookie 開 SSE，不需要票券。票券表是全站共用的
  // （上限 MAX_SSE_TICKETS），開放給任何 Discord 帳號的話，一個人就能把它換光。
  // ════════════════════════════════════════════════════════════════
  router.post('/sse-ticket', (req, res) => {
    if (!req.principal) return res.status(401).json({ error: '請先登入', needLogin: true });
    if (req.principal.kind !== 'service') {
      return res.status(403).json({ error: '網頁請直接用登入的 cookie 開啟即時同步，不需要票券' });
    }
    const ticket = crypto.randomBytes(24).toString('hex');
    // 換票當下的身分；開串流時用同一個身分判斷權限
    if (!issueSseTicket(ticket, req.principal)) {
      return res.status(503).json({ error: '伺服器忙碌中，請稍後再試' });
    }
    res.json({ ticket, expiresInMs: SSE_TICKET_TTL_MS });
  });

  // ---- GET /api/trip/:tripId/events：SSE，這個行程被任何人改動時即時推播 ----
  router.get('/trip/:tripId/events', (req, res) => {
    // 🆕 [Discord 登入] 用 cookie 登入的網頁不需要換票：瀏覽器的 EventSource
    // 對同源網址會自動帶上 cookie，req.principal 已經由 lib/auth.js 辨認好。
    // 用 header 帶金鑰的呼叫端（EventSource 帶不了 header）才需要票券。
    // 🔒 先驗票券再查行程：無效票券不論行程存不存在都回 401，不洩漏行程 ID
    let authCtx = req;
    const ticketId = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    if (ticketId) {
      pruneSseTickets();
      const ticket = sseTickets.get(ticketId);
      if (!ticket || ticket.expiresAt < Date.now()) {
        return res.status(401).json({ error: '缺少或已過期的連線憑證，請重新整理頁面再試一次。' });
      }
      sseTickets.delete(ticketId); // 單次使用，用過即棄
      authCtx = ticket;
    }

    const trip = storage.getTrip(req.params.tripId);
    if (!trip) return res.status(404).json({ error: '找不到這個行程' });

    if (!requireTripAccess(authCtx, res, trip, 'read')) return;

    const tripId = trip.id;
    const principal = authCtx.principal;
    openTripSseStream(res, tripId, {
      audience: 'member',
      canRead: () => {
        if (principal && principal.sid && session.isSessionRevoked(principal.sid)) return false;
        const current = storage.peekTrip(tripId);
        return !!current && hasTripAccess({ principal }, current, 'read');
      },
    });
  });

  // ---- GET /api/shared-trip/:token/events：SSE，分享連結版本 ----
  router.get('/shared-trip/:token/events', (req, res) => {
    const found = requireGuestLink(req, res);
    if (!found) return;
    const token = req.params.token;
    const tripId = found.trip.id;
    openTripSseStream(res, tripId, {
      audience: 'guest',
      canRead: () => {
        const f = storage.peekTripByLinkToken(token);
        return !!f && f.trip.id === tripId && !storage.isLinkExpired(f.link) && f.link.guest !== 'none';
      },
    });
  });

  return router;
};
