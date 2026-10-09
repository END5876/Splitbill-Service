'use strict';
const express = require('express');
const session = require('../lib/session');
const { createRateLimiter } = require('../lib/rateLimit');

// 🆕 [行程獨立化] 以「使用者」為中心的端點：我是誰、我有哪些行程、建立新行程。
// 網頁登入者與 Bot（宣告 x-actor-id）共用同一組端點與同一套規則。

const TRIP_LIMIT_PER_OWNER = Number(process.env.SPLITBILL_TRIP_LIMIT_PER_USER) || 100;
const createLimiter = createRateLimiter({ limit: 10, windowMs: 10 * 60 * 1000 });
const CURRENCY_RE = /^[A-Z]{2,6}$/;

function cleanName(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

module.exports = function createMeRouter(ctx) {
  const { storage, requireUser, userRoleInTrip } = ctx;
  const router = express.Router();

  // ---- GET /api/me：目前登入的 Discord 使用者（沒登入回 user:null） ----
  router.get('/me', (req, res) => {
    const p = req.principal;
    res.json({
      oauth: session.isEnabled() && !!process.env.DISCORD_CLIENT_ID,
      user: p && p.kind === 'user' ? { id: p.userId, name: p.name, avatar: p.avatar } : null,
    });
  });

  // ---- GET /api/my/trips：我擁有或參與的行程（依最近更新排序） ----
  // 管理端（金鑰、未宣告操作者）列出全部行程，方便維運。
  router.get('/my/trips', (req, res) => {
    const p = req.principal;
    let trips;
    if (p && p.kind === 'service' && !p.actorId) {
      trips = storage.listTrips().map((t) => ({ ...storage.toTripSummary(t), role: 'admin' }));
    } else {
      const uid = requireUser(req, res);
      if (!uid) return;
      trips = storage.listTrips()
        .map((t) => ({ trip: t, role: userRoleInTrip(uid, t) }))
        // OWNER_USER_ID 對所有行程都有 owner 權限，但「我的行程」只列自己真正參與的
        .filter(({ trip, role }) => role && (trip.ownerId === uid || trip.members.some((m) => m.discordId === uid)))
        .map(({ trip, role }) => ({ ...storage.toTripSummary(trip), role }));
    }
    trips.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ trips });
  });

  // ---- POST /api/trips：建立新行程 ----
  // body: { name, baseCurrency?, rates?, memberName?, guildId?, content?, selfMemberId? }
  //   - 網頁登入者：建立未綁定的行程，自己是建立者，也是第一位（已連結的）成員
  //     content＝{ members, expenses, deposits }：把畫面上離線編輯／匯入的行程整份
  //     上傳成新的雲端行程。selfMemberId 指定其中哪一位是自己（會連結到自己的
  //     Discord 帳號）；沒指定則另外加一位「自己」。其他成員一律是未連結。
  //   - Bot（金鑰＋x-actor-id）：額外必須帶 guildId，建立後直接綁在該伺服器
  //     （Bot 是在該伺服器的面板裡建立的，伺服器身分由 Discord 保證）
  router.post('/trips', (req, res) => {
    try {
      const uid = requireUser(req, res);
      if (!uid) return;
      const p = req.principal;
      const body = (req.body && typeof req.body === 'object') ? req.body : {};

      const name = cleanName(body.name, 60);
      if (!name) return res.status(400).json({ error: '請輸入行程名稱' });
      const baseCurrency = cleanName(body.baseCurrency || 'TWD', 6).toUpperCase();
      if (!CURRENCY_RE.test(baseCurrency)) return res.status(400).json({ error: '基準幣別格式錯誤（2～6 個英文字母）' });

      let guildId = null;
      if (p.kind === 'service') {
        if (!storage.isSnowflake(body.guildId)) return res.status(400).json({ error: '缺少或錯誤的 guildId' });
        guildId = body.guildId;
      } else if (body.guildId) {
        return res.status(400).json({ error: '網頁建立的行程請之後再用綁定碼綁定到 Discord 伺服器' });
      }

      if (p.kind === 'user') {
        const r = createLimiter.take(uid);
        if (!r.ok) return res.status(429).json({ error: '建立行程太頻繁了，請稍後再試' });
        const owned = storage.listTrips().filter((t) => t.ownerId === uid).length;
        if (owned >= TRIP_LIMIT_PER_OWNER) {
          return res.status(400).json({ error: `每人最多建立 ${TRIP_LIMIT_PER_OWNER} 個行程，請先刪除不需要的行程` });
        }
      }

      const rates = { [baseCurrency]: 1 };
      if (body.rates && typeof body.rates === 'object') {
        for (const [cur, rate] of Object.entries(body.rates)) {
          if (CURRENCY_RE.test(cur) && cur !== baseCurrency && typeof rate === 'number' && rate > 0 && Number.isFinite(rate)) {
            rates[cur] = rate;
          }
        }
      }

      const memberName = cleanName(body.memberName, 60) || (p.kind === 'user' ? p.name : '') || '我';
      let tripId;
      do { tripId = storage.genId('trip'); } while (storage.getTrip(tripId));

      let members = [{ id: storage.genId('mem'), name: memberName, discordId: uid }];
      let expenses = [];
      let deposits = [];
      const content = p.kind === 'user' && body.content && typeof body.content === 'object' ? body.content : null;
      if (content) {
        // 🔒 匯入的成員一律先去掉 discordId（網頁不能替人連結），再只把 selfMemberId 連到自己
        members = storage.repairMembers((Array.isArray(content.members) ? content.members : []).slice(0, 100)
          .map((m) => (m && typeof m === 'object' ? { id: m.id, name: m.name } : m)));
        const self = members.find((m) => m.id === body.selfMemberId);
        if (self) self.discordId = uid;
        else members.push({ id: storage.genId('mem'), name: memberName, discordId: uid });
        expenses = Array.isArray(content.expenses) ? content.expenses.slice(0, 5000) : [];
        deposits = Array.isArray(content.deposits) ? content.deposits.slice(0, 5000) : [];
      }

      const trip = storage.repairTrip({
        id: tripId,
        name,
        baseCurrency,
        rates,
        ownerId: uid,
        members,
        expenses,
        deposits,
        createdAt: Date.now(),
      });
      storage.setTrip(trip);
      if (guildId) storage.attachTripToGuild(trip, guildId);
      storage.touchTrip(trip);
      storage.persist();
      res.status(201).json(storage.toPublicTrip(trip));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

