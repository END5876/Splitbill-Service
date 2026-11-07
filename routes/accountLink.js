'use strict';
const express = require('express');
const session = require('../lib/session');
const { createRateLimiter } = require('../lib/rateLimit');
const { isLineId, memberAccountId } = require('../lib/accounts');

// ════════════════════════════════════════════════════════════════
// 🆕 [帳號綁定] Discord 帳號 ⇄ LINE 帳號。
// 綁定本身由 /auth/<平台>/login?link=1 發起（要用另一個平台登入一次，證明兩個帳號都是你的，
// 見 routes/oauth.js）。LINE 帳號名下沒有行程時 callback 直接綁好；有行程時先存成「等待確認」，
// 由這裡的端點讓使用者看過影響再確認合併。
//
// 端點（都需要登入；寫入請求的 CSRF 檢查在 lib/auth.js）：
//   GET    /api/account-link/pending   等待確認的綁定：要綁的帳號、會受影響的行程
//   POST   /api/account-link/confirm   確認：綁定並合併行程
//   POST   /api/account-link/cancel    取消
//   DELETE /api/account-link           解除綁定（行程留在 Discord 帳號名下）
// ════════════════════════════════════════════════════════════════

const limiter = createRateLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });

module.exports = function createAccountLinkRouter(ctx) {
  const { storage } = ctx;
  const router = express.Router();

  function requireWebUser(req, res) {
    const p = req.principal;
    if (p && p.kind === 'user') return p;
    if (!p) res.status(401).json({ error: '請先登入', needLogin: true });
    else res.status(403).json({ error: '帳號綁定只能在網頁上操作' });
    return null;
  }

  function limited(req, res, p) {
    if (limiter.take(p.loginId || p.userId).ok) return false;
    res.status(429).json({ error: '操作太頻繁了，請稍後再試' });
    return true;
  }

  /**
   * 讀取這個 session 等待確認的綁定，並確認它現在還成立（期間可能已經從別的裝置綁定或解除過）。
   * 不成立時清掉 cookie，回傳 null。
   */
  function loadPending(req, res, p) {
    const pending = session.readLinkPending(req, p.sid);
    if (!pending) return null;
    // 發起者必須還是同一個人：主身分或被綁的那一方
    const stillMine = p.userId === pending.primary || p.userId === pending.alias;
    const existing = storage.getAccountLink(pending.alias);
    if (!stillMine || existing || storage.listAccountAliases(pending.primary).length) {
      session.clearLinkPending(res);
      return null;
    }
    return pending;
  }

  /** 合併會影響哪些行程（給確認畫面）。 */
  function previewMerge(primary, alias) {
    return storage.listAccountTrips(alias).map((t) => {
      const trip = storage.peekTrip(t.id);
      const conflict = !!t.memberName && trip.members.some((m) => memberAccountId(m) === primary);
      return { name: t.name, owner: t.owner, memberName: t.memberName, willUnlink: conflict };
    });
  }

  router.get('/account-link/pending', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const p = requireWebUser(req, res);
    if (!p) return;
    const pending = loadPending(req, res, p);
    if (!pending) return res.json({ pending: null });
    res.json({
      pending: {
        provider: 'line',
        aliasName: pending.aliasName,
        trips: previewMerge(pending.primary, pending.alias),
      },
    });
  });

  router.post('/account-link/confirm', (req, res) => {
    const p = requireWebUser(req, res);
    if (!p || limited(req, res, p)) return;
    const pending = loadPending(req, res, p);
    if (!pending) return res.status(409).json({ error: '這次綁定已經逾時，請重新綁定一次' });
    let result;
    try {
      result = storage.linkAccounts(pending.primary, pending.alias, {
        actor: { kind: 'user', userId: pending.primary, name: p.name },
      });
    } catch (err) {
      if (err.code) {
        session.clearLinkPending(res);
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
    session.clearLinkPending(res);
    res.json({ ok: true, merged: result.trips.map((t) => ({ name: t.name, unlinkedMember: t.unlinkedMember })) });
  });

  router.post('/account-link/cancel', (req, res) => {
    const p = requireWebUser(req, res);
    if (!p) return;
    session.clearLinkPending(res);
    res.json({ ok: true });
  });

  router.delete('/account-link', (req, res) => {
    const p = requireWebUser(req, res);
    if (!p || limited(req, res, p)) return;
    const alias = storage.listAccountAliases(p.userId).map((a) => a.alias).find(isLineId);
    if (!alias) return res.status(404).json({ error: '目前沒有綁定任何 LINE 帳號' });
    storage.unlinkAccount(alias);
    // 用 LINE 登入的人解除之後，就變回一個沒有任何行程的 LINE 帳號（session 不用重發，下一個請求就生效）
    res.json({ ok: true, nowAccount: p.loginId === alias ? 'line' : 'discord' });
  });

  return router;
};
