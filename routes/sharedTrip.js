'use strict';
const express = require('express');
const { mergeIncomingMembers } = require('../lib/members');

// ════════════════════════════════════════════════════════════════
// 🆕 [分享連結] 分享連結持有者專用：純粹靠網址路徑上的 token 當憑證，
// 完全不需要另外填寫或帶上任何 API Key——這是刻意的設計，因為分享連結
// 的對象通常是不熟悉技術的朋友，任何「還要另外設定金鑰」的步驟對他們
// 來說都是困惑跟阻礙。安全性由 token 本身的高熵亂數（192 bits）與可
// 個別撤銷/設定過期時間來保證，而不是靠額外的登入手續。
//
// SSE 版本（GET /api/shared-trip/:token/events）放在 routes/sse.js。
// ════════════════════════════════════════════════════════════════
module.exports = function createSharedTripRouter(ctx) {
  const { storage, requireGuestLink, actorOf } = ctx;
  const router = express.Router();

  // ---- GET /api/shared-trip/:token：依分享連結 token 取得對應的行程資料 ----
  router.get('/shared-trip/:token', (req, res) => {
    const found = requireGuestLink(req, res);
    if (!found) return;
    res.json({ trip: storage.toGuestTrip(found.trip), permission: found.link.guest });
  });

  // ---- PUT /api/shared-trip/:token：依分享連結 token 寫入行程資料（需要 write 權限）----
  router.put('/shared-trip/:token', (req, res) => {
    const found = requireGuestLink(req, res, '此分享連結為唯讀，無法儲存變更');
    if (!found) return;

    // 🆕 [併發保護] 原子化版本比對，理由同 routes/trips.js 的 PUT /api/trip/:tripId。
    // 分享連結版本先前完全沒有任何併發保護（連前端的「先查再比對」都沒有），
    // 風險其實比擁有者版本更高，這裡一併補上。
    const expected = req.body && req.body.expectedUpdatedAt;
    if (typeof expected === 'number' && typeof found.trip.updatedAt === 'number' && expected !== found.trip.updatedAt) {
      return res.status(409).json({
        error: '這個行程已經被其他人更新過，請合併最新版本後再儲存一次。',
        currentTrip: storage.toGuestTrip(found.trip),
      });
    }

    const incoming = (req.body && typeof req.body === 'object') ? { ...req.body } : {};
    const tooMany = storage.tooManyEntries(incoming);
    if (tooMany) return res.status(400).json({ error: tooMany });
    const writerId = typeof incoming.writerId === 'string' ? incoming.writerId.slice(0, 64) : null;
    delete incoming.expectedUpdatedAt;
    delete incoming.writerId;
    // 🔒 同 routes/trips.js PUT 的安全性備註：憑證、建立者、綁定的伺服器
    // 一律沿用伺服器上的值；分享連結持有者不能替成員連結 Discord 帳號。
    const existing = found.trip;
    incoming.links = existing.links;
    delete incoming.shareLinks; // 舊版欄位，理由見 routes/trips.js
    delete incoming.invite;
    incoming.guildId = existing.guildId;
    incoming.createdAt = existing.createdAt;
    if (existing.ownerId) incoming.ownerId = existing.ownerId;
    else delete incoming.ownerId;
    // 訪客不能移除已連結 Discord 的成員（那等於把人踢出行程），漏掉的會被補回去
    incoming.members = mergeIncomingMembers(existing.members, incoming.members, { canLink: false, canRemoveLinked: () => false });
    const repaired = storage.repairTrip({ ...incoming, id: existing.id });
    storage.setTrip(repaired);
    // 🆕 [多人協作 / 即時同步] 同上，改用 touchTrip() 才會觸發 SSE 廣播，
    // 並一併帶上 writerId 讓寫入者本人可以被正確辨識出來。
    storage.touchTrip(repaired, { writerId, actor: actorOf(req, found.link) });
    storage.persist();
    res.json({ trip: storage.toGuestTrip(repaired), permission: found.link.guest });
  });

  return router;
};
