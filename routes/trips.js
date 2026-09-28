'use strict';
const express = require('express');

// 行程本體的讀寫端點：GET /api/guilds、GET/PUT/DELETE /api/trip/:guildId/:tripId。
// ctx 由 webui/server.js 組裝，包含 storage / apiKey / authorizeTripAccess / requireOwner。
//
// 🌐 [service 拆分] 這個檔案現在同時服務 webui 前端與 Mousebot（透過
// handlers/splitbill/utils/splitbillClient.js），bot 對這個 service 來說
// 權限視同擁有者（沿用 SPLITBILL_API_KEY／requireOwner），Discord 成員層級
// 的權限檢查在 bot 自己的 index.js enforceTripPermission() 已經做過。
module.exports = function createTripsRouter(ctx) {
  const { storage, apiKey, authorizeTripAccess, requireOwner } = ctx;
  const router = express.Router();

  // ---- GET /api/guilds：列出所有伺服器與底下的行程（給前端下拉選單用） ----
  router.get('/guilds', (req, res) => {
    if (apiKey && !req.isOwner) {
      return res.status(403).json({ error: '此操作僅限擁有者本人執行' });
    }
    try {
      const all = storage.loadAll();
      const result = Object.entries(all).map(([guildId, guild]) => ({
        guildId,
        defaultTripId: guild.defaultTripId || null,
        trips: Object.values(guild.trips || {}).map(t => ({
          id: t.id,
          name: t.name,
          archived: !!t.archived,
        })),
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- GET /api/trip/:guildId/:tripId：取得單一行程完整資料 ----
  router.get('/trip/:guildId/:tripId', (req, res) => {
    try {
      const guild = storage.getGuild(req.params.guildId);
      const trip = guild.trips[req.params.tripId];
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      if (!authorizeTripAccess(req, res, trip, false)) return;
      res.json(trip);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- PUT /api/trip/:guildId/:tripId：覆蓋寫入（或建立）單一行程 ----
  router.put('/trip/:guildId/:tripId', (req, res) => {
    try {
      const guild = storage.getGuild(req.params.guildId);
      const existing = guild.trips[req.params.tripId];
      const isNewTrip = !existing;

      if (existing) {
        if (!authorizeTripAccess(req, res, existing, true)) return;
      } else {
        if (!requireOwner(req, res)) return;
      }

      if (existing) {
        const expected = req.body && req.body.expectedUpdatedAt;
        if (typeof expected === 'number' && typeof existing.updatedAt === 'number' && expected !== existing.updatedAt) {
          return res.status(409).json({
            error: '這個行程已經被其他人更新過，請合併最新版本後再儲存一次。',
            currentTrip: existing,
          });
        }
      }
      const incoming = req.body || {};
      const writerId = typeof incoming.writerId === 'string' ? incoming.writerId.slice(0, 64) : null;
      delete incoming.expectedUpdatedAt;
      delete incoming.writerId;
      if (existing) {
        incoming.shareLinks = existing.shareLinks;
      }
      const repaired = storage.repairTrip({ ...incoming, id: req.params.tripId });
      guild.trips[req.params.tripId] = repaired;

      // 🌐 [service 拆分] 這個 guild 還沒有任何預設行程時（例如這是第一個
      // 被建立的行程），順便設成預設值，讓之後「從未選過行程」的使用者
      // 有個合理的起點——原本這段邏輯在 bot 端 tripUI.js 本地做，現在
      // guild.defaultTripId 只存在這個 service，只能搬到這裡一起處理。
      if (isNewTrip && !guild.defaultTripId) {
        guild.defaultTripId = req.params.tripId;
      }

      storage.touchTrip(repaired, { writerId });
      storage.persist();
      res.json(repaired);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- DELETE /api/trip/:guildId/:tripId：徹底刪除一個行程 ----
  // 只接受擁有者金鑰（含 bot）——分享連結持有者不該能刪除整個行程，這裡
  // 沒有比照 GET/PUT 那樣接受 authorizeTripAccess()。
  router.delete('/trip/:guildId/:tripId', (req, res) => {
    try {
      const guild = storage.getGuild(req.params.guildId);
      const trip = guild.trips[req.params.tripId];
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      if (!requireOwner(req, res)) return;

      if (guild.defaultTripId === trip.id) guild.defaultTripId = null;
      // 行程被刪除後，順手清掉所有指向它的個人指標，避免資料檔留下
      // 指向不存在行程的殘影。
      for (const uid of Object.keys(guild.activeTripByUser)) {
        if (guild.activeTripByUser[uid] === trip.id) delete guild.activeTripByUser[uid];
      }
      delete guild.trips[trip.id];
      storage.persist();
      // 🆕 [即時同步] 通知所有正在開著這個行程的 webui 分頁：行程已被刪除，
      // 讓它們主動關閉連線、提醒使用者。
      storage.tripEvents.emit('trip-deleted', trip.id);

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
