'use strict';
const express = require('express');

// 🆕 [行程獨立化] 成員的 Discord 連結管理：解除連結。
// 認領成員（寫入 discordId）走行程連結，見 routes/links.js。
module.exports = function createMembersRouter(ctx) {
  const { storage, requireTripAccess, requireUser, userRoleInTrip, actorOf } = ctx;
  const router = express.Router();

  function loadTripOr404(req, res) {
    const trip = storage.getTrip(req.params.tripId);
    if (!trip) res.status(404).json({ error: '找不到這個行程' });
    return trip;
  }

  // ---- POST /api/trip/:tripId/members/:memberId/unlink：解除成員的 Discord 連結 ----
  // 建立者可以解除任何人；其他人只能解除自己。成員本身與帳目都保留，只是變回未連結。
  router.post('/trip/:tripId/members/:memberId/unlink', (req, res) => {
    const trip = loadTripOr404(req, res);
    if (!trip) return;
    if (!requireTripAccess(req, res, trip, 'member')) return;
    const uid = requireUser(req, res);
    if (!uid) return;

    const member = trip.members.find((m) => m.id === req.params.memberId);
    if (!member) return res.status(404).json({ error: '找不到這位成員' });
    if (!member.discordId) return res.json({ ok: true, trip: storage.toPublicTrip(trip) });

    const isOwner = userRoleInTrip(uid, trip) === 'owner';
    if (!isOwner && member.discordId !== uid) {
      return res.status(403).json({ error: '只有行程建立者可以解除其他成員的連結' });
    }
    delete member.discordId;
    storage.touchTrip(trip, { actor: actorOf(req) });
    storage.persist();
    res.json({ ok: true, trip: storage.toPublicTrip(trip) });
  });

  return router;
};
