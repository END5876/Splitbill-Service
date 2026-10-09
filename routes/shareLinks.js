'use strict';
const express = require('express');

// ════════════════════════════════════════════════════════════════
// 🆕 [分享連結] 擁有者專用：建立／列出／修改／撤銷某個行程的分享連結
// ════════════════════════════════════════════════════════════════
// 這幾個端點只接受行程建立者（以及持有 SPLITBILL_API_KEY 的管理端），即使是
// 「可編輯」的分享連結也不能呼叫——分享連結的管理權本身不能被分享出去，否則
// 拿到一個可編輯連結的人就能再幫自己開一把新的連結，權限無限擴散。
module.exports = function createShareLinksRouter(ctx) {
  const { storage, requireTripAccess } = ctx;
  const router = express.Router();

  // ---- POST /api/trip/:tripId/share-links：建立一筆新的分享連結 ----
  // body: { label?: string, permission: 'read'|'write', expiresInDays?: number|null }
  //   expiresInDays 省略或 null／0／負數 一律視為「永久有效」。
  router.post('/trip/:tripId/share-links', (req, res) => {
    try {
      const trip = storage.getTrip(req.params.tripId);
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      if (!requireTripAccess(req, res, trip, 'owner')) return;

      const body = req.body || {};
      const permission = body.permission === 'write' ? 'write' : 'read';
      const label = typeof body.label === 'string' ? body.label.slice(0, 50) : '';
      const days = Number(body.expiresInDays);
      const expiresAt = (Number.isFinite(days) && days > 0)
        ? Date.now() + days * 24 * 60 * 60 * 1000
        : null;

      const link = {
        token: storage.genShareToken(),
        label,
        permission,
        expiresAt,
        createdAt: Date.now(),
      };

      if (!Array.isArray(trip.shareLinks)) trip.shareLinks = [];
      trip.shareLinks.push(link);
      storage.persist();

      res.json(link);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- GET /api/trip/:tripId/share-links：列出這個行程目前所有分享連結 ----
  router.get('/trip/:tripId/share-links', (req, res) => {
    try {
      const trip = storage.getTrip(req.params.tripId);
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      if (!requireTripAccess(req, res, trip, 'owner')) return;
      res.json(trip.shareLinks || []);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 🆕 ---- PATCH /api/trip/:tripId/share-links/:token：修改一筆既有分享連結的權限 ----
  // 讓擁有者不用撤銷重建，就能隨時把一組已經發出去的連結在「唯讀／可編輯」之間切換。
  // 連結本身的 token／網址完全不變（對方書籤/聊天室裡存的舊連結還是同一個），
  // 只有伺服器這邊記錄的 permission 欄位被更新，下一次對方存取或儲存時就會立刻套用新權限。
  // body: { permission: 'read'|'write' }
  router.patch('/trip/:tripId/share-links/:token', (req, res) => {
    try {
      const trip = storage.getTrip(req.params.tripId);
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      if (!requireTripAccess(req, res, trip, 'owner')) return;

      const permission = (req.body || {}).permission;
      if (permission !== 'read' && permission !== 'write') {
        return res.status(400).json({ error: 'permission 必須是 "read" 或 "write"' });
      }

      const link = (trip.shareLinks || []).find((l) => l.token === req.params.token);
      if (!link) {
        return res.status(404).json({ error: '找不到這筆分享連結，可能已經被撤銷過了' });
      }

      link.permission = permission;
      storage.persist();
      res.json(link);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- DELETE /api/trip/:tripId/share-links/:token：撤銷一筆分享連結 ----
  router.delete('/trip/:tripId/share-links/:token', (req, res) => {
    try {
      const trip = storage.getTrip(req.params.tripId);
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      if (!requireTripAccess(req, res, trip, 'owner')) return;

      const before = (trip.shareLinks || []).length;
      trip.shareLinks = (trip.shareLinks || []).filter((l) => l.token !== req.params.token);
      if (trip.shareLinks.length === before) {
        return res.status(404).json({ error: '找不到這筆分享連結，可能已經被撤銷過了' });
      }
      storage.persist();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
