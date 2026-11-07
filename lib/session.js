'use strict';
/**
 * 🆕 [Discord 登入] 無狀態的簽章 cookie session。
 *
 * cookie 內容是 base64url(JSON) + "." + HMAC-SHA256 簽章，伺服器不需要另外存
 * session 表，重新部署也不會讓大家被登出。簽章金鑰來自 SESSION_SECRET；沒有
 * 設定時整個登入功能停用（isEnabled() 回傳 false），不會退回用固定金鑰簽章。
 *
 * 這裡只負責「證明你是哪個帳號」，完全不帶任何權限資訊——權限一律
 * 在每次請求時依行程資料（ownerId、members[].discordId／lineId）即時判斷，見 lib/auth.js。
 *
 * 🆕 [LINE 登入] cookie 裡的 uid 是「實際登入的帳號」（Discord ID 或 line:U…）。
 * readSession() 每次都經過帳號綁定表轉成主身分（setAccountResolver，由 server.js 接上 storage），
 * 所以綁定／解除綁定立刻生效，不用重新登入。
 */
const crypto = require('crypto');

const SESSION_COOKIE = 'sb_session';
const STATE_COOKIE = 'sb_oauth_state';
const LINK_PENDING_COOKIE = 'sb_link_pending';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const STATE_TTL_MS = 10 * 60 * 1000;             // OAuth 來回 10 分鐘內要完成
const LINK_PENDING_TTL_MS = 10 * 60 * 1000;      // 帳號綁定「等使用者確認合併」最多 10 分鐘

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

// 🔒 登入 cookie 用 SameSite=Strict（與音樂庫相同）：別的網站連過來（包含頂層導覽）都不會帶上。
// 網頁本身（index.html）不需要登入，開啟後的 /api 請求是同站的，所以從 Discord 點連結進來不受影響。
// 只有 OAuth state 用 Lax：Discord／LINE 導回 callback 是跨站的頂層導覽，Strict 的話瀏覽器不會帶上。
// state cookie 只送到該平台的 /auth/<平台>（callback 在底下），兩個平台的登入流程互不干擾。
const PROVIDERS = new Set(['discord', 'line']);
function stateCookieOpts(prov) {
  return { sameSite: 'Lax', path: `/auth/${PROVIDERS.has(prov) ? prov : 'discord'}` };
}

function cookieString(name, value, maxAgeMs, { sameSite = 'Strict', path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`];
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

// 🆕 [LINE 登入] 登入身分 → 主身分（帳號綁定）。沒接上時（測試直接 require）就是自己。
let accountResolver = (id) => id;

function setAccountResolver(fn) {
  accountResolver = typeof fn === 'function' ? fn : (id) => id;
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
  const provider = p.prov === 'line' ? 'line' : 'discord';
  return {
    userId: accountResolver(p.uid) || p.uid,
    loginId: p.uid,
    provider,
    name: p.name || '',
    avatar: p.avatar || null,
    sid: p.sid,
    exp: p.exp,
  };
}

/** @param {{ id: string, name?: string, avatar?: string|null, provider?: 'discord'|'line' }} user */
function writeSession(res, user) {
  const token = sign({
    t: 's',
    sid: crypto.randomBytes(16).toString('hex'),
    uid: user.id,
    prov: user.provider === 'line' ? 'line' : 'discord',
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

/**
 * @param {object} [extra] 🆕 [LINE 登入] 帳號綁定模式：{ prov, link: { sid, uid } }——
 *   發起綁定的是哪個 session、哪個帳號，callback 回來時要對得上才綁。
 */
function writeOAuthState(res, state, next, extra = {}) {
  const prov = PROVIDERS.has(extra.prov) ? extra.prov : 'discord';
  const payload = { t: 'o', state, next, prov, exp: Date.now() + STATE_TTL_MS };
  if (extra.link) payload.link = { sid: String(extra.link.sid), uid: String(extra.link.uid) };
  appendCookie(res, cookieString(STATE_COOKIE, sign(payload), STATE_TTL_MS, stateCookieOpts(prov)));
}

function readOAuthState(req) {
  const p = verify(parseCookies(req)[STATE_COOKIE]);
  return p && p.t === 'o' ? p : null;
}

function clearOAuthState(res, prov = 'discord') {
  appendCookie(res, cookieString(STATE_COOKIE, '', 0, stateCookieOpts(prov)));
}

// ── 🆕 [LINE 登入] 帳號綁定等待確認 ──
// 要綁定的 LINE 帳號名下已經有行程時，不直接合併：先把「誰要綁誰」簽章後存在 cookie，
// 導回網頁讓使用者看過會受影響的行程再確認。綁在發起的 session 上，換人登入就失效。
function writeLinkPending(res, { sid, primary, alias, aliasName }) {
  const payload = { t: 'l', sid, primary, alias, aliasName: String(aliasName || '').slice(0, 60), exp: Date.now() + LINK_PENDING_TTL_MS };
  appendCookie(res, cookieString(LINK_PENDING_COOKIE, sign(payload), LINK_PENDING_TTL_MS));
}

/** 讀取等待確認的綁定；必須是同一個 session 發起的，否則回傳 null。 */
function readLinkPending(req, sid) {
  const p = verify(parseCookies(req)[LINK_PENDING_COOKIE]);
  if (!p || p.t !== 'l' || !sid || p.sid !== sid) return null;
  return { primary: p.primary, alias: p.alias, aliasName: p.aliasName || '' };
}

function clearLinkPending(res) {
  appendCookie(res, cookieString(LINK_PENDING_COOKIE, '', 0));
}

module.exports = {
  isEnabled,
  setAccountResolver,
  writeLinkPending,
  readLinkPending,
  clearLinkPending,
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
