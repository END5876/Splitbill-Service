'use strict';
const express = require('express');
const { createRateLimiter } = require('../lib/rateLimit');

// ════════════════════════════════════════════════════════════════
// 🆕 [行程連結] 分享連結與成員邀請連結合併成同一種「行程連結」（trip.links）。
// 每條連結有兩個獨立的開關：
//   guest  不登入直接打開時的權限：'none'（不開放）| 'read' | 'write'
//   join   用 Discord 登入後可以認領成員／以新成員加入
//
// 端點：
//   擁有者    GET/POST /trip/:tripId/links、PATCH/DELETE /trip/:tripId/links/:token
//   成員      GET /trip/:tripId/invite      取得（必要時建立）預設的邀請連結
//   任何人    GET /link/:token              解析連結：行程名稱、開放哪些用法、我是不是成員
//            POST /link/:token/claim       認領成員（需要 Discord 登入、連結允許 join）
// 訪客實際讀寫行程走 /shared-trip/:token/...（見 routes/sharedTrip.js、lib/auth.js 的 requireGuestLink）。
//
// 認領規則：
//   - 這是網頁上「唯一」能替成員寫入 discordId 的路徑——一般 PUT 一律不接受（見 lib/members.js）
//   - 只能認領「尚未連結」的成員，已連結的成員永遠不能被別人搶走
//   - 同一個 Discord 帳號在一個行程裡只能連結一位成員
//   - 認錯人時，建立者可以解除任何成員的連結；本人也可以解除自己的連結（routes/members.js）
//
// 連結的管理權本身不能被分享出去：只有建立者能建立／修改／撤銷連結，否則拿到
// 可編輯連結的人就能再幫自己開一把新的連結，權限無限擴散。成員只能取得
// 「只能加入、不開放訪客」的預設邀請連結，這跟他們本來就能做的事等價。
// ════════════════════════════════════════════════════════════════

const claimLimiter = createRateLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });
const GUEST_LEVELS = new Set(['none', 'read', 'write']);
const DAY_MS = 24 * 60 * 60 * 1000;

module.exports = function createLinksRouter(ctx) {
  const { storage, requireTripAccess, principalUserId, userRoleInTrip, actorOf } = ctx;
  const router = express.Router();

  function loadTripOr404(req, res) {
    const trip = storage.getTrip(req.params.tripId);
    if (!trip) res.status(404).json({ error: '找不到這個行程' });
    return trip;
  }

  /** 合併 body 與現有值後檢查權限組合；不合法時回傳錯誤訊息字串。 */
  function parseAccess(body, base) {
    const guest = body.guest === undefined ? base.guest : body.guest;
    const join = body.join === undefined ? base.join : body.join;
    if (!GUEST_LEVELS.has(guest)) return 'guest 必須是 "none"、"read" 或 "write"';
    if (typeof join !== 'boolean') return 'join 必須是 true 或 false';
    if (guest === 'none' && !join) return '連結至少要開放訪客存取，或允許登入加入其中一項';
    return { guest, join };
  }

  /** 公開端點用：找出尚未過期的連結；不通過時直接寫好錯誤回應並回傳 null。 */
  function findActiveLink(req, res) {
    const found = storage.findTripByLinkToken(req.params.token);
    if (!found) {
      res.status(404).json({ error: '這個連結不存在，可能已經被撤銷或網址有誤' });
      return null;
    }
    if (storage.isLinkExpired(found.link)) {
      res.status(403).json({ error: '這個連結已經過期，請跟建立連結的人索取新的連結' });
      return null;
    }
    return found;
  }

  // ---- POST /api/trip/:tripId/links：建立連結（建立者） ----
  // body: { label?, guest, join, expiresInDays? }   expiresInDays 省略或 ≤0＝永久有效
  router.post('/trip/:tripId/links', (req, res) => {
    const trip = loadTripOr404(req, res);
    if (!trip) return;
    if (!requireTripAccess(req, res, trip, 'owner')) return;

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const access = parseAccess(body, { guest: 'none', join: false });
    if (typeof access === 'string') return res.status(400).json({ error: access });
    const days = Number(body.expiresInDays);
    const link = {
      token: storage.genShareToken(),
      label: typeof body.label === 'string' ? body.label.trim().slice(0, 50) : '',
      ...access,
      expiresAt: Number.isFinite(days) && days > 0 ? Date.now() + days * DAY_MS : null,
      createdAt: Date.now(),
    };
    trip.links.push(link);
    storage.persist(); // 連結不是行程內容，不 touchTrip、不觸發 SSE／版本衝突
    res.status(201).json(link);
  });

  // ---- GET /api/trip/:tripId/links：列出所有連結（建立者） ----
  router.get('/trip/:tripId/links', (req, res) => {
    const trip = loadTripOr404(req, res);
    if (!trip) return;
    if (!requireTripAccess(req, res, trip, 'owner')) return;
    res.json(trip.links);
  });

  // ---- PATCH /api/trip/:tripId/links/:token：修改連結（建立者） ----
  // 網址不變，對方下一次開啟或儲存時就會套用新設定。body: { guest?, join?, label? }
  router.patch('/trip/:tripId/links/:token', (req, res) => {
    const trip = loadTripOr404(req, res);
    if (!trip) return;
    if (!requireTripAccess(req, res, trip, 'owner')) return;

    const link = trip.links.find((l) => l.token === req.params.token);
    if (!link) return res.status(404).json({ error: '找不到這條連結，可能已經被撤銷過了' });
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const access = parseAccess(body, link);
    if (typeof access === 'string') return res.status(400).json({ error: access });
    Object.assign(link, access);
    if (typeof body.label === 'string') link.label = body.label.trim().slice(0, 50);
    storage.persist();
    res.json(link);
  });

  // ---- DELETE /api/trip/:tripId/links/:token：撤銷連結（建立者） ----
  router.delete('/trip/:tripId/links/:token', (req, res) => {
    const trip = loadTripOr404(req, res);
    if (!trip) return;
    if (!requireTripAccess(req, res, trip, 'owner')) return;

    const before = trip.links.length;
    trip.links = trip.links.filter((l) => l.token !== req.params.token);
    if (trip.links.length === before) return res.status(404).json({ error: '找不到這條連結，可能已經被撤銷過了' });
    storage.persist();
    res.json({ ok: true });
  });

  // ---- GET /api/trip/:tripId/invite：預設邀請連結（成員以上） ----
  // 沿用最早建立、仍有效的「只能加入、不開放訪客」連結；沒有就建立一條。
  // 建立者撤銷它之後，下一次有人要邀請時會自動產生新的。
  router.get('/trip/:tripId/invite', (req, res) => {
    const trip = loadTripOr404(req, res);
    if (!trip) return;
    if (!requireTripAccess(req, res, trip, 'member')) return;

    let link = trip.links
      .filter((l) => l.join && l.guest === 'none' && !storage.isLinkExpired(l))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!link) {
      link = { token: storage.genShareToken(), label: '邀請連結', guest: 'none', join: true, expiresAt: null, createdAt: Date.now() };
      trip.links.push(link);
      storage.persist();
    }
    res.json({ token: link.token });
  });

  // ---- GET /api/link/:token：解析連結（不需要登入） ----
  // 回傳這條連結開放的用法，以及目前登入者在這個行程的身分，讓前端決定要
  // 直接開啟行程、顯示「我是哪一位」，還是以訪客身分開啟。
  // 只有 join 連結才回傳成員名字；不含任何帳目或 Discord ID。tripId 只給本來就是成員的人。
  router.get('/link/:token', (req, res) => {
    const found = findActiveLink(req, res);
    if (!found) return;
    const { trip, link } = found;
    const uid = principalUserId(req.principal);
    const role = uid ? userRoleInTrip(uid, trip) : null;
    const mine = uid ? trip.members.find((m) => m.discordId === uid) : null;
    res.json({
      tripName: trip.name,
      guest: link.guest,
      join: link.join,
      members: link.join ? trip.members.map((m) => ({ id: m.id, name: m.name, linked: !!m.discordId })) : [],
      viewer: uid ? { userId: uid, role, memberId: mine ? mine.id : null } : null,
      tripId: role ? trip.id : null,
    });
  });

  // ---- POST /api/link/:token/claim：認領成員（需要 Discord 登入） ----
  // body: { memberId }        認領一位尚未連結的成員
  //    或 { newMemberName }   以新成員身分加入
  router.post('/link/:token/claim', (req, res) => {
    if (!req.principal || req.principal.kind !== 'user') {
      return res.status(401).json({ error: '請先用 Discord 登入', needLogin: true });
    }
    const uid = req.principal.userId;
    const r = claimLimiter.take(uid);
    if (!r.ok) return res.status(429).json({ error: '操作太頻繁了，請稍後再試' });

    const found = findActiveLink(req, res);
    if (!found) return;
    const { trip, link } = found;
    if (!link.join) return res.status(403).json({ error: '這個連結不能用來加入行程，請跟行程成員索取邀請連結' });

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

    storage.touchTrip(trip, { actor: actorOf(req) });
    storage.persist();
    res.json({ ok: true, tripId: trip.id, memberId: member.id });
  });

  return router;
};
