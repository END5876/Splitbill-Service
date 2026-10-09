'use strict';
const express = require('express');
const { createRateLimiter } = require('../lib/rateLimit');

// ════════════════════════════════════════════════════════════════
// 🆕 [行程獨立化] 成員邀請與認領：讓網頁上建立的成員（mem_xxxx）連結到本人的
// Discord 帳號。這是網頁上「唯一」能替成員寫入 discordId 的路徑——一般 PUT
// 一律不接受（見 lib/members.js）。
//
// 流程：成員把邀請連結傳給朋友 → 朋友用 Discord 登入 → 從「尚未連結」的成員裡
// 選「我是 X」（或以新成員身分加入）→ 該成員的 discordId 寫入朋友的 Discord ID。
// 成員的 id 不變，所有支出／轉帳紀錄都不用改。
//
// 規則：
//   - 邀請 token 一個行程一組，任何成員都能取得；建立者可以重新產生（舊連結作廢）
//   - 只能認領「尚未連結」的成員，已連結的成員永遠不能被別人搶走
//   - 同一個 Discord 帳號在一個行程裡只能連結一位成員
//   - 認錯人時，建立者可以解除任何成員的連結；本人也可以解除自己的連結
// ════════════════════════════════════════════════════════════════

const claimLimiter = createRateLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });

module.exports = function createMembersRouter(ctx) {
  const { storage, requireTripAccess, requireUser, principalUserId, userRoleInTrip } = ctx;
  const router = express.Router();

  function loadTripOr404(req, res) {
    const trip = storage.getTrip(req.params.tripId);
    if (!trip) res.status(404).json({ error: '找不到這個行程' });
    return trip;
  }

  function ensureInvite(trip) {
    if (!trip.invite) {
      trip.invite = { token: storage.genShareToken(), createdAt: Date.now() };
      storage.persist(); // 邀請 token 不是行程內容，不 touchTrip、不觸發 SSE／版本衝突
    }
    return trip.invite;
  }

  // ---- GET /api/trip/:tripId/invite：取得邀請連結的 token（成員以上） ----
  router.get('/trip/:tripId/invite', (req, res) => {
    const trip = loadTripOr404(req, res);
    if (!trip) return;
    if (!requireTripAccess(req, res, trip, 'member')) return;
    res.json({ token: ensureInvite(trip).token });
  });

  // ---- POST /api/trip/:tripId/invite/rotate：重新產生邀請連結（建立者） ----
  router.post('/trip/:tripId/invite/rotate', (req, res) => {
    const trip = loadTripOr404(req, res);
    if (!trip) return;
    if (!requireTripAccess(req, res, trip, 'owner')) return;
    trip.invite = { token: storage.genShareToken(), createdAt: Date.now() };
    storage.persist();
    res.json({ token: trip.invite.token });
  });

  // ---- GET /api/invite/:token：邀請頁面要顯示的資訊（不需要登入） ----
  // 只回傳行程名稱與成員名字／是否已連結，不含任何帳目或 Discord ID。
  router.get('/invite/:token', (req, res) => {
    const trip = storage.findTripByInviteToken(req.params.token);
    if (!trip) return res.status(404).json({ error: '這個邀請連結不存在或已經失效，請跟行程成員索取新的連結' });
    const uid = principalUserId(req.principal);
    const mine = uid ? trip.members.find((m) => m.discordId === uid) : null;
    res.json({
      tripId: trip.id,
      tripName: trip.name,
      members: trip.members.map((m) => ({ id: m.id, name: m.name, linked: !!m.discordId })),
      viewer: uid ? { userId: uid, memberId: mine ? mine.id : null } : null,
    });
  });

  // ---- POST /api/invite/:token/claim：認領成員（需要 Discord 登入） ----
  // body: { memberId }        認領一位尚未連結的成員
  //    或 { newMemberName }   以新成員身分加入
  router.post('/invite/:token/claim', (req, res) => {
    try {
      if (!req.principal || req.principal.kind !== 'user') {
        return res.status(401).json({ error: '請先用 Discord 登入', needLogin: true });
      }
      const uid = req.principal.userId;
      const r = claimLimiter.take(uid);
      if (!r.ok) return res.status(429).json({ error: '操作太頻繁了，請稍後再試' });

      const trip = storage.findTripByInviteToken(req.params.token);
      if (!trip) return res.status(404).json({ error: '這個邀請連結不存在或已經失效，請跟行程成員索取新的連結' });

      const already = trip.members.find((m) => m.discordId === uid);
      if (already) {
        return res.status(409).json({ error: `你已經是這個行程的「${already.name}」了`, tripId: trip.id, memberId: already.id });
      }

      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      let member;
      if (typeof body.memberId === 'string' && body.memberId) {
        member = trip.members.find((m) => m.id === body.memberId);
        if (!member) return res.status(404).json({ error: '找不到這位成員，可能已經被移除' });
        if (member.discordId) return res.status(409).json({ error: `「${member.name}」已經被其他 Discord 帳號連結了` });
        member.discordId = uid;
      } else {
        const name = typeof body.newMemberName === 'string' ? body.newMemberName.trim().slice(0, 60) : '';
        if (!name) return res.status(400).json({ error: '請選擇你是哪一位，或輸入新成員的名字' });
        if (trip.members.length >= 100) return res.status(400).json({ error: '這個行程的成員已達上限' });
        member = { id: storage.genId('mem'), name, discordId: uid };
        trip.members.push(member);
      }

      storage.touchTrip(trip);
      storage.persist();
      res.json({ ok: true, tripId: trip.id, memberId: member.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- POST /api/trip/:tripId/members/:memberId/unlink：解除成員的 Discord 連結 ----
  // 建立者可以解除任何人；其他人只能解除自己。成員本身與帳目都保留，只是變回未連結。
  router.post('/trip/:tripId/members/:memberId/unlink', (req, res) => {
    try {
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
      storage.touchTrip(trip);
      storage.persist();
      res.json({ ok: true, trip: storage.toPublicTrip(trip) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
