'use strict';
/**
 * 身分辨識與存取權限，集中管理「誰可以存取/寫入哪個行程」，供 routes/*.js 共用。
 *
 * 🆕 [行程獨立化] 呼叫者（req.principal）有兩種：
 *   service  持有 SPLITBILL_API_KEY 的呼叫端（Mousebot、維運腳本）。網頁不使用金鑰。
 *            帶 x-actor-id（Discord 使用者 ID）時代表「Bot 替這位使用者操作」，
 *            權限依該使用者在行程裡的身分判斷；不帶則視為管理端（admin）。
 *   user     用 Discord 登入網頁的使用者（簽章 cookie，見 lib/session.js）。
 * 行程連結不是 principal：訪客的 token 只放在網址路徑 /api/shared-trip/:token/...，
 * 由 requireGuestLink() 驗證（x-api-key 只代表金鑰，不再兼當分享 token）。
 * 連結的「加入成為成員」只是一次性的認領動作（routes/links.js），認領後就是一般成員。
 *
 * 權限等級（由低到高）：
 *   read   訪客唯讀連結（只出現在 /api/shared-trip 路徑）
 *   write  訪客可編輯連結（同上）
 *   member 行程成員：members 裡有一位 discordId＝自己的成員
 *   owner  行程建立者（ownerId），或 OWNER_USER_ID 名單內的 Bot 擁有者
 *   admin  service 且未宣告操作者
 * 每個端點只宣告「最低需要哪一級」，判斷全部集中在 tripAccessLevel()。
 * 權限永遠依「當下」的行程資料即時判斷，session 本身不帶任何權限。
 */
const crypto = require('crypto');
const session = require('./session');
const { isSnowflake } = require('./snowflake');

const LEVEL_RANK = { read: 1, write: 2, member: 3, owner: 4, admin: 5 };

const OWNER_USER_IDS = new Set(
  (process.env.OWNER_USER_ID || '').split(',').map((s) => s.trim()).filter(Boolean)
);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 辨認呼叫者，結果記在 req.principal；這裡不拒絕任何請求（匿名也放行），
 * 存取範圍一律由各路由的 requireTripAccess()／requireService()／requireUser() 判斷。
 *
 * 🔒 CSRF：以 cookie 登入的寫入請求必須帶 x-requested-with: splitbill。
 * 瀏覽器的跨站表單無法自訂 header（要自訂就得先過 CORS 預檢，而這裡沒有開 CORS），
 * 加上 cookie 本身是 SameSite=Strict，而且瀏覽器標示為跨站（Sec-Fetch-Site: cross-site）的請求
 * 一律不認 cookie（與音樂庫相同），三層一起擋。用 header 帶金鑰的 Bot 不吃 cookie，不受 CSRF 影響。
 */
function createIdentityMiddleware(apiKey) {
  return function identityMiddleware(req, res, next) {
    req.principal = null;
    const provided = req.get('x-api-key');
    if (provided) {
      // 金鑰錯誤直接拒絕，不退回當成匿名或其他身分，讓設定錯誤立刻浮現
      if (!apiKey || !safeEqual(provided, apiKey)) {
        return res.status(401).json({ error: 'API 金鑰錯誤' });
      }
      const actor = (req.get('x-actor-id') || '').trim();
      req.principal = { kind: 'service', actorId: isSnowflake(actor) ? actor : null };
      return next();
    }

    // 跨站請求當作沒登入（不擋請求本身：分享連結的訪客路徑不需要 cookie）
    const user = req.get('sec-fetch-site') === 'cross-site' ? null : session.readSession(req);
    if (user) {
      if (MUTATING.has(req.method) && req.get('x-requested-with') !== 'splitbill') {
        return res.status(403).json({ error: '缺少 CSRF 標頭，請重新整理頁面再試一次' });
      }
      req.principal = { kind: 'user', userId: user.userId, name: user.name, avatar: user.avatar, sid: user.sid };
    }
    next();
  };
}

/** 呼叫者代表的 Discord 使用者 ID（網頁登入者，或 Bot 宣告的操作者）；沒有則 null。 */
function principalUserId(principal) {
  if (!principal) return null;
  if (principal.kind === 'user') return principal.userId;
  if (principal.kind === 'service') return principal.actorId;
  return null;
}

function isBotOwner(userId) {
  return !!userId && OWNER_USER_IDS.has(userId);
}

/** 某位 Discord 使用者在行程中的身分：'owner' | 'member' | null（不看分享連結）。 */
function userRoleInTrip(userId, trip) {
  if (!userId || !trip) return null;
  if ((trip.ownerId && trip.ownerId === userId) || isBotOwner(userId)) return 'owner';
  if ((trip.members || []).some((m) => m.discordId === userId)) return 'member';
  return null;
}

function createAuthHelpers({ storage }) {
  /**
   * 回傳這次請求對指定行程擁有的權限等級；完全沒有權限回傳 null。
   * authCtx 可以是 express req，也可以是 SSE 票券（同樣帶 principal）。
   * 訪客連結不經過這裡，見 requireGuestLink()。
   */
  function tripAccessLevel(authCtx, trip) {
    const p = authCtx && authCtx.principal;
    if (!p || !trip) return null;
    if (p.kind === 'service' && !p.actorId) return 'admin';
    return userRoleInTrip(principalUserId(p), trip);
  }

  function hasTripAccess(authCtx, trip, needed) {
    const level = tripAccessLevel(authCtx, trip);
    return !!level && LEVEL_RANK[level] >= LEVEL_RANK[needed];
  }

  /**
   * 檢查權限是否至少達到 needed；不足時直接寫好錯誤回應並回傳 false，呼叫端應立即 return。
   * @param {'read'|'write'|'member'|'owner'|'admin'} needed
   */
  function requireTripAccess(authCtx, res, trip, needed) {
    const level = tripAccessLevel(authCtx, trip);
    if (level && LEVEL_RANK[level] >= LEVEL_RANK[needed]) return true;

    const p = authCtx && authCtx.principal;
    if (!p) {
      res.status(401).json({ error: '請先登入', needLogin: true });
    } else if (!level) {
      res.status(403).json({ error: '你不是這個行程的成員' });
    } else if (needed === 'admin') {
      res.status(403).json({ error: '此操作僅限管理端執行' });
    } else {
      res.status(403).json({ error: '此操作僅限行程建立者執行' });
    }
    return false;
  }

  /**
   * 訪客路徑（/api/shared-trip/:token/...）共用的 token 檢查：token 本身就是憑證，
   * 而且連結必須開放訪客存取（guest 不是 'none'）。
   * 不通過時直接寫好錯誤回應並回傳 null，呼叫端應立即 return。
   * @param {string|null} [writeDeniedMsg] 需要可編輯權限時，唯讀連結看到的錯誤訊息；省略＝唯讀即可
   * @returns {{ trip: object, link: object } | null}
   */
  function requireGuestLink(req, res, writeDeniedMsg = null) {
    const found = storage.findTripByLinkToken(req.params.token);
    if (!found) {
      res.status(404).json({ error: '這個連結不存在，可能已經被撤銷或網址有誤' });
      return null;
    }
    if (storage.isLinkExpired(found.link)) {
      res.status(403).json({ error: '這個連結已經過期，請跟建立連結的人索取新的連結' });
      return null;
    }
    if (found.link.guest === 'none') {
      res.status(403).json({ error: '這個連結需要用 Discord 登入、加入行程後才能使用', needLogin: true });
      return null;
    }
    if (writeDeniedMsg && found.link.guest !== 'write') {
      res.status(403).json({ error: writeDeniedMsg });
      return null;
    }
    return found;
  }

  /** 只接受持有 SPLITBILL_API_KEY 的呼叫端（Bot 專用端點）。 */
  function requireService(req, res) {
    if (req.principal && req.principal.kind === 'service') return true;
    res.status(403).json({ error: '此操作僅限 Bot／管理端執行' });
    return false;
  }

  /** 需要「某位 Discord 使用者」的端點：網頁登入者，或 Bot 宣告了操作者。 */
  function requireUser(req, res) {
    const uid = principalUserId(req.principal);
    if (uid) return uid;
    if (!req.principal) res.status(401).json({ error: '請先用 Discord 登入', needLogin: true });
    else res.status(403).json({ error: '這個操作需要 Discord 身分' });
    return null;
  }

  /**
   * 這次請求能不能替成員寫入 discordId（見 lib/members.js）。只有 Bot 可以——
   * 它加進來的 Discord 帳號是 Discord 本身的使用者選單驗證過的。
   */
  function canLinkMembers(req) {
    return !!req.principal && req.principal.kind === 'service';
  }

  /**
   * 這次寫入是誰做的，交給 storage.touchTrip() 的 meta.actor，用來寫操作紀錄（lib/activity.js）。
   * 訪客路徑沒有 principal，由呼叫端傳入找到的連結。
   */
  function actorOf(req, guestLink) {
    if (guestLink) return { kind: 'guest', linkLabel: guestLink.label || '' };
    const p = req && req.principal;
    if (!p) return null;
    if (p.kind === 'service') return p.actorId ? { kind: 'bot', userId: p.actorId } : { kind: 'admin' };
    if (p.kind === 'user') return { kind: 'user', userId: p.userId, name: p.name };
    return null;
  }

  return {
    LEVEL_RANK,
    actorOf,
    tripAccessLevel,
    hasTripAccess,
    requireTripAccess,
    requireGuestLink,
    requireService,
    requireAdmin: requireService, // 舊名稱相容
    requireUser,
    canLinkMembers,
    principalUserId,
    userRoleInTrip,
    isBotOwner,
  };
}

module.exports = {
  createIdentityMiddleware,
  isBotOwner,
  createAuthHelpers,
  LEVEL_RANK,
  OWNER_USER_IDS,
  principalUserId,
  userRoleInTrip,
};
