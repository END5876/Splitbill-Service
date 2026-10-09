'use strict';
const express = require('express');

// Bot 專用：Discord 伺服器層級的兩個端點。網頁的操作模型以行程為單位，不需要
// 「每個使用者各自的作用行程」這個概念，因此只接受金鑰（Bot）。
// 🆕 [行程獨立化] 伺服器底下的「行程清單」不再是儲存結構，而是「目前綁定在這個
// 伺服器上的行程」這個查詢結果；只有綁定過的行程才會出現在 Discord 面板裡。
module.exports = function createGuildRouter(ctx) {
  const { storage, requireService } = ctx;
  const router = express.Router();

  // ---- GET /api/guild/:guildId：{ trips, activeTripByUser, defaultTripId } ----
  // 對應 Bot 端 resolveTrip() 需要的所有資料，一次拿齊。查詢不會建立任何新資料。
  router.get('/guild/:guildId', (req, res) => {
    if (!requireService(req, res)) return;
    try {
      const guildId = req.params.guildId;
      const state = storage.peekGuildState(guildId);
      const trips = {};
      for (const t of storage.listGuildTrips(guildId)) trips[t.id] = storage.toPublicTrip(t);
      const activeTripByUser = {};
      for (const [uid, tid] of Object.entries(state.activeTripByUser)) {
        if (storage.hasOwn(trips, tid)) activeTripByUser[uid] = tid;
      }
      res.json({
        trips,
        activeTripByUser,
        defaultTripId: storage.hasOwn(trips, state.defaultTripId) ? state.defaultTripId : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- PATCH /api/guild/:guildId/active-trip：設定某位使用者自己的作用行程 ----
  // body: { userId, tripId }；只影響這一位使用者，不影響同伺服器其他人。
  router.patch('/guild/:guildId/active-trip', (req, res) => {
    if (!requireService(req, res)) return;
    try {
      const guildId = req.params.guildId;
      const { userId, tripId } = req.body || {};
      if (!storage.isSnowflake(userId) || typeof tripId !== 'string' || !tripId) {
        return res.status(400).json({ error: '缺少或錯誤的 userId／tripId' });
      }
      if (!storage.isSnowflake(guildId)) return res.status(400).json({ error: 'guildId 格式錯誤' });
      const trip = storage.getTrip(tripId);
      if (!trip || trip.guildId !== guildId) {
        return res.status(404).json({ error: '找不到這個行程' });
      }
      storage.ensureGuildState(guildId).activeTripByUser[userId] = tripId;
      storage.persist();
      res.json({ ok: true, userId, tripId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
