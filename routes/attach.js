'use strict';
const express = require('express');
const crypto = require('crypto');
const { createRateLimiter } = require('../lib/rateLimit');

// ════════════════════════════════════════════════════════════════
// 🆕 [行程獨立化] 把網頁建立的行程綁到 Discord 伺服器（之後 Discord 面板就能操作）。
//
// 流程：建立者在網頁按「產生綁定碼」→ 到想綁定的伺服器輸入 /splitbill-attach code:<碼>
//       → Mousebot 帶著 x-actor-id 呼叫 POST /api/attach。
//
// 規則：
//   - 綁定碼只有建立者（或 OWNER_USER_ID）能產生，10 分鐘內有效、用一次就作廢，
//     一個行程同時只有一組有效的碼（重新產生會讓舊的作廢）
//   - 執行 /splitbill-attach 的人也必須是建立者（或 OWNER_USER_ID）：綁定碼只是
//     「指出要綁哪個行程」，不是權限本身——就算碼外流，別人也綁不走
//   - 一個行程只綁一個伺服器；已綁到別的伺服器時必須先在網頁解除綁定
//   - 執行者若還不是已連結的成員，自動加入為成員；並把這個行程設成他在該伺服器的作用行程
//   - 綁定碼只存在記憶體：服務重新啟動後全部作廢，重新產生即可
// ════════════════════════════════════════════════════════════════

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看錯的 0/O、1/I
const bindCodes = new Map(); // code -> { tripId, expiresAt }
const attachLimiter = createRateLimiter({ limit: 10, windowMs: 10 * 60 * 1000 });

function genCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

function prune() {
  const now = Date.now();
  for (const [code, v] of bindCodes) if (v.expiresAt < now) bindCodes.delete(code);
}

function normalizeCode(v) {
  return typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

module.exports = function createAttachRouter(ctx) {
  const { storage, requireTripAccess, userRoleInTrip } = ctx;
  const router = express.Router();

  // ---- POST /api/trip/:tripId/bind-code：產生綁定碼（建立者） ----
  router.post('/trip/:tripId/bind-code', (req, res) => {
    const trip = storage.getTrip(req.params.tripId);
    if (!trip) return res.status(404).json({ error: '找不到這個行程' });
    if (!requireTripAccess(req, res, trip, 'owner')) return;
    prune();
    for (const [code, v] of bindCodes) if (v.tripId === trip.id) bindCodes.delete(code);
    let code;
    do { code = genCode(); } while (bindCodes.has(code));
    const expiresAt = Date.now() + CODE_TTL_MS;
    bindCodes.set(code, { tripId: trip.id, expiresAt });
    res.json({ code, expiresAt, command: `/splitbill-attach code:${code}` });
  });

  // ---- POST /api/attach：用綁定碼把行程綁到伺服器（Bot 專用，必須宣告操作者） ----
  // body: { code, guildId, actorName? }
  router.post('/attach', (req, res) => {
    try {
      const p = req.principal;
      if (!p || p.kind !== 'service' || !p.actorId) {
        return res.status(403).json({ error: '綁定只能從 Discord 執行 /splitbill-attach' });
      }
      const actor = p.actorId;
      const r = attachLimiter.take(actor);
      if (!r.ok) return res.status(429).json({ error: '嘗試太多次了，請稍後再試' });

      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const guildId = body.guildId;
      if (!storage.isSnowflake(guildId)) return res.status(400).json({ error: '缺少或錯誤的 guildId' });

      prune();
      const code = normalizeCode(body.code);
      const entry = code ? bindCodes.get(code) : null;
      if (!entry) return res.status(404).json({ error: '綁定碼錯誤或已過期，請回到網頁重新產生一組' });

      const trip = storage.getTrip(entry.tripId);
      if (!trip) {
        bindCodes.delete(code);
        return res.status(404).json({ error: '這個行程已經被刪除了' });
      }
      if (userRoleInTrip(actor, trip) !== 'owner') {
        return res.status(403).json({ error: '只有行程建立者可以把行程綁定到伺服器' });
      }
      if (trip.guildId && trip.guildId !== guildId) {
        return res.status(409).json({ error: '這個行程已經綁定在另一個伺服器，請先到網頁解除綁定' });
      }

      bindCodes.delete(code);
      const alreadyHere = trip.guildId === guildId;
      if (!alreadyHere) storage.attachTripToGuild(trip, guildId);

      let joined = false;
      if (!trip.members.some((m) => m.discordId === actor)) {
        const name = typeof body.actorName === 'string' && body.actorName.trim() ? body.actorName.trim().slice(0, 60) : '成員';
        trip.members.push({ id: storage.genId('mem'), name, discordId: actor });
        joined = true;
      }
      storage.ensureGuildState(guildId).activeTripByUser[actor] = trip.id;

      if (!alreadyHere || joined) storage.touchTrip(trip);
      storage.persist();
      res.json({ ok: true, alreadyAttached: alreadyHere, joined, trip: storage.toPublicTrip(trip) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- POST /api/trip/:tripId/detach：解除綁定（建立者） ----
  router.post('/trip/:tripId/detach', (req, res) => {
    try {
      const trip = storage.getTrip(req.params.tripId);
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      if (!requireTripAccess(req, res, trip, 'owner')) return;
      if (trip.guildId) {
        storage.detachTripFromGuild(trip);
        storage.touchTrip(trip);
        storage.persist();
      }
      res.json({ ok: true, trip: storage.toPublicTrip(trip) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
