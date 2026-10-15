'use strict';
/**
 * 🆕 [Discord 登入] 無狀態的簽章 cookie session。
 *
 * cookie 內容是 base64url(JSON) + "." + HMAC-SHA256 簽章，伺服器不需要另外存
 * session 表，重新部署也不會讓大家被登出。簽章金鑰來自 SESSION_SECRET；沒有
 * 設定時整個登入功能停用（isEnabled() 回傳 false），不會退回用固定金鑰簽章。
 *
 * 這裡只負責「證明你是哪個 Discord 帳號」，完全不帶任何權限資訊——權限一律
 * 在每次請求時依行程資料（ownerId、members[].discordId）即時判斷，見 lib/auth.js。
 */
const crypto = require('crypto');

const SESSION_COOKIE = 'sb_session';
const STATE_COOKIE = 'sb_oauth_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const STATE_TTL_MS = 10 * 60 * 1000;             // OAuth 來回 10 分鐘內要完成

function getSecret() {
  const s = process.env.SESSION_SECRET || '';
  return s.length >= 32 ? s : '';
}

function isEnabled() {
  return !!getSecret();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac('sha256', getSecret()).update(body).digest());
  return `${body}.${mac}`;
}

function verify(token) {
  const secret = getSecret();
  if (!secret || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!Object.prototype.hasOwnProperty.call(out, k)) {
      try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
    }
  }
  return out;
}

function isSecureContext() {
  return /^https:\/\//i.test(process.env.PUBLIC_BASE_URL || '');
}

function cookieString(name, value, maxAgeMs) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isSecureContext()) parts.push('Secure');
  parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
  return parts.join('; ');
}

function appendCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : (prev ? [prev] : []);
  res.setHeader('Set-Cookie', [...list, value]);
}

// 🆕 [登出撤銷] 已登出的 session 記錄（由 server.js 接上 storage，見 storage.isSessionRevoked）。
// 沒接上時（例如測試直接 require 這個檔案來簽 cookie）視為沒有任何 session 被撤銷。
let revocationStore = { isRevoked: () => false, revoke: () => {} };

function setRevocationStore(store) {
  revocationStore = store;
}

function isSessionRevoked(sid) {
  return !!sid && revocationStore.isRevoked(sid);
}

/**
 * 讀取目前登入的使用者；沒登入、簽章不對或已經登出回傳 null。
 * 每個 session 都有自己的 sid，登出時只撤銷這一個（其他裝置不受影響）。
 * 沒有 sid 的舊版 cookie 無法撤銷，一律視為無效，重新登入一次即可。
 */
function readSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const p = verify(token);
  if (!p || p.t !== 's' || typeof p.uid !== 'string' || typeof p.sid !== 'string') return null;
  if (isSessionRevoked(p.sid)) return null;
  return { userId: p.uid, name: p.name || '', avatar: p.avatar || null, sid: p.sid, exp: p.exp };
}

function writeSession(res, user) {
  const token = sign({
    t: 's',
    sid: crypto.randomBytes(16).toString('hex'),
    uid: user.id,
    name: String(user.name || '').slice(0, 60),
    avatar: user.avatar || null,
    exp: Date.now() + SESSION_TTL_MS,
  });
  appendCookie(res, cookieString(SESSION_COOKIE, token, SESSION_TTL_MS));
}

/** 登出：撤銷這次請求帶的 session（就算 cookie 被複製走也不能再用），並清掉 cookie。 */
function revokeSession(req, res) {
  const s = readSession(req);
  if (s) revocationStore.revoke(s.sid, s.exp);
  clearSession(res);
}

function clearSession(res) {
  appendCookie(res, cookieString(SESSION_COOKIE, '', 0));
}

function writeOAuthState(res, state, next) {
  appendCookie(res, cookieString(STATE_COOKIE, sign({ t: 'o', state, next, exp: Date.now() + STATE_TTL_MS }), STATE_TTL_MS));
}

function readOAuthState(req) {
  const p = verify(parseCookies(req)[STATE_COOKIE]);
  return p && p.t === 'o' ? p : null;
}

function clearOAuthState(res) {
  appendCookie(res, cookieString(STATE_COOKIE, '', 0));
}

module.exports = {
  isEnabled,
  readSession,
  writeSession,
  clearSession,
  revokeSession,
  isSessionRevoked,
  setRevocationStore,
  writeOAuthState,
  readOAuthState,
  clearOAuthState,
  parseCookies,
};
