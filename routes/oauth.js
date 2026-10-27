'use strict';
const express = require('express');
const crypto = require('crypto');
const session = require('../lib/session');
const { isSnowflake } = require('../lib/snowflake');
const { clientIp, rateLimitKey } = require('../lib/clientIp');
const { alert } = require('../lib/alert');

// 🆕 [Discord 登入] OAuth2 授權碼流程（scope 只要 identify：只拿 Discord 使用者 ID、
// 名稱、頭像，不讀伺服器清單、不讀 email）。登入只證明身分，不授予任何權限。
// 行為與音樂庫（music-library-service 的 webplayer/webAuth.js）一致：同一個 Discord 應用程式、
// 同樣的 Cookie 規則、限流、換帳號；分帳沒有封鎖名單與主畫面 App 的代碼交接。
//
// 環境變數：
//   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET   Discord Developer Portal → OAuth2
//   PUBLIC_BASE_URL     網頁對外網址（例如 https://splitbill.app），用來組 redirect_uri；
//                       Discord 後台的 Redirects 要填 <PUBLIC_BASE_URL>/auth/discord/callback
//   SESSION_SECRET      至少 32 字元的隨機字串，用來簽 cookie
//   DISCORD_API_BASE / DISCORD_AUTHORIZE_URL    （測試用）覆寫 Discord 端點
//
// 路由（掛在 /auth 底下）：
//   GET  /auth/discord/login     ?next=<站內路徑>（&switch=1＝顯示同意畫面以便換帳號）→ 302 到 Discord 授權頁
//   GET  /auth/discord/callback  Discord 導回來：驗證 state、換 token → 設定 Cookie，用同站頁面跳回 next
//   POST /auth/logout            撤銷並清除 Cookie

// 指定 API 版本：不帶版本的 /api 會落到 Discord 的預設版本，哪天預設版本調整就可能壞掉
const API_BASE = (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, '');
const AUTHORIZE_URL = process.env.DISCORD_AUTHORIZE_URL || 'https://discord.com/oauth2/authorize';
const DISCORD_FETCH_TIMEOUT_MS = 10000; // Discord 卡住時讓使用者看到錯誤，而不是一直轉圈

// ── 登入失敗限流 ──
// 每次 callback 都會帶著 client secret 去 Discord 換 token；state 可以免費一直要，所以拿隨便的 code 灌 callback，
// 就能讓伺服器對 Discord 發出大量無效請求，害伺服器的 IP 被 Discord 限流（大家都登不進來；
// 音樂庫用同一個 Discord 應用程式，也會一起受影響）。
// 只計「換 token 失敗」的次數（正常登入不受影響）：每個來源 10 分鐘 10 次，全站 100 次。
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 10;
const GLOBAL_MAX_FAILS = 100;
const MAX_TRACKED_SOURCES = 10000;
// 每個帳號 1 小時內最多發出幾次登入（正常使用遠低於這個數；避免重複登入登出把已登出清單灌爆）
const MAX_ISSUE_PER_HOUR = 60;

function config() {
  const clientId = process.env.DISCORD_CLIENT_ID || '';
  const clientSecret = process.env.DISCORD_CLIENT_SECRET || '';
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!clientId || !clientSecret || !base || !session.isEnabled()) return null;
  return { clientId, clientSecret, redirectUri: `${base}/auth/discord/callback` };
}

/** 只允許站內相對路徑，避免被拿來當開放式重新導向（//evil、/\evil、夾控制字元都不行）。 */
function safeNext(v) {
  if (typeof v !== 'string' || !/^\/(?![/\\])/.test(v) || /[\x00-\x1f\x7f\\]/.test(v)) return '/';
  return v.slice(0, 500);
}

// 固定長度雜湊後再 timingSafeEqual，避免長度不同時洩漏資訊
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function avatarUrl(user) {
  return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;
}

// 登入流程中的小頁面（錯誤、跳轉）。內容全部經過 escapeHtml，body 由呼叫端組好（已跳脫）。
function sendPage(res, status, title, bodyHtml, { refresh } = {}) {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(refresh)}">` : ''}<title>${escapeHtml(title)}｜拆帳本</title>
<style>
:root{--ink:#1F2330;--ink-soft:#4F5566;--paper:#F2F3F7;--card:#FFFFFF;--line:#DCDFE8;--brass:#8A5A12;--on-brass:#FFFFFF}
@media (prefers-color-scheme:dark){:root{--ink:#F2F3F5;--ink-soft:#A8ACB4;--paper:#1E1F22;--card:#2B2D31;--line:#3F4147;--brass:#D6A646;--on-brass:#1E1F22}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:var(--paper);color:var(--ink);font-family:"Noto Sans TC",system-ui,sans-serif}
main{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;width:100%;max-width:360px;display:flex;flex-direction:column;gap:14px;text-align:center}
h1{font-size:18px;margin:0}p{color:var(--ink-soft);font-size:14px;line-height:1.6;margin:0}
a.btn{height:44px;border-radius:22px;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;text-decoration:none;background:var(--brass);color:var(--on-brass)}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${bodyHtml}</main></body></html>`);
}

const backLink = '<a class="btn" href="/">回到拆帳本</a>';

module.exports = function createOAuthRouter() {
  const router = express.Router();

  const failures = new Map(); // rateLimitKey → { count, resetAt }
  let globalFails = { count: 0, resetAt: Date.now() + FAIL_WINDOW_MS };
  function loginBlockedUntil(key, now) {
    const rec = failures.get(key);
    if (rec && rec.resetAt > now && rec.count >= MAX_FAILS) return rec.resetAt;
    if (globalFails.resetAt > now && globalFails.count >= GLOBAL_MAX_FAILS) return globalFails.resetAt;
    return 0;
  }
  function recordLoginFailure(key, now) {
    let rec = failures.get(key);
    if (!rec || rec.resetAt <= now) rec = { count: 0, resetAt: now + FAIL_WINDOW_MS };
    rec.count += 1;
    // 記憶體上限：表滿了就不再記新的來源（全站上限仍會計數），不刪舊紀錄——否則灌入大量 IP 就能洗掉別人的失敗次數
    if (failures.has(key) || failures.size < MAX_TRACKED_SOURCES) failures.set(key, rec);
    if (globalFails.resetAt <= now) globalFails = { count: 0, resetAt: now + FAIL_WINDOW_MS };
    globalFails.count += 1;
    if (globalFails.count === GLOBAL_MAX_FAILS) {
      alert('web-login-fail:global', `分帳網頁 ${FAIL_WINDOW_MS / 60000} 分鐘內 Discord 登入失敗達 ${GLOBAL_MAX_FAILS} 次，暫停新的登入（已登入的裝置不受影響）`);
    }
  }

  const issued = new Map(); // uid → { count, resetAt }
  function issueAllowed(uid) {
    const now = Date.now();
    let rec = issued.get(uid);
    if (!rec || rec.resetAt <= now) { rec = { count: 0, resetAt: now + 3600 * 1000 }; issued.set(uid, rec); }
    return ++rec.count <= MAX_ISSUE_PER_HOUR;
  }

  setInterval(() => {
    const now = Date.now();
    for (const [key, f] of failures) if (f.resetAt <= now) failures.delete(key);
    for (const [uid, rec] of issued) if (rec.resetAt <= now) issued.delete(uid);
  }, 60 * 1000).unref();

  // 用授權碼換 token，取得使用者 ID、名稱、頭像。Discord 的 access token 用完就丟，不存起來。
  async function fetchDiscordUser(cfg, code) {
    const tokenRes = await fetch(`${API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
      }),
      signal: AbortSignal.timeout(DISCORD_FETCH_TIMEOUT_MS),
    });
    const tok = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tok.access_token) throw new Error(tok.error_description || tok.error || `token HTTP ${tokenRes.status}`);

    const meRes = await fetch(`${API_BASE}/users/@me`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
      signal: AbortSignal.timeout(DISCORD_FETCH_TIMEOUT_MS),
    });
    const me = await meRes.json().catch(() => ({}));
    if (!meRes.ok || !isSnowflake(String(me.id || ''))) throw new Error(`users/@me HTTP ${meRes.status}`);
    return { id: String(me.id), name: me.global_name || me.username || '', avatar: avatarUrl(me) };
  }

  router.get('/discord/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const cfg = config();
    if (!cfg) {
      return sendPage(res, 503, 'Discord 登入尚未設定',
        `<p>需要 DISCORD_CLIENT_ID、DISCORD_CLIENT_SECRET、PUBLIC_BASE_URL、SESSION_SECRET。</p>${backLink}`);
    }
    const state = crypto.randomBytes(16).toString('hex');
    session.writeOAuthState(res, state, safeNext(req.query.next));
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    // 授權過一次之後不再顯示同意畫面。?switch=1（想換帳號）改成一定顯示：
    // 同意畫面上才有「不是你？」可以換 Discord 帳號，不然每次都會用同一個帳號直接導回來
    url.searchParams.set('prompt', req.query.switch === '1' ? 'consent' : 'none');
    res.redirect(302, url.toString());
  });

  router.get('/discord/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const cfg = config();
    if (!cfg) return sendPage(res, 503, 'Discord 登入尚未設定', backLink);
    const saved = session.readOAuthState(req);
    session.clearOAuthState(res);
    const { code, state, error } = req.query;
    if (typeof error === 'string') return res.redirect(302, '/?login=cancelled');
    if (!saved || typeof saved.state !== 'string' || typeof state !== 'string' || !safeEqual(state, saved.state) || typeof code !== 'string') {
      return sendPage(res, 400, '登入流程已過期或無效', `<p>請回到網頁重新登入一次。</p>${backLink}`);
    }

    const now = Date.now();
    const ipKey = rateLimitKey(clientIp(req));
    const blockedUntil = loginBlockedUntil(ipKey, now);
    if (blockedUntil) {
      res.set('Retry-After', String(Math.ceil((blockedUntil - now) / 1000)));
      return sendPage(res, 429, '登入嘗試太多次', `<p>請過幾分鐘再試。已經登入的裝置不受影響。</p>${backLink}`);
    }

    let user;
    try {
      user = await fetchDiscordUser(cfg, code);
    } catch (err) {
      recordLoginFailure(ipKey, Date.now());
      console.error('[splitbill-oauth] Discord 登入失敗：', err.message);
      return res.redirect(302, '/?login=failed');
    }
    if (!issueAllowed(user.id)) {
      console.warn(`[splitbill-oauth] Discord 帳號 ${user.id} 1 小時內登入超過 ${MAX_ISSUE_PER_HOUR} 次，暫時拒絕`);
      return sendPage(res, 429, '登入太頻繁', `<p>這個帳號短時間內登入太多次，請過一陣子再試。</p>${backLink}`);
    }

    session.writeSession(res, user);
    // 🔒 不直接 302：登入 Cookie 是 SameSite=Strict，從 discord.com 一路導回來的這串請求在瀏覽器眼中是跨站的，
    // 有些瀏覽器 302 過去的下一頁拿不到剛設定的 Cookie。改由這個同站頁面自己跳轉，下一個請求就是同站的。
    const next = safeNext(saved.next);
    sendPage(res, 200, '登入成功', `<p>正在返回…</p><a class="btn" href="${escapeHtml(next)}">沒有自動跳轉請點這裡</a>`, { refresh: next });
  });

  // POST 才能登出（避免被 <img src="/auth/logout"> 之類的跨站請求登出）；
  // 一樣要求 x-requested-with，並拒絕跨站請求，理由同 lib/auth.js 的 CSRF 說明。
  router.post('/logout', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('sec-fetch-site') === 'cross-site' || req.get('x-requested-with') !== 'splitbill') {
      return res.status(403).json({ error: '缺少 CSRF 標頭' });
    }
    session.revokeSession(req, res);
    res.json({ ok: true });
  });

  return router;
};
