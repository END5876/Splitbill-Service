'use strict';
/**
 * 身分辨識與存取權限，集中管理「誰可以存取/寫入哪個行程」，供 routes/*.js 共用。
 *
 * 🆕 [行程獨立化] 呼叫者（req.principal）有三種：
 *   service  持有 SPLITBILL_API_KEY 的呼叫端（Mousebot、維運）。
 *            帶 x-actor-id（Discord 使用者 ID）時代表「Bot 替這位使用者操作」，
 *            權限依該使用者在行程裡的身分判斷；不帶則視為管理端（admin）。
 *   user     用 Discord 登入網頁的使用者（簽章 cookie，見 lib/session.js）。
 *   share    分享連結 token（放在 x-api-key header，沿用舊網頁的做法）。
 *
 * 權限等級（由低到高）：
 *   read   唯讀分享連結
 *   write  可編輯分享連結
 *   member 行程成員：members 裡有一位 discordId＝自己的成員
 *   owner  行程建立者（ownerId），或 OWNER_USER_ID 名單內的 Bot 擁有者
 *   admin  service 且未宣告操作者
 * 每個端點只宣告「最低需要哪一級」，判斷全部集中在 tripAccessLevel()。
 * 權限永遠依「當下」的行程資料即時判斷，session 本身不帶任何權限。
 */
const crypto = require('crypto');
const session = require('./session');

const LEVEL_RANK = { read: 1, write: 2, member: 3, owner: 4, admin: 5 };
const SNOWFLAKE_RE = /^\d{17,20}$/;

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
 * 加上 cookie 本身是 SameSite=Lax，兩層一起擋。用 header 帶憑證的呼叫端（Bot、
 * 分享連結）不吃 cookie，不受 CSRF 影響。
 */
function createIdentityMiddleware(apiKey) {
  return function identityMiddleware(req, res, next) {
    req.principal = null;
    const provided = req.get('x-api-key');
    if (provided) {
      if (apiKey && safeEqual(provided, apiKey)) {
        const actor = (req.get('x-actor-id') || '').trim();
        req.principal = { kind: 'service', actorId: SNOWFLAKE_RE.test(actor) ? actor : null };
      } else {
        req.principal = { kind: 'share', token: provided };
      }
      return next();
    }

    const user = session.readSession(req);
    if (user) {
      if (MUTATING.has(req.method) && req.get('x-requested-with') !== 'splitbill') {
        return res.status(403).json({ error: '缺少 CSRF 標頭，請重新整理頁面再試一次' });
      }
      req.principal = { kind: 'user', userId: user.userId, name: user.name, avatar: user.avatar };
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
   */
  function tripAccessLevel(authCtx, trip) {
    const p = authCtx && authCtx.principal;
    if (!p || !trip) return null;
    if (p.kind === 'service' && !p.actorId) return 'admin';
    if (p.kind === 'share') {
      const link = (trip.shareLinks || []).find((l) => safeEqual(l.token, p.token));
      if (!link || storage.isShareLinkExpired(link)) return null;
      return link.permission === 'write' ? 'write' : 'read';
    }
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
    } else if (!level && p.kind === 'share') {
      const link = (trip.shareLinks || []).find((l) => safeEqual(l.token, p.token));
      res.status(403).json({ error: link ? '此分享連結已過期或已被撤銷，請跟建立連結的人索取新的連結' : '沒有權限存取此行程' });
    } else if (!level) {
      res.status(403).json({ error: '你不是這個行程的成員' });
    } else if (needed === 'write') {
      res.status(403).json({ error: '此分享連結為唯讀，無法儲存變更' });
    } else if (needed === 'admin') {
      res.status(403).json({ error: '此操作僅限管理端執行' });
    } else {
      res.status(403).json({ error: '此操作僅限行程建立者執行' });
    }
    return false;
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
   * 不針對特定行程的共用工具端點（即時匯率、帳單辨識）：Bot、登入的使用者，
   * 或任何一把尚未過期的分享連結。requireWrite=true 時分享連結必須是可編輯。
   */
  function hasUtilityAccess(req, requireWrite) {
    const p = req.principal;
    if (!p) return false;
    if (p.kind === 'service' || p.kind === 'user') return true;
    const found = storage.findTripByShareToken(p.token);
    if (!found || storage.isShareLinkExpired(found.shareLink)) return false;
    return !requireWrite || found.shareLink.permission === 'write';
  }

  return {
    LEVEL_RANK,
    tripAccessLevel,
    hasTripAccess,
    requireTripAccess,
    requireService,
    requireAdmin: requireService, // 舊名稱相容
    requireUser,
    canLinkMembers,
    hasUtilityAccess,
    principalUserId,
    userRoleInTrip,
  };
}

module.exports = {
  createIdentityMiddleware,
  createAuthHelpers,
  LEVEL_RANK,
  OWNER_USER_IDS,
  principalUserId,
  userRoleInTrip,
};
