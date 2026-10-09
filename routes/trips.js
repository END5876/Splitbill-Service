'use strict';
const express = require('express');
const { mergeIncomingMembers } = require('../lib/members');

// 行程本體的讀寫端點：GET/PUT/DELETE /api/trip/:tripId，以及舊網頁用的 GET /api/guilds。
// 🆕 [行程獨立化] 行程以 tripId 為主鍵，綁定的 Discord 伺服器只是行程上的 guildId 欄位；
// 舊網址 /api/trip/:guildId/:tripId 由 lib/legacyPaths.js 改寫到這裡。

module.exports = function createTripsRouter(ctx) {
  const { storage, requireTripAccess, requireService, canLinkMembers } = ctx;
  const router = express.Router();

  function loadTripOr404(req, res) {
    const trip = storage.getTrip(req.params.tripId);
    if (!trip) res.status(404).json({ error: '找不到這個行程' });
    return trip;
  }

  // ---- GET /api/guilds：舊網頁的下拉選單（依伺服器分組列出所有行程），僅限金鑰 ----
  // （新網頁改用 GET /api/my/trips，見 routes/me.js）
  // 未綁定伺服器的行程分在 "_" 這一組（配合 lib/legacyPaths.js：非 snowflake 的
  // guild 片段對應到未綁定的行程）。
  router.get('/guilds', (req, res) => {
    if (!requireService(req, res)) return;
    try {
      const groups = new Map();
      for (const t of storage.listTrips()) {
        const gid = t.guildId || '_';
        if (!groups.has(gid)) groups.set(gid, []);
        groups.get(gid).push({ id: t.id, name: t.name, archived: !!t.archived });
      }
      const result = [...groups.entries()].map(([guildId, trips]) => ({
        guildId,
        defaultTripId: guildId === '_' ? null : (storage.peekGuildState(guildId).defaultTripId || null),
        trips,
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- GET /api/trip/:tripId：取得單一行程完整資料 ----
  router.get('/trip/:tripId', (req, res) => {
    try {
      const trip = loadTripOr404(req, res);
      if (!trip) return;
      if (!requireTripAccess(req, res, trip, 'read')) return;
      res.json(storage.toPublicTrip(trip));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- PUT /api/trip/:tripId：整包覆蓋寫入單一行程 ----
  // 行程不存在時，只有持有金鑰的呼叫端可以順便建立（舊版 Bot／舊網頁的建立方式）；
  // 網頁登入者與新版 Bot 一律改用 POST /api/trips（見 routes/me.js）。
  router.put('/trip/:tripId', (req, res) => {
    try {
      const tripId = req.params.tripId;
      const existing = storage.getTrip(tripId);

      if (existing) {
        if (!requireTripAccess(req, res, existing, 'write')) return;
        const expected = req.body && req.body.expectedUpdatedAt;
        if (typeof expected === 'number' && typeof existing.updatedAt === 'number' && expected !== existing.updatedAt) {
          return res.status(409).json({
            error: '這個行程已經被其他人更新過，請合併最新版本後再儲存一次。',
            currentTrip: storage.toPublicTrip(existing),
          });
        }
      } else {
        if (!requireService(req, res)) return;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(tripId)) {
          return res.status(400).json({ error: '行程 ID 格式錯誤' });
        }
      }

      const incoming = (req.body && typeof req.body === 'object') ? { ...req.body } : {};
      const writerId = typeof incoming.writerId === 'string' ? incoming.writerId.slice(0, 64) : null;
      delete incoming.expectedUpdatedAt;
      delete incoming.writerId;

      // 🔒 這些欄位只能透過專用端點改變，整包 PUT 一律沿用伺服器上的值：
      //   shareLinks / invite：憑證，只走擁有者專用端點
      //   ownerId：建立者一旦決定就不可變更（否則可編輯分享連結就能把自己變成建立者）
      //   guildId：只走綁定碼 attach／detach
      //   members[].discordId：見 lib/members.js
      if (existing) {
        incoming.shareLinks = existing.shareLinks;
        incoming.invite = existing.invite;
        incoming.guildId = existing.guildId;
        if (existing.ownerId) incoming.ownerId = existing.ownerId;
        else delete incoming.ownerId;
        incoming.createdAt = existing.createdAt;
      } else {
        delete incoming.shareLinks;
        delete incoming.invite;
        incoming.guildId = null; // 下面依舊網址的 guildId 決定要不要綁定
        if (typeof incoming.ownerId !== 'string' || !incoming.ownerId.trim()) delete incoming.ownerId;
      }
      incoming.members = mergeIncomingMembers(
        existing ? existing.members : [],
        incoming.members,
        { canLink: canLinkMembers(req) }
      );

      const repaired = storage.repairTrip({ ...incoming, id: tripId });
      storage.setTrip(repaired);
      if (!existing && req.legacyGuildId) storage.attachTripToGuild(repaired, req.legacyGuildId);

      storage.touchTrip(repaired, { writerId });
      storage.persist();
      res.json(storage.toPublicTrip(repaired));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- DELETE /api/trip/:tripId：徹底刪除一個行程 ----
  // 只有行程建立者（含 OWNER_USER_ID）可以刪除——不論是網頁登入者，還是 Bot
  // 宣告的操作者（x-actor-id），都在 lib/auth.js 以同一套規則判斷。
  router.delete('/trip/:tripId', (req, res) => {
    try {
      const trip = loadTripOr404(req, res);
      if (!trip) return;
      if (!requireTripAccess(req, res, trip, 'owner')) return;

      storage.removeTrip(trip.id);
      storage.persist();
      // 🆕 [即時同步] 通知所有正在開著這個行程的分頁：行程已被刪除。
      storage.tripEvents.emit('trip-deleted', trip.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

