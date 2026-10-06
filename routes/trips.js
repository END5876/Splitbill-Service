'use strict';
const express = require('express');

// 行程本體的讀寫端點：GET /api/guilds、GET/PUT/DELETE /api/trip/:guildId/:tripId。
// ctx 由 webui/server.js 組裝，包含 storage / apiKey / authorizeTripAccess / requireOwner。
//
// 🌐 [service 拆分] 這個檔案現在同時服務 webui 前端與 Mousebot（透過
// handlers/splitbill/utils/splitbillClient.js），bot 對這個 service 來說
// 權限視同擁有者（沿用 SPLITBILL_API_KEY／requireOwner），Discord 成員層級
// 的權限檢查在 bot 自己的 index.js enforceTripPermission() 已經做過。
// 「Bot 擁有者」的 Discord ID（逗號分隔，與 Mousebot 的 OWNER_USER_ID 相同）。
// 刪除行程時，若呼叫端宣告了操作者（x-actor-id），只有該行程的建立者或這些人能刪。
const OWNER_USER_IDS = new Set(
  (process.env.OWNER_USER_ID || '').split(',').map((s) => s.trim()).filter(Boolean)
);

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
      res.json(storage.toPublicTrip(trip));
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
            currentTrip: storage.toPublicTrip(existing),
          });
        }
      }
      const incoming = req.body || {};
      const writerId = typeof incoming.writerId === 'string' ? incoming.writerId.slice(0, 64) : null;
      delete incoming.expectedUpdatedAt;
      delete incoming.writerId;
      if (existing) {
        incoming.shareLinks = existing.shareLinks;
        // 🔒 ownerId 一旦建立就不可變更：否則持有「可編輯」分享連結的人只要 PUT
        // 一個自己的 ownerId，就能把自己（或自己控制的 Discord 帳號）變成建立者。
        if (existing.ownerId) incoming.ownerId = existing.ownerId;
        else delete incoming.ownerId;
      } else if (typeof incoming.ownerId !== 'string' || !incoming.ownerId.trim()) {
        delete incoming.ownerId; // 新行程：只有擁有者金鑰能走到這裡（上面已 requireOwner），ownerId 才被採用
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
      res.json(storage.toPublicTrip(repaired));
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

      // 🔒 呼叫端（例如 Mousebot）宣告了「是誰要刪」時，在這裡獨立再驗證一次：
      // 只有行程建立者或 OWNER_USER_ID 名單內的人可以刪。沒帶 x-actor-id 的呼叫
      // （持有擁有者金鑰的網頁／維運）維持原本行為。
      const actorId = (req.get('x-actor-id') || '').trim().slice(0, 64);
      if (actorId && !OWNER_USER_IDS.has(actorId) && !(trip.ownerId && trip.ownerId === actorId)) {
        return res.status(403).json({ error: '只有行程建立者可以刪除這個行程' });
      }

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
