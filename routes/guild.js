'use strict';
const express = require('express');

// 給獨立出去的 splitbill-service 用：guild 層級的兩個端點，webui 本身不需要
// （webui 的操作模型是單一行程，沒有「每個使用者各自的作用行程」這個概念），
// 只有 Discord bot 端的 resolveTrip()/setUserActiveTrip() 需要，因此只接受
// 擁有者金鑰（bot 對這個 service 來說權限視同擁有者，Discord 成員層級的權限
// 檢查在 bot 自己的 enforceTripPermission() 已經做過，這裡不重複判斷）。
module.exports = function createGuildRouter(ctx) {
  const { storage, requireOwner } = ctx;
  const router = express.Router();

  // ---- GET /api/guild/:guildId：完整 guild 結構 ----
  // 回傳 { trips, activeTripByUser, defaultTripId }，對應 bot 端
  // tripHelper.resolveTrip() 需要的所有資料，一次拿齊不用多次來回。
  router.get('/guild/:guildId', (req, res) => {
    if (!requireOwner(req, res)) return;
    try {
      const guild = storage.getGuild(req.params.guildId);
      // Bot 不需要（也不該拿到）分享連結 token，一律去掉。
      const trips = {};
      for (const [id, t] of Object.entries(guild.trips)) trips[id] = storage.toPublicTrip(t);
      res.json({
        trips,
        activeTripByUser: guild.activeTripByUser,
        defaultTripId: guild.defaultTripId,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- PATCH /api/guild/:guildId/active-trip：設定某位使用者自己的作用行程 ----
  // body: { userId, tripId }
  // 對應 bot 端原本的 storage.setUserActiveTrip()，只影響這一位使用者，
  // 不影響同伺服器其他人（沿用 Mousebot 原本「切換行程只影響自己」的設計）。
  router.patch('/guild/:guildId/active-trip', (req, res) => {
    if (!requireOwner(req, res)) return;
    try {
      const { userId, tripId } = req.body || {};
      if (!userId || !tripId) {
        return res.status(400).json({ error: '缺少 userId 或 tripId' });
      }
      const guild = storage.getGuild(req.params.guildId);
      if (!guild.trips[tripId]) {
        return res.status(404).json({ error: '找不到這個行程' });
      }
      guild.activeTripByUser[userId] = tripId;
      storage.persist();
      res.json({ ok: true, userId, tripId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
