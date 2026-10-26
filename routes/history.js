'use strict';
const express = require('express');
const { mergeIncomingMembers } = require('../lib/members');

// ════════════════════════════════════════════════════════════════
// 操作紀錄與歷史版本（資料來源見 lib/activity.js、lib/db.js 的 trip_activity／trip_revisions）。
//   GET  …/activity?before=<updatedAt>&limit=30   操作紀錄，新的在前（能看行程就能看）
//   GET  …/revisions/:updatedAt                   某個版本的完整內容（能看行程就能看）
//   POST …/revisions/:updatedAt/restore           把行程內容整份還原成那個版本（需要可編輯）
// 單筆「還原刪掉的支出」不在這裡：網頁直接用操作紀錄裡存的內容呼叫單筆 API
// （routes/entries.js，帶 restore: true）。
//
// 同一組端點掛在兩種路徑上：
//   /api/trip/:tripId/…          成員／Bot
//   /api/shared-trip/:token/…    分享連結訪客（唯讀連結只能看，不能還原）
// ════════════════════════════════════════════════════════════════
module.exports = function createHistoryRouter(ctx) {
  const { storage, requireTripAccess, requireGuestLink, actorOf, principalUserId } = ctx;
  const router = express.Router();

  // 回傳 { trip, actor, viewerId }；不通過時已經寫好錯誤回應、回傳 null
  function byTripId(req, res, needWrite) {
    const trip = storage.getTrip(req.params.tripId);
    if (!trip) {
      res.status(404).json({ error: '找不到這個行程' });
      return null;
    }
    if (!requireTripAccess(req, res, trip, needWrite ? 'write' : 'read')) return null;
    return { trip, actor: actorOf(req), viewerId: principalUserId(req.principal) };
  }
  function byShareToken(req, res, needWrite) {
    const found = requireGuestLink(req, res, needWrite ? '此分享連結為唯讀，無法還原' : null);
    return found && { trip: found.trip, actor: actorOf(req, found.link), viewerId: null, guest: true };
  }

  function parseVersion(raw) {
    const v = Number(raw);
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  }

  function mount(base, resolve) {
    router.get(`${base}/activity`, (req, res) => {
      const r = resolve(req, res, false);
      if (!r) return;
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
      const before = parseVersion(req.query.before);
      // 多拿一筆，用來判斷還有沒有更舊的
      const rows = storage.listTripActivity(r.trip.id, before, limit + 1);
      const revisions = new Set(storage.listTripRevisions(r.trip.id).map((x) => x.updatedAt));
      const items = rows.slice(0, limit).map((row) => {
        // 🔒 訪客看到的支出 before／after 也不帶記帳者的 Discord ID（見 storage.toGuestActivity）
        const a = r.guest ? storage.toGuestActivity(row) : row;
        // 不把 Discord ID 送出去，只告訴前端「是不是我」
        const { userId, ...actor } = a.actor || {};
        return {
          ...a,
          actor: { ...actor, isMe: !!(userId && r.viewerId && userId === r.viewerId) },
          // 目前版本不必還原；太舊的快照已經被清掉
          restorable: revisions.has(a.updatedAt) && a.updatedAt !== r.trip.updatedAt,
        };
      });
      res.json({ items, hasMore: rows.length > limit, currentUpdatedAt: r.trip.updatedAt || null });
    });

    router.get(`${base}/revisions/:version`, (req, res) => {
      const r = resolve(req, res, false);
      if (!r) return;
      const v = parseVersion(req.params.version);
      const snap = v && storage.getTripRevision(r.trip.id, v);
      if (!snap) return res.status(404).json({ error: '這個版本已經不在保留範圍內' });
      res.json({ trip: r.guest ? storage.toGuestTrip(snap) : snap, updatedAt: v });
    });

    router.post(`${base}/revisions/:version/restore`, (req, res) => {
      const r = resolve(req, res, true);
      if (!r) return;
      const { trip } = r;
      const v = parseVersion(req.params.version);
      if (v && v === trip.updatedAt) return res.status(400).json({ error: '這已經是目前的版本了' });
      const snap = v && storage.getTripRevision(trip.id, v);
      if (!snap) return res.status(404).json({ error: '這個版本已經不在保留範圍內' });

      // 成員：以那個版本的名單為準，但「目前已連結 Discord 的成員」一律保留——
      // 還原帳目不應該順便把人踢出行程（他們會因此失去存取權）。Discord 連結
      // 只沿用伺服器上現有的，還原不會把已經解除的連結接回去（lib/members.js）。
      const snapMembers = (snap.members || []).map((m) => ({ id: m.id, name: m.name }));
      const keepLinked = trip.members
        .filter((m) => m.discordId && !snapMembers.some((s) => s.id === m.id))
        .map((m) => ({ id: m.id, name: m.name }));
      const members = mergeIncomingMembers(trip.members, [...snapMembers, ...keepLinked], { canLink: false });

      // 憑證、建立者、綁定的伺服器、封存狀態都沿用目前的。
      // 基準幣別跟著那個版本：帳目的 amountInBase 是用當時的基準幣算的，只還原帳目、
      // 留著現在的基準幣，金額會整個算錯。
      const restored = storage.repairTrip({
        ...trip,
        name: snap.name,
        baseCurrency: snap.baseCurrency || trip.baseCurrency,
        rates: snap.rates,
        expenses: snap.expenses,
        deposits: snap.deposits,
        members,
        id: trip.id,
      }, { keepUnknown: true }); // 快照與目前的行程都是伺服器自己存的，不認得的欄位照樣保留
      storage.preserveUnknownFields(trip, restored);
      storage.setTrip(restored);
      const writerId = req.body && typeof req.body.writerId === 'string' ? req.body.writerId.slice(0, 64) : null;
      storage.touchTrip(restored, { writerId, actor: r.actor, reason: { type: 'restore-revision', from: v } });
      storage.persist();
      res.json({ trip: r.guest ? storage.toGuestTrip(restored) : storage.toPublicTrip(restored) });
    });
  }

  mount('/trip/:tripId', byTripId);
  mount('/shared-trip/:token', byShareToken);

  return router;
};
