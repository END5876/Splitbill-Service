'use strict';
const express = require('express');
const { isSafeId, validateExpenseEntry, validateDepositEntry, str } = require('../lib/validate');

// ════════════════════════════════════════════════════════════════
// 單筆支出／轉帳的寫入端點。
// -----------------------------------------------------------------
// 整包 PUT（routes/trips.js）每改一筆就要把整個行程送一次，多人同時記帳時也只能
// 靠整份比對＋合併。這裡改成「只動一筆」：
//   PUT    …/expenses/:entryId   新增或取代一筆支出（id 由前端產生，重送同一筆是冪等的）
//   DELETE …/expenses/:entryId   刪除一筆支出（已經不存在也算成功）
//   PUT／DELETE …/deposits/:entryId  轉帳／預收款，同上
// 兩個人同時改「不同筆」不會再互相衝突；同一筆則以後送達的為準。
//
// 回應帶 prevUpdatedAt（這次寫入前伺服器的版本）與 updatedAt（寫入後的版本）：
// 前端手上的版本若等於 prevUpdatedAt，代表中間沒有別人寫入，直接把版本號往前推即可；
// 不相等就表示漏了別人的更新，前端會重新取一次完整行程來合併。
//
// 同一組端點掛在兩種路徑上，只差在怎麼找到行程、怎麼驗證權限：
//   /api/trip/:tripId/…           成員／Bot（需要 write）
//   /api/shared-trip/:token/…     可編輯的分享連結
// ════════════════════════════════════════════════════════════════
module.exports = function createEntriesRouter(ctx) {
  const { storage, requireTripAccess, requireGuestLink } = ctx;
  const router = express.Router();

  function tripByTripId(req, res) {
    const trip = storage.getTrip(req.params.tripId);
    if (!trip) {
      res.status(404).json({ error: '找不到這個行程' });
      return null;
    }
    return requireTripAccess(req, res, trip, 'write') ? trip : null;
  }
  function tripByShareToken(req, res) {
    const found = requireGuestLink(req, res, '此分享連結為唯讀，無法儲存變更');
    return found && found.trip;
  }

  const KINDS = {
    expenses: {
      validate: validateExpenseEntry,
      repair: (e, trip, existing) => ({
        ...storage.repairExpense(e, undefined, trip.baseCurrency),
        // 建立者沿用第一次寫入時的值，之後編輯不會改掉
        createdBy: existing ? existing.createdBy : (str(e.createdBy, 64) || 'web-ui'),
      }),
    },
    deposits: {
      validate: validateDepositEntry,
      repair: (d, trip) => storage.repairDeposit(d, undefined, trip.baseCurrency),
    },
  };

  function writerIdOf(req) {
    const w = req.body && req.body.writerId;
    return typeof w === 'string' ? w.slice(0, 64) : null;
  }

  function commit(trip, req) {
    const prevUpdatedAt = typeof trip.updatedAt === 'number' ? trip.updatedAt : null;
    storage.touchTrip(trip, { writerId: writerIdOf(req) });
    storage.persist();
    return { prevUpdatedAt, updatedAt: trip.updatedAt };
  }

  function mount(base, resolveTrip) {
    for (const [kind, spec] of Object.entries(KINDS)) {
      router.put(`${base}/${kind}/:entryId`, (req, res) => {
        const trip = resolveTrip(req, res);
        if (!trip) return;
        const entryId = req.params.entryId;
        if (!isSafeId(entryId)) return res.status(400).json({ error: '資料 ID 格式錯誤' });
        const raw = req.body && req.body.entry;
        const error = spec.validate(raw, trip);
        if (error) return res.status(400).json({ error });

        const list = trip[kind];
        const index = list.findIndex((x) => x.id === entryId);
        const existing = index === -1 ? null : list[index];
        const entry = { ...spec.repair({ ...raw, id: entryId }, trip, existing), id: entryId };
        if (index === -1) list.push(entry);
        else list[index] = entry;

        res.json({ entry, ...commit(trip, req) });
      });

      router.delete(`${base}/${kind}/:entryId`, (req, res) => {
        const trip = resolveTrip(req, res);
        if (!trip) return;
        const index = trip[kind].findIndex((x) => x.id === req.params.entryId);
        if (index === -1) {
          const v = typeof trip.updatedAt === 'number' ? trip.updatedAt : null;
          return res.json({ deleted: false, prevUpdatedAt: v, updatedAt: v });
        }
        trip[kind].splice(index, 1);
        res.json({ deleted: true, ...commit(trip, req) });
      });
    }
  }

  mount('/trip/:tripId', tripByTripId);
  mount('/shared-trip/:token', tripByShareToken);

  return router;
};
