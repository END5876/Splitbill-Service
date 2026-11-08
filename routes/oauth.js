'use strict';
const express = require('express');
const crypto = require('crypto');
const session = require('../lib/session');
const { isSnowflake } = require('../lib/snowflake');
const { lineAccountId, isLineId } = require('../lib/accounts');
const { clientIp, rateLimitKey } = require('../lib/clientIp');
const { alert } = require('../lib/alert');

// 🆕 [Discord 登入] OAuth2 授權碼流程（scope 只要 identify：只拿 Discord 使用者 ID、
// 名稱、頭像，不讀伺服器清單、不讀 email）。登入只證明身分，不授予任何權限。
// 行為與音樂庫（music-library-service 的 webplayer/webAuth.js）一致：同一個 Discord 應用程式、
// 同樣的 Cookie 規則、限流、換帳號；分帳沒有封鎖名單與主畫面 App 的代碼交接。
//
// 🆕 [LINE 登入] 同一套流程也支援 LINE Login（scope 只要 profile：userId、顯示名稱、頭像，不讀 email）。
// LINE 使用者的身分是 line:U…（見 lib/accounts.js）。
//
// 🆕 [帳號綁定] 已登入時帶 ?link=1 走另一個平台的登入，回來後把兩個帳號綁在一起
// （主身分一律是 Discord，見 storage.linkAccounts）。要綁的 LINE 帳號名下已經有行程時，
// 先導回網頁讓使用者確認合併（routes/accountLink.js）。
//
// 環境變數：
//   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET   Discord Developer Portal → OAuth2
//   LINE_CHANNEL_ID / LINE_CHANNEL_SECRET       LINE Developers → LINE Login channel → Basic settings
//   PUBLIC_BASE_URL     網頁對外網址（例如 https://splitbill.example.com），用來組 redirect_uri；
//                       Discord 後台的 Redirects 要填 <PUBLIC_BASE_URL>/auth/discord/callback，
//                       LINE 後台的 Callback URL 要填 <PUBLIC_BASE_URL>/auth/line/callback
//   SESSION_SECRET      至少 32 字元的隨機字串，用來簽 cookie
//   DISCORD_API_BASE / DISCORD_AUTHORIZE_URL    （測試用）覆寫 Discord 端點
//   LINE_API_BASE / LINE_AUTHORIZE_URL          （測試用）覆寫 LINE 端點
//
// 路由（掛在 /auth 底下，<p> 是 discord 或 line）：
//   GET  /auth/<p>/login     ?next=<站內路徑>（&switch=1＝可以換帳號）（&link=1＝綁定到目前登入的帳號）→ 302 到授權頁
//   GET  /auth/<p>/callback  平台導回來：驗證 state、換 token → 設定 Cookie（或完成綁定），用同站頁面跳回 next
//   POST /auth/logout        撤銷並清除 Cookie

// 指定 API 版本：不帶版本的 /api 會落到 Discord 的預設版本，哪天預設版本調整就可能壞掉
const DISCORD_API_BASE = (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, '');
const DISCORD_AUTHORIZE_URL = process.env.DISCORD_AUTHORIZE_URL || 'https://discord.com/oauth2/authorize';
const LINE_API_BASE = (process.env.LINE_API_BASE || 'https://api.line.me').replace(/\/+$/, '');
const LINE_AUTHORIZE_URL = process.env.LINE_AUTHORIZE_URL || 'https://access.line.me/oauth2/v2.1/authorize';
const FETCH_TIMEOUT_MS = 10000; // 平台卡住時讓使用者看到錯誤，而不是一直轉圈

// ── 登入失敗限流 ──
// 每次 callback 都會帶著 client secret 去平台換 token；state 可以免費一直要，所以拿隨便的 code 灌 callback，
// 就能讓伺服器對平台發出大量無效請求，害伺服器的 IP 被限流（大家都登不進來；
// 音樂庫用同一個 Discord 應用程式，也會一起受影響）。
// 只計「換 token 失敗」的次數（正常登入不受影響）：每個來源 10 分鐘 10 次，全站 100 次（兩個平台合計）。
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 10;
const GLOBAL_MAX_FAILS = 100;
const MAX_TRACKED_SOURCES = 10000;
// 每個帳號 1 小時內最多發出幾次登入（正常使用遠低於這個數；避免重複登入登出把已登出清單灌爆）
const MAX_ISSUE_PER_HOUR = 60;

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

function redirectUri(prov) {
  return `${baseUrl()}/auth/${prov}/callback`;
}

async function fetchJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

/**
 * 每個平台：設定、授權網址、用授權碼換到使用者 { id, name, avatar }。
 * 平台的 access token 用完就丟，不存起來。
 */
const PROVIDERS = {
  discord: {
    label: 'Discord',
    config() {
      const clientId = process.env.DISCORD_CLIENT_ID || '';
      const clientSecret = process.env.DISCORD_CLIENT_SECRET || '';
      if (!clientId || !clientSecret) return null;
      return { clientId, clientSecret };
    },
    missingEnv: 'DISCORD_CLIENT_ID、DISCORD_CLIENT_SECRET',
    authorizeUrl(cfg, state, { switchAccount }) {
      const url = new URL(DISCORD_AUTHORIZE_URL);
      url.searchParams.set('client_id', cfg.clientId);
      url.searchParams.set('redirect_uri', redirectUri('discord'));
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'identify');
      url.searchParams.set('state', state);
      // 授權過一次之後不再顯示同意畫面。?switch=1（想換帳號）改成一定顯示：
      // 同意畫面上才有「不是你？」可以換 Discord 帳號，不然每次都會用同一個帳號直接導回來
      url.searchParams.set('prompt', switchAccount ? 'consent' : 'none');
      return url.toString();
    },
    async fetchUser(cfg, code) {
      const tok = await fetchJson(`${DISCORD_API_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri('discord'),
        }),
      });
      if (!tok.res.ok || !tok.body.access_token) {
        throw new Error(tok.body.error_description || tok.body.error || `token HTTP ${tok.res.status}`);
      }
      const me = await fetchJson(`${DISCORD_API_BASE}/users/@me`, {
        headers: { Authorization: `Bearer ${tok.body.access_token}` },
      });
      if (!me.res.ok || !isSnowflake(String(me.body.id || ''))) throw new Error(`users/@me HTTP ${me.res.status}`);
      const u = me.body;
      return {
        id: String(u.id),
        name: u.global_name || u.username || '',
        avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
      };
    },
  },

  line: {
    label: 'LINE',
    config() {
      const clientId = process.env.LINE_CHANNEL_ID || '';
      const clientSecret = process.env.LINE_CHANNEL_SECRET || '';
      if (!clientId || !clientSecret) return null;
      return { clientId, clientSecret };
    },
    missingEnv: 'LINE_CHANNEL_ID、LINE_CHANNEL_SECRET',
    authorizeUrl(cfg, state, { switchAccount }) {
      const url = new URL(LINE_AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', cfg.clientId);
      url.searchParams.set('redirect_uri', redirectUri('line'));
      url.searchParams.set('state', state);
      url.searchParams.set('scope', 'profile');
      // 換帳號：一定顯示同意畫面，並關掉「用 LINE App 已登入的帳號自動登入」，才有機會改用別的帳號
      if (switchAccount) {
        url.searchParams.set('prompt', 'consent');
        url.searchParams.set('disable_auto_login', 'true');
      }
      return url.toString();
    },
    async fetchUser(cfg, code) {
      const tok = await fetchJson(`${LINE_API_BASE}/oauth2/v2.1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri('line'),
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        }),
      });
      if (!tok.res.ok || !tok.body.access_token) {
        throw new Error(tok.body.error_description || tok.body.error || `token HTTP ${tok.res.status}`);
      }
      const me = await fetchJson(`${LINE_API_BASE}/v2/profile`, {
        headers: { Authorization: `Bearer ${tok.body.access_token}` },
      });
      const id = me.res.ok ? lineAccountId(me.body.userId) : null;
      if (!id) throw new Error(`v2/profile HTTP ${me.res.status}`);
      // 頭像只接受 LINE 自己的 https 網址（CSP 也只放行這個網域）
      const pic = typeof me.body.pictureUrl === 'string' && /^https:\/\/profile\.line-scdn\.net\//.test(me.body.pictureUrl)
        ? me.body.pictureUrl.slice(0, 500) : null;
      return { id, name: typeof me.body.displayName === 'string' ? me.body.displayName : '', avatar: pic };
    },
  },
};

/** 哪些平台的登入已經設定好（給 /api/me 與登入頁顯示按鈕用）。 */
function enabledProviders() {
  const on = session.isEnabled() && !!baseUrl();
  return { discord: on && !!PROVIDERS.discord.config(), line: on && !!PROVIDERS.line.config() };
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

// 登入流程中的小頁面（錯誤、跳轉）。內容全部經過 escapeHtml，body 由呼叫端組好（已跳脫）。
function sendPage(res, status, title, bodyHtml, { refresh } = {}) {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(refresh)}">` : ''}<title>${escapeHtml(title)}｜裊器分帳</title>
<style>
:root{--ink:#1F2330;--ink-soft:#4F5566;--paper:#F2F3F7;--card:#FFFFFF;--line:#DCDFE8;--brass:#8A5A12;--on-brass:#FFFFFF}
@media (prefers-color-scheme:dark){:root{--ink:#F2F3F5;--ink-soft:#A8ACB4;--paper:#1E1F22;--card:#2B2D31;--line:#3F4147;--brass:#D6A646;--on-brass:#1E1F22}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:var(--paper);color:var(--ink);font-family:"Noto Sans TC",system-ui,sans-serif}
main{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;width:100%;max-width:360px;display:flex;flex-direction:column;gap:14px;text-align:center}
h1{font-size:18px;margin:0}p{color:var(--ink-soft);font-size:14px;line-height:1.6;margin:0}
a.btn{height:44px;border-radius:22px;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;text-decoration:none;background:var(--brass);color:var(--on-brass)}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${bodyHtml}</main></body></html>`);
}

const backLink = '<a class="btn" href="/">回到裊器分帳</a>';

// 用同站頁面跳轉（理由見 callback 結尾的說明）
function sendRedirectPage(res, title, next) {
  sendPage(res, 200, title, `<p>正在返回…</p><a class="btn" href="${escapeHtml(next)}">沒有自動跳轉請點這裡</a>`, { refresh: next });
}

/** 在 next 網址上加一個查詢參數（next 已經是安全的站內路徑）。 */
function withParam(next, key, value) {
  const u = new URL(next, 'http://x');
  u.searchParams.set(key, value);
  return u.pathname + u.search + u.hash;
}

/**
 * @param {{ storage?: object }} [deps] 帳號綁定需要 storage（測試只測登入時可以省略，綁定會回 503）
 */
module.exports = function createOAuthRouter(deps = {}) {
  const { storage } = deps;
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
      alert('web-login-fail:global', `分帳網頁 ${FAIL_WINDOW_MS / 60000} 分鐘內登入失敗達 ${GLOBAL_MAX_FAILS} 次，暫停新的登入（已登入的裝置不受影響）`);
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

  function providerOr404(req, res) {
    const p = Object.prototype.hasOwnProperty.call(PROVIDERS, req.params.prov) ? PROVIDERS[req.params.prov] : null;
    if (!p) sendPage(res, 404, '找不到這個登入方式', backLink);
    return p;
  }

  router.get('/:prov/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const provider = providerOr404(req, res);
    if (!provider) return;
    const prov = req.params.prov;
    const cfg = provider.config();
    if (!cfg || !session.isEnabled() || !baseUrl()) {
      return sendPage(res, 503, `${provider.label} 登入尚未設定`,
        `<p>需要 ${provider.missingEnv}、PUBLIC_BASE_URL、SESSION_SECRET。</p>${backLink}`);
    }
    const next = safeNext(req.query.next);

    // 🆕 [帳號綁定] 綁定一定要「已經登入」：登入 Cookie 是 SameSite=Strict，別的網站連過來的請求帶不到它，
    // 所以沒辦法誘導別人的瀏覽器發起綁定。發起者（session、帳號）記進簽章的 state，callback 回來時
    // （那時是跨站導回、拿不到登入 Cookie）就靠這份紀錄知道要綁到誰。
    let link = null;
    if (req.query.link === '1') {
      if (!storage) return sendPage(res, 503, '帳號綁定尚未開放', backLink);
      const current = req.get('sec-fetch-site') === 'cross-site' ? null : session.readSession(req);
      if (!current) return sendPage(res, 401, '請先登入', `<p>要綁定帳號，請先用原本的帳號登入裊器分帳。</p>${backLink}`);
      if (current.provider === prov) {
        const other = prov === 'line' ? 'Discord' : 'LINE';
      return sendPage(res, 400, `你現在就是用 ${provider.label} 登入`, `<p>請到「設定 → 帳號」綁定 ${other} 帳號。</p>${backLink}`);
      }
      link = { sid: current.sid, uid: current.loginId };
    }

    const state = crypto.randomBytes(16).toString('hex');
    session.writeOAuthState(res, state, next, { prov, link });
    res.redirect(302, provider.authorizeUrl(cfg, state, { switchAccount: req.query.switch === '1' }));
  });

  router.get('/:prov/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const provider = providerOr404(req, res);
    if (!provider) return;
    const prov = req.params.prov;
    const cfg = provider.config();
    if (!cfg || !session.isEnabled() || !baseUrl()) return sendPage(res, 503, `${provider.label} 登入尚未設定`, backLink);
    const saved = session.readOAuthState(req);
    session.clearOAuthState(res, prov);
    const { code, state, error } = req.query;
    const savedProv = saved && (saved.prov || 'discord'); // 舊版 state 沒有 prov，一定是 Discord
    if (typeof error === 'string') {
      return res.redirect(302, saved && saved.link ? '/?bind=cancelled' : '/?login=cancelled');
    }
    if (!saved || savedProv !== prov || typeof saved.state !== 'string' || typeof state !== 'string'
      || !safeEqual(state, saved.state) || typeof code !== 'string') {
      return sendPage(res, 400, '這次登入已經逾時', `<p>請回到裊器分帳重新登入一次。</p>${backLink}`);
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
      user = await provider.fetchUser(cfg, code);
    } catch (err) {
      recordLoginFailure(ipKey, Date.now());
      console.error(`[splitbill-oauth] ${provider.label} 登入失敗：`, err.message);
      return res.redirect(302, saved.link ? '/?bind=failed' : '/?login=failed');
    }
    if (!issueAllowed(user.id)) {
      console.warn(`[splitbill-oauth] ${provider.label} 帳號 ${user.id} 1 小時內登入超過 ${MAX_ISSUE_PER_HOUR} 次，暫時拒絕`);
      return sendPage(res, 429, '登入太頻繁', `<p>這個帳號短時間內登入太多次，請過一陣子再試。</p>${backLink}`);
    }

    const next = safeNext(saved.next);
    if (saved.link) return finishLink(res, saved.link, user, next);

    session.writeSession(res, { ...user, provider: prov });
    // 🔒 不直接 302：登入 Cookie 是 SameSite=Strict，從 discord.com／line.me 一路導回來的這串請求在瀏覽器眼中是跨站的，
    // 有些瀏覽器 302 過去的下一頁拿不到剛設定的 Cookie。改由這個同站頁面自己跳轉，下一個請求就是同站的。
    sendRedirectPage(res, '登入成功', next);
  });

  /**
   * 🆕 [帳號綁定] callback 拿到另一個平台的帳號之後：判斷誰是主身分（Discord）、誰被綁（LINE），
   * 檢查衝突；LINE 帳號名下沒有行程就直接綁好，有的話先存成「等待確認」，導回網頁讓使用者確認合併。
   */
  function finishLink(res, link, user, next) {
    if (!storage) return sendPage(res, 503, '帳號綁定尚未開放', backLink);
    // 發起綁定的那次登入，在登入平台的這段期間登出了
    if (session.isSessionRevoked(link.sid)) {
      return sendPage(res, 400, '你已經登出了', `<p>請重新登入後再綁定一次。</p>${backLink}`);
    }
    const initiator = storage.resolveAccount(link.uid);
    let primary;
    let alias;
    if (isSnowflake(initiator) && isLineId(user.id)) { primary = initiator; alias = user.id; }
    else if (isLineId(initiator) && isSnowflake(user.id)) { primary = user.id; alias = initiator; }
    else if (initiator === user.id) {
      return sendRedirectPage(res, '已經綁定過了', withParam(next, 'bind', 'already'));
    } else {
      // 用 LINE 登入、而且這個 LINE 已經綁定了 Discord 帳號，又去綁另一個 Discord 帳號
      return sendPage(res, 409, '你的 LINE 已經綁定了另一個 Discord 帳號',
        `<p>要改綁的話，請先在「設定 → 帳號」解除綁定，再重新綁定。</p>${backLink}`);
    }

    const existing = storage.getAccountLink(alias);
    if (existing && existing.primary === primary) return sendRedirectPage(res, '已經綁定過了', withParam(next, 'bind', 'already'));
    if (existing) {
      return sendPage(res, 409, '這個 LINE 帳號已經綁定其他 Discord 帳號',
        `<p>請先用那個 Discord 帳號登入，在「設定 → 帳號」解除綁定後再試一次。</p>${backLink}`);
    }
    if (storage.listAccountAliases(primary).length) {
      return sendPage(res, 409, '這個 Discord 帳號已經綁定其他 LINE 帳號',
        `<p>一個 Discord 帳號只能綁定一個 LINE 帳號。要改綁的話，請先在「設定 → 帳號」解除綁定。</p>${backLink}`);
    }

    // LINE 那一方的名字（給確認畫面顯示）
    const aliasName = alias === user.id ? user.name : '';
    if (storage.listAccountTrips(alias).length) {
      session.writeLinkPending(res, { sid: link.sid, primary, alias, aliasName });
      return sendRedirectPage(res, '正在返回', withParam(next, 'bind', 'confirm'));
    }
    try {
      storage.linkAccounts(primary, alias, { actor: { kind: 'user', userId: primary } });
    } catch (err) {
      console.error('[splitbill-oauth] 帳號綁定失敗：', err.message);
      return sendPage(res, err.code ? 409 : 500, '綁定失敗', `<p>${escapeHtml(err.code ? err.message : '目前無法完成綁定，請稍後再試一次。')}</p>${backLink}`);
    }
    sendRedirectPage(res, '綁定成功', withParam(next, 'bind', 'done'));
  }

  // POST 才能登出（避免被 <img src="/auth/logout"> 之類的跨站請求登出）；
  // 一樣要求 x-requested-with，並拒絕跨站請求，理由同 lib/auth.js 的 CSRF 說明。
  router.post('/logout', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('sec-fetch-site') === 'cross-site' || req.get('x-requested-with') !== 'splitbill') {
      return res.status(403).json({ error: '缺少 CSRF 標頭' });
    }
    session.revokeSession(req, res);
    session.clearLinkPending(res);
    res.json({ ok: true });
  });

  return router;
};

module.exports.enabledProviders = enabledProviders;
