'use strict';
const express = require('express');
const { isSafeId, validateExpenseEntry, validateDepositEntry, str } = require('../lib/validate');
const { isSnowflake } = require('../lib/snowflake');

// ════════════════════════════════════════════════════════════════
// 單筆支出／轉帳的寫入端點。
// -----------------------------------------------------------------
// 整包 PUT（routes/trips.js）每改一筆就要把整個行程送一次，多人同時記帳時也只能
// 靠整份比對＋合併。這裡改成「只動一筆」：
//   PUT    …/expenses/:entryId   新增或取代一筆支出（id 由前端產生，重送同一筆是冪等的）
//   DELETE …/expenses/:entryId   刪除一筆支出（已經不存在也算成功）
//   PUT／DELETE …/deposits/:entryId  轉帳／預收款，同上
// 兩個人同時改「不同筆」不會再互相衝突。同一筆：body 帶 base（開始改之前看到的那筆，新增時是 null），
// 伺服器上的內容已經和 base 不同就回 409 { conflict: 'changed' | 'deleted', current }，由使用者決定。
// 沒帶 base 的（舊版網頁）維持以後送達的為準。
//
// 回應帶 prevUpdatedAt（這次寫入前伺服器的版本）與 updatedAt（寫入後的版本）：
// 前端手上的版本若等於 prevUpdatedAt，代表中間沒有別人寫入，直接把版本號往前推即可；
// 不相等就表示漏了別人的更新，前端會重新取一次完整行程來合併。
//
// body 可以帶 restore: true，代表這是從操作紀錄「還原」的（只影響紀錄上的說明）。
//
// 同一組端點掛在兩種路徑上，只差在怎麼找到行程、怎麼驗證權限：
//   /api/trip/:tripId/…           成員／Bot（需要 write）
//   /api/shared-trip/:token/…     可編輯的分享連結
// ════════════════════════════════════════════════════════════════
module.exports = function createEntriesRouter(ctx) {
  const { storage, requireTripAccess, requireGuestLink, actorOf } = ctx;
  const router = express.Router();

  // 找出行程並確認可以寫入；回傳 { trip, actor }，不通過時已經寫好錯誤回應、回傳 null
  function tripByTripId(req, res) {
    const trip = storage.getTrip(req.params.tripId);
    if (!trip) {
      res.status(404).json({ error: '找不到這個行程' });
      return null;
    }
    if (!requireTripAccess(req, res, trip, 'write')) return null;
    if (trip.archived) { res.status(403).json({ error: '這個行程已封存，只能看、不能修改。建立者可以在「設定 → 行程」取消封存。', archived: true }); return null; }
    return { trip, actor: actorOf(req) };
  }
  function tripByShareToken(req, res) {
    const found = requireGuestLink(req, res, '此分享連結為唯讀，無法儲存變更');
    if (found && found.trip.archived) { res.status(403).json({ error: '這個行程已封存，只能看、不能修改。建立者可以在「設定 → 行程」取消封存。', archived: true }); return null; }
    return found && { trip: found.trip, actor: actorOf(req, found.link), guest: true };
  }

  // 只比帳目內容；createdBy／updatedBy 由伺服器寫入，訪客看到的又是遮蔽過的，不能拿來比
  function sameContent(kind, a, b) {
    if (!a || !b) return !a && !b;
    const shares = (list) => list.map((p) => [p.userId, p.amount]);
    const pick = kind === 'expenses'
      ? (e) => [e.description, e.amount, e.currency, e.amountInBase, shares(e.payers), shares(e.participants), e.createdAt]
      : (d) => [d.payerId, d.collectorId, d.amount, d.currency, d.amountInBase, d.note, d.createdAt];
    return JSON.stringify(pick(a)) === JSON.stringify(pick(b));
  }
  /** 有衝突時寫好 409 並回傳 true；next 是這次要寫入的內容（刪除時是 null） */
  function conflictResponse(req, res, kind, trip, existing, next, guest) {
    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'base') || body.restore === true) return false;
    const repair = kind === 'expenses' ? storage.repairExpense : storage.repairDeposit;
    const base = body.base && typeof body.base === 'object' ? repair(body.base, undefined, trip.baseCurrency) : null;
    // 已經是這次要寫的內容（上次其實有存到、只是沒收到回應）：不算衝突
    if (sameContent(kind, existing, base) || (next && sameContent(kind, existing, next))) return false;
    res.status(409).json({
      error: existing ? '這筆剛被改過，請重新整理後再試一次' : '這筆已經被刪除',
      conflict: existing ? 'changed' : 'deleted',
      current: existing && guest ? storage.toGuestExpense(existing) : existing,
    });
    return true;
  }

  const KINDS = {
    expenses: {
      validate: validateExpenseEntry,
      repair: (e, trip, existing, guest, restore) => ({
        ...storage.repairExpense(e, undefined, trip.baseCurrency),
        // 建立者沿用第一次寫入時的值，之後編輯不會改掉；🔒 訪客新增的不能自稱是某個 Discord 使用者
        createdBy: existing ? existing.createdBy : newCreatedBy(e, guest, trip, restore),
      }),
    },
    deposits: {
      validate: validateDepositEntry,
      repair: (d, trip) => storage.repairDeposit(d, undefined, trip.baseCurrency),
    },
  };

  function newCreatedBy(e, guest, trip, restore) {
    const v = str(e.createdBy, 64) || 'web-ui';
    if (!guest || !(isSnowflake(v) || v === 'discord')) return v;
    // 訪客還原刪掉的支出：createdBy 是遮蔽過的 'discord'，從伺服器的操作紀錄找回原本的記帳者
    if (v === 'discord' && restore) return storage.findRemovedExpenseCreator(trip.id, e.id) || 'web-ui';
    return 'web-ui';
  }

  function writerIdOf(req) {
    const w = req.body && req.body.writerId;
    return typeof w === 'string' ? w.slice(0, 64) : null;
  }

  function commit(trip, req, actor) {
    const prevUpdatedAt = typeof trip.updatedAt === 'number' ? trip.updatedAt : null;
    const meta = { writerId: writerIdOf(req), actor };
    if (req.body && req.body.restore === true) meta.reason = { type: 'restore-entry' };
    storage.touchTrip(trip, meta);
    storage.persist();
    return { prevUpdatedAt, updatedAt: trip.updatedAt };
  }

  function mount(base, resolveTrip) {
    for (const [kind, spec] of Object.entries(KINDS)) {
      router.put(`${base}/${kind}/:entryId`, (req, res) => {
        const resolved = resolveTrip(req, res);
        if (!resolved) return;
        const { trip, actor, guest } = resolved;
        const entryId = req.params.entryId;
        if (!isSafeId(entryId)) return res.status(400).json({ error: '資料 ID 格式錯誤' });
        const list = trip[kind];
        const index = list.findIndex((x) => x.id === entryId);
        const existing = index === -1 ? null : list[index];

        // 還原刪掉的那筆：內容一律用伺服器操作紀錄裡刪除前的版本，前端送來的內容不採用
        // （只能原樣還原，不能夾帶修改還掛著原本記帳者的名字）
        const restoringDeleted = !!(req.body && req.body.restore === true) && !existing;
        let raw = req.body && req.body.entry;
        let removed = null;
        if (restoringDeleted) {
          removed = storage.findRemovedEntry(trip.id, entryId, kind === 'expenses' ? 'expense' : 'deposit');
          if (!removed) return res.status(404).json({ error: '紀錄裡找不到這筆刪掉的帳目，沒辦法還原' });
          raw = { ...removed };
          delete raw.id;
          delete raw.updatedBy;
        }
        const error = spec.validate(raw, trip);
        if (error) return res.status(400).json({ error: restoringDeleted ? `沒辦法還原：${error}` : error });
        if (!existing && list.length >= storage.MAX_ENTRIES) {
          return res.status(400).json({ error: `這個行程的資料已達上限（最多 ${storage.MAX_ENTRIES} 筆）` });
        }
        // 編輯時沒帶日期就沿用原本的（不然會被當成「現在」，日期悄悄變掉）
        const withDate = existing && raw.createdAt === undefined ? { ...raw, createdAt: existing.createdAt } : raw;
        const entry = { ...spec.repair({ ...withDate, id: entryId }, trip, existing, guest, req.body.restore === true), id: entryId };
        if (conflictResponse(req, res, kind, trip, existing, entry, guest)) return;
        // 誰記的、誰改過：依這次請求的身分寫入，不信前端送來的值
        if (restoringDeleted) {
          // 記帳者沿用刪除前的值，這次還原的人記成「改過」
          const who = storage.actorAccountId(actor);
          const original = typeof removed.createdBy === 'string' ? removed.createdBy : null;
          if (original) entry.createdBy = original;
          else if (kind === 'expenses') entry.createdBy = who && who !== 'guest' ? who : 'web-ui';
          else delete entry.createdBy;
          if (who) entry.updatedBy = who;
          else delete entry.updatedBy;
        } else {
          storage.stampAuthors(existing ? [existing] : [], [entry], actor);
        }
        // 較新版本的程式寫下、這個版本不認得的欄位接回去（見 storage.preserveUnknownFields）
        storage.preserveUnknownEntryFields(kind, existing, entry);
        if (index === -1) list.push(entry);
        else list[index] = entry;

        // 🔒 訪客的回應不帶記帳者的帳號（支出、轉帳都一樣）
        const shown = guest ? storage.toGuestExpense(entry) : entry;
        res.json({ entry: shown, ...commit(trip, req, actor) });
      });

      router.delete(`${base}/${kind}/:entryId`, (req, res) => {
        const resolved = resolveTrip(req, res);
        if (!resolved) return;
        const { trip, actor, guest } = resolved;
        const index = trip[kind].findIndex((x) => x.id === req.params.entryId);
        if (index === -1) {
          const v = typeof trip.updatedAt === 'number' ? trip.updatedAt : null;
          return res.json({ deleted: false, prevUpdatedAt: v, updatedAt: v });
        }
        if (conflictResponse(req, res, kind, trip, trip[kind][index], null, guest)) return;
        trip[kind].splice(index, 1);
        res.json({ deleted: true, ...commit(trip, req, actor) });
      });
    }
  }

  mount('/trip/:tripId', tripByTripId);
  mount('/shared-trip/:token', tripByShareToken);

  return router;
};
