'use strict';
// Discord 登入（routes/oauth.js）：導向 Discord、callback、Cookie 規則、next 檢查、換帳號、限流、跨站請求、登出。
// 規則與音樂庫（music-library-service 的 tests/webAuth.test.js）一致。
// Discord 端用本機假的伺服器代替（DISCORD_API_BASE / DISCORD_AUTHORIZE_URL），不啟動整個 server.js。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const ALICE = '410000000000000001';
const BOB = '410000000000000002';

// ── 假的 Discord：授權碼 code-<id> 換到 token tok-<id> ──
let discordDown = false;
const discord = express();
discord.post('/api/oauth2/token', express.urlencoded({ extended: false }), (req, res) => {
  if (discordDown) return res.status(500).json({ error: 'server_error' });
  const m = /^code-(\d+)$/.exec(req.body.code || '');
  if (!m || req.body.client_id !== 'client-id' || req.body.client_secret !== 'client-secret'
    || req.body.redirect_uri !== 'https://bill.test/auth/discord/callback') {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  res.json({ access_token: `tok-${m[1]}`, token_type: 'Bearer' });
});
discord.get('/api/users/@me', (req, res) => {
  const id = (/^Bearer tok-(\d+)$/.exec(req.get('authorization') || '') || [])[1];
  if (!id) return res.status(401).json({});
  res.json({ id, username: `user-${id.slice(-3)}`, global_name: id === ALICE ? 'Alice <b>' : null, avatar: null });
});

const servers = [];
let createOAuthRouter, createIdentityMiddleware;
let main;

before(async () => {
  const d = await new Promise((r) => { const x = discord.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(d);
  Object.assign(process.env, {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    PUBLIC_BASE_URL: 'https://bill.test/',
    SESSION_SECRET: 'o'.repeat(32),
    DISCORD_API_BASE: `http://127.0.0.1:${d.address().port}/api`,
    DISCORD_AUTHORIZE_URL: 'https://discord.test/oauth2/authorize',
  });
  delete process.env.ALERT_WEBHOOK_URL; // 不對外送告警
  // routes/oauth.js 在載入時讀 DISCORD_API_BASE，環境變數要先設好
  createOAuthRouter = require('../routes/oauth');
  ({ createIdentityMiddleware } = require('../lib/auth'));
  main = await boot();
});
after(() => { for (const s of servers) s.close(); });

// 一個只有登入相關路由的 app；每次呼叫都是全新的限流狀態
async function boot() {
  const app = express();
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use('/auth', createOAuthRouter());
  app.use('/api', createIdentityMiddleware('api-key'));
  app.get('/api/whoami', (req, res) => res.json({ user: req.principal && req.principal.kind === 'user' ? req.principal.userId : null }));
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}

const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '');
const sessionOf = (res) => cookieOf(res, 'sb_session').split(';')[0];
const whoami = async (base, headers = {}) => (await (await fetch(`${base}/api/whoami`, { headers })).json()).user;

let ipSeq = 0;
const newIp = () => `203.0.113.${++ipSeq}`;

// 完整登入流程：/auth/discord/login →（假裝在 Discord 按了授權）→ callback；回傳 callback 的回應
async function oauth(base, userId, { next, ip = newIp() } = {}) {
  const q = new URLSearchParams();
  if (next !== undefined) q.set('next', next);
  const r1 = await fetch(`${base}/auth/discord/login?${q}`, { redirect: 'manual' });
  assert.equal(r1.status, 302);
  const state = new URL(r1.headers.get('location')).searchParams.get('state');
  const stateCookie = cookieOf(r1, 'sb_oauth_state').split(';')[0];
  return fetch(`${base}/auth/discord/callback?code=code-${userId}&state=${state}`, {
    redirect: 'manual', headers: { cookie: stateCookie, 'X-Forwarded-For': ip },
  });
}

test('/auth/discord/login：導到 Discord 授權頁，state 存在 Lax、只限 /auth/discord 的 Cookie', async () => {
  const r = await fetch(`${main}/auth/discord/login`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://discord.test/oauth2/authorize');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://bill.test/auth/discord/callback', 'PUBLIC_BASE_URL 結尾的 / 去掉');
  assert.equal(loc.searchParams.get('scope'), 'identify');
  assert.equal(loc.searchParams.get('prompt'), 'none');
  const sc = cookieOf(r, 'sb_oauth_state');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/, 'Discord 導回來是跨站導覽，Strict 會收不到');
  assert.match(sc, /Path=\/auth\/discord;/);
});

test('?switch=1：顯示 Discord 同意畫面（可以換帳號），預設不顯示', async () => {
  const prompt = async (qs) => new URL((await fetch(`${main}/auth/discord/login?${qs}`, { redirect: 'manual' })).headers.get('location')).searchParams.get('prompt');
  assert.equal(await prompt(''), 'none');
  assert.equal(await prompt('switch=1'), 'consent');
});

test('登入成功：發出 HttpOnly、SameSite=Strict 的 Cookie，用同站頁面跳回 next', async () => {
  const r = await oauth(main, ALICE, { next: '/#link=abc' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(await r.text(), /<meta http-equiv="refresh" content="0;url=\/#link=abc">/);
  const sc = cookieOf(r, 'sb_session');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Path=\/;/);
  assert.match(sc, /Secure/, 'PUBLIC_BASE_URL 是 https');
  assert.match(cookieOf(r, 'sb_oauth_state'), /Max-Age=0/, 'state Cookie 用完清掉');
  assert.match(cookieOf(r, 'sb_oauth_state'), /Path=\/auth\/discord;/, '清除時路徑要一致');
  assert.equal(await whoami(main, { cookie: sessionOf(r) }), ALICE);
});

test('next：站內路徑照用（HTML 跳脫），開放式重新導向一律改回 /', async () => {
  assert.match(await (await oauth(main, ALICE, { next: '/?a=1&b=2' })).text(), /content="0;url=\/\?a=1&amp;b=2"/);
  for (const bad of ['//evil.test', '/\\evil.test', 'https://evil.test', '/\t/evil.test', 'x', '']) {
    assert.match(await (await oauth(main, ALICE, { next: bad })).text(), /content="0;url=\/"/, JSON.stringify(bad));
  }
});

test('callback：state 不符、沒有 state Cookie、缺 code 回 400；在 Discord 按取消回到首頁', async () => {
  const r1 = await fetch(`${main}/auth/discord/login`, { redirect: 'manual' });
  const stateCookie = cookieOf(r1, 'sb_oauth_state').split(';')[0];
  const state = new URL(r1.headers.get('location')).searchParams.get('state');
  const cb = (qs, cookie) => fetch(`${main}/auth/discord/callback?${qs}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

  assert.equal((await cb(`code=code-${ALICE}&state=${'0'.repeat(32)}`, stateCookie)).status, 400, 'state 不符（登入 CSRF）');
  assert.equal((await cb(`code=code-${ALICE}&state=${state}`)).status, 400, '沒有 state Cookie');
  assert.equal((await cb(`state=${state}`, stateCookie)).status, 400, '缺 code');
  const cancelled = await cb(`error=access_denied&state=${state}`, stateCookie);
  assert.equal(cancelled.status, 302);
  assert.equal(cancelled.headers.get('location'), '/?login=cancelled');
});

test('跨站請求（Sec-Fetch-Site: cross-site）不認登入 Cookie；同站與沒有這個標頭的照常', async () => {
  const cookie = sessionOf(await oauth(main, BOB));
  assert.equal(await whoami(main, { cookie, 'Sec-Fetch-Site': 'cross-site' }), null);
  assert.equal(await whoami(main, { cookie, 'Sec-Fetch-Site': 'same-origin' }), BOB);
  assert.equal(await whoami(main, { cookie }), BOB, '舊瀏覽器沒有 Sec-Fetch-Site');
});

test('登出：要 CSRF 標頭、拒絕跨站請求；清除 Cookie', async () => {
  const cookie = sessionOf(await oauth(main, BOB));
  const logout = (headers) => fetch(`${main}/auth/logout`, { method: 'POST', headers: { cookie, ...headers } });
  assert.equal((await logout({})).status, 403, '沒有 x-requested-with');
  assert.equal((await logout({ 'x-requested-with': 'splitbill', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const r = await logout({ 'x-requested-with': 'splitbill' });
  assert.equal(r.status, 200);
  assert.match(cookieOf(r, 'sb_session'), /Max-Age=0/);
});

test('每個帳號 1 小時內最多登入 60 次；別的帳號不受影響', async () => {
  const base = await boot();
  for (let i = 0; i < 60; i++) assert.equal((await oauth(base, BOB)).status, 200, `第 ${i + 1} 次`);
  const r = await oauth(base, BOB);
  assert.equal(r.status, 429);
  assert.equal(cookieOf(r, 'sb_session'), '');
  assert.equal((await oauth(base, ALICE)).status, 200);
});

// 全站失敗上限會影響同一個 app 後續的登入，所以獨立掛一個 app，並放在這個檔案最後
test('限流：Discord 換 token 失敗太多次（亂灌 callback）就暫停登入；正常登入不計次數', async () => {
  const base = await boot();
  const ip = newIp();
  for (let i = 0; i < 15; i++) assert.equal((await oauth(base, ALICE, { ip })).status, 200, '成功登入不計次數');
  discordDown = true;
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal((await oauth(base, ALICE, { ip })).headers.get('location'), '/?login=failed');
    }
    const blocked = await oauth(base, ALICE, { ip });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally { discordDown = false; }
  assert.equal((await oauth(base, ALICE, { ip })).status, 429, 'Discord 恢復後這個來源仍要等');
  assert.equal((await oauth(base, ALICE)).status, 200, '其他來源不受影響');

  discordDown = true;
  try {
    let status;
    for (let i = 0; i < 120 && status !== 429; i++) {
      status = (await oauth(base, ALICE, { ip: `198.18.0.${i + 1}` })).status;
    }
    assert.equal(status, 429, '大量不同來源：全站上限');
  } finally { discordDown = false; }
  assert.equal((await oauth(base, ALICE)).status, 429, '全新的來源也要等');
  assert.equal(await whoami(base, { cookie: sessionOf(await oauth(main, ALICE)) }), ALICE, '已登入的 Cookie 不受影響');
});

// ── 代碼交接（iOS 主畫面 App）──
const XRW = { 'x-requested-with': 'splitbill' };
async function handoffStart(base, ip) {
  const r = await fetch(`${base}/auth/handoff/start`, { method: 'POST', headers: { ...XRW, 'X-Forwarded-For': ip } });
  assert.equal(r.status, 200);
  const j = await r.json();
  const hc = cookieOf(r, 'sb_handoff');
  assert.match(hc, /Path=\/auth\/handoff;/);
  assert.match(hc, /SameSite=Strict/);
  return { ...j, cookie: hc.split(';')[0] };
}
// 在「瀏覽器」那邊走完登入，回傳確認頁（HTML）
async function handoffBrowserLogin(base, loginUrl, userId, ip) {
  const r1 = await fetch(base + loginUrl, { redirect: 'manual' });
  assert.equal(r1.status, 302);
  const state = new URL(r1.headers.get('location')).searchParams.get('state');
  const stateCookie = cookieOf(r1, 'sb_oauth_state').split(';')[0];
  const r2 = await fetch(`${base}/auth/discord/callback?code=code-${userId}&state=${state}`, {
    redirect: 'manual', headers: { cookie: stateCookie, 'X-Forwarded-For': ip },
  });
  assert.equal(r2.status, 200);
  assert.equal(cookieOf(r2, 'sb_session'), '', '瀏覽器那邊不登入，登入要交給 App');
  return r2.text();
}
const confirmForm = (html) => ({
  id: /name="id" value="([^"]+)"/.exec(html)[1],
  token: /name="token" value="([^"]+)"/.exec(html)[1],
});
const poll = (base, cookie) => fetch(`${base}/auth/handoff/poll`, { method: 'POST', headers: { ...XRW, cookie } });

test('代碼交接：App 取代碼 → 瀏覽器登入並按「登入 App」→ App 輪詢拿到登入', async () => {
  const base = await boot();
  const ip = newIp();
  const h = await handoffStart(base, ip);
  assert.match(h.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.match(h.loginUrls.discord, /^\/auth\/discord\/login\?handoff=[0-9a-f]{32}$/);
  assert.equal((await poll(base, h.cookie)).status, 202);

  const page = await handoffBrowserLogin(base, h.loginUrls.discord, ALICE, ip);
  assert.ok(page.includes(h.code), '確認頁顯示同一組代碼');
  assert.ok(!page.includes('另一個網路'), '同一個網路不警告');
  const p1 = await poll(base, h.cookie);
  assert.equal(p1.status, 202);
  assert.equal((await p1.json()).status, 'confirming');

  const f = confirmForm(page);
  const c = await fetch(`${base}/auth/handoff/confirm`, { method: 'POST', body: new URLSearchParams({ ...f, action: 'approve' }) });
  assert.equal(c.status, 200);

  const done = await poll(base, h.cookie);
  assert.equal(done.status, 200);
  assert.equal(await whoami(base, { cookie: sessionOf(done) }), ALICE);
  assert.equal((await poll(base, h.cookie)).status, 410, '用過就作廢');
});

test('代碼交接：只知道連結或代碼拿不走登入；別的網路要求的代碼會警告；取消後作廢', async () => {
  const base = await boot();
  const h = await handoffStart(base, newIp());
  const page = await handoffBrowserLogin(base, h.loginUrls.discord, ALICE, newIp());
  assert.ok(page.includes('另一個網路'), '來源網路不同要警告');
  assert.equal((await poll(base, '')).status, 410, '沒有 App 的 Cookie');
  assert.equal((await poll(base, h.cookie.replace(/\.[^.]+$/, '.wrong'))).status, 410, 'Cookie 的密鑰不對');

  const f = confirmForm(page);
  const bad = await fetch(`${base}/auth/handoff/confirm`, { method: 'POST', body: new URLSearchParams({ id: f.id, token: 'x', action: 'approve' }) });
  assert.equal(bad.status, 410, '確認頁的 token 不對');
  const cancel = await fetch(`${base}/auth/handoff/confirm`, { method: 'POST', body: new URLSearchParams({ ...f, action: 'cancel' }) });
  assert.equal(cancel.status, 200);
  assert.equal((await poll(base, h.cookie)).status, 410);
});

test('代碼交接：缺 CSRF 標頭或跨站要求一律拒絕；不存在的代碼不能拿去登入', async () => {
  const base = await boot();
  assert.equal((await fetch(`${base}/auth/handoff/start`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${base}/auth/handoff/start`, { method: 'POST', headers: { ...XRW, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${base}/auth/discord/login?handoff=${'a'.repeat(32)}`, { redirect: 'manual' })).status, 410);
  const h = await handoffStart(base, newIp());
  assert.equal((await fetch(`${base + h.loginUrls.discord}&link=1`, { redirect: 'manual' })).status, 410, '不能同時是綁定');
  const cancel = await fetch(`${base}/auth/handoff/cancel`, { method: 'POST', headers: { ...XRW, cookie: h.cookie } });
  assert.equal(cancel.status, 200);
  assert.equal((await fetch(base + h.loginUrls.discord, { redirect: 'manual' })).status, 410, 'App 取消後連結失效');
});

test('代碼交接：同一個來源最多同時 5 組；重新開始會作廢自己上一組、不佔名額', async () => {
  const base = await boot();
  const ip = newIp();
  let last = await handoffStart(base, ip);
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${base}/auth/handoff/start`, { method: 'POST', headers: { ...XRW, 'X-Forwarded-For': ip, cookie: last.cookie } });
    assert.equal(r.status, 200, '帶著上一組的 Cookie 重來不會被擋');
    last = { cookie: cookieOf(r, 'sb_handoff').split(';')[0] };
  }
  for (let i = 0; i < 4; i++) {
    assert.equal((await fetch(`${base}/auth/handoff/start`, { method: 'POST', headers: { ...XRW, 'X-Forwarded-For': ip } })).status, 200);
  }
  assert.equal((await fetch(`${base}/auth/handoff/start`, { method: 'POST', headers: { ...XRW, 'X-Forwarded-For': ip } })).status, 429);
});
