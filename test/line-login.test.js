'use strict';
// 🆕 [LINE 登入] LINE 登入、只用 LINE 的成員（lineId）、Discord ⇄ LINE 帳號綁定與合併。
// Discord 與 LINE 都用本機假的伺服器代替（DISCORD_API_BASE、LINE_API_BASE），啟動完整的 server.js。
// 執行：npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const PORT = 45000 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-line-key';
const SESSION_SECRET = 'l'.repeat(32);
const BOT = { 'x-api-key': KEY, 'content-type': 'application/json' };

// Discord ID 與 LINE userId（U＋32 碼 hex）；身分字串是 line:U…
const D1 = '500000000000000001';
const D2 = '500000000000000002';
const D3 = '500000000000000003';
const D4 = '500000000000000004';
const lineHex = (n) => String(n).padStart(32, '0');
const L = (n) => `line:U${lineHex(n)}`;

// ── 假的 Discord 與 LINE：授權碼 code-<id> 換到 token tok-<id> ──
const fake = express();
fake.post('/discord/oauth2/token', express.urlencoded({ extended: false }), (req, res) => {
  const m = /^code-(\d+)$/.exec(req.body.code || '');
  if (!m || req.body.redirect_uri !== 'https://bill.test/auth/discord/callback') return res.status(400).json({ error: 'invalid_grant' });
  res.json({ access_token: `tok-${m[1]}` });
});
fake.get('/discord/users/@me', (req, res) => {
  const id = (/^Bearer tok-(\d+)$/.exec(req.get('authorization') || '') || [])[1];
  if (!id) return res.status(401).json({});
  res.json({ id, username: `d-${id.slice(-1)}`, global_name: null, avatar: null });
});
fake.post('/line/oauth2/v2.1/token', express.urlencoded({ extended: false }), (req, res) => {
  const m = /^code-(U[0-9a-z]+)$/.exec(req.body.code || '');
  if (!m || req.body.client_id !== 'line-id' || req.body.client_secret !== 'line-secret'
    || req.body.grant_type !== 'authorization_code' || req.body.redirect_uri !== 'https://bill.test/auth/line/callback') {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  res.json({ access_token: `tok-${m[1]}`, token_type: 'Bearer' });
});
fake.get('/line/v2/profile', (req, res) => {
  const uid = (/^Bearer tok-(U[0-9a-z]+)$/.exec(req.get('authorization') || '') || [])[1];
  if (!uid) return res.status(401).json({});
  res.json({ userId: uid, displayName: `LINE ${uid.slice(-2)}`, pictureUrl: 'https://profile.line-scdn.net/pic' });
});

let proc, dataDir, fakeServer;

async function j(res) { return { status: res.status, body: await res.json().catch(() => ({})) }; }
const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '');
const pair = (res, name) => cookieOf(res, name).split(';')[0];

// 直接簽一個登入 Cookie（uid＝登入的帳號，可以是 line:U…）
function sessionCookie(uid) {
  process.env.SESSION_SECRET = SESSION_SECRET;
  const session = require('../lib/session');
  let header = [];
  session.writeSession({ getHeader: () => header, setHeader: (_, v) => { header = v; } },
    { id: uid, name: 'u', provider: uid.startsWith('line:') ? 'line' : 'discord' });
  return header[0].split(';')[0];
}
const web = (cookie, extra = {}) => ({ cookie, 'x-requested-with': 'splitbill', 'content-type': 'application/json', ...extra });
const api = (p, cookie, init = {}) => fetch(`${BASE}${p}`, { ...init, headers: web(cookie, init.headers) }).then(j);

/**
 * 走一次平台登入：/auth/<prov>/login（可帶 cookie＝已登入、link=1）→ 假裝授權 → callback。
 * code：Discord 用 Discord ID、LINE 用 U…。回傳 callback 的回應。
 */
async function oauth(prov, code, { cookie, link = false, next } = {}) {
  const q = new URLSearchParams();
  if (link) q.set('link', '1');
  if (next) q.set('next', next);
  const r1 = await fetch(`${BASE}/auth/${prov}/login?${q}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  if (r1.status !== 302) return r1;
  const state = new URL(r1.headers.get('location')).searchParams.get('state');
  return fetch(`${BASE}/auth/${prov}/callback?code=code-${code}&state=${state}`, {
    redirect: 'manual', headers: { cookie: pair(r1, 'sb_oauth_state') },
  });
}
const refreshTarget = async (res) => (/content="0;url=([^"]*)"/.exec(await res.text()) || [])[1];

before(async () => {
  fakeServer = await new Promise((r) => { const x = fake.listen(0, '127.0.0.1', () => r(x)); });
  const fp = fakeServer.address().port;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-line-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), SPLITBILL_API_KEY: KEY, SPLITBILL_DATA_DIR: dataDir, SESSION_SECRET, OWNER_USER_ID: '',
      PUBLIC_BASE_URL: 'https://bill.test',
      DISCORD_CLIENT_ID: 'discord-id', DISCORD_CLIENT_SECRET: 'discord-secret',
      DISCORD_API_BASE: `http://127.0.0.1:${fp}/discord`, DISCORD_AUTHORIZE_URL: 'https://discord.test/oauth2/authorize',
      LINE_CHANNEL_ID: 'line-id', LINE_CHANNEL_SECRET: 'line-secret',
      LINE_API_BASE: `http://127.0.0.1:${fp}/line`, LINE_AUTHORIZE_URL: 'https://line.test/oauth2/v2.1/authorize',
      ALERT_WEBHOOK_URL: '',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch (_) { /* 還沒起來 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited;
  }
  fakeServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 用 LINE 帳號建立一個行程，回傳行程。 */
async function createTrip(cookie, name) {
  const r = await api('/api/trips', cookie, { method: 'POST', body: JSON.stringify({ name, memberName: name + '主人' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
/** 用邀請連結以新成員身分加入。 */
async function joinTrip(ownerCookie, tripId, cookie, name) {
  const inv = await api(`/api/trip/${tripId}/invite`, ownerCookie);
  const r = await api(`/api/link/${inv.body.token}/claim`, cookie, { method: 'POST', body: JSON.stringify({ newMemberName: name }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.memberId;
}

// ─────────────────────────── LINE 登入 ───────────────────────────

test('/auth/line/login：導到 LINE 授權頁（scope=profile），state 存在只限 /auth/line 的 Lax Cookie', async () => {
  const r = await fetch(`${BASE}/auth/line/login`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://line.test/oauth2/v2.1/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'line-id');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://bill.test/auth/line/callback');
  assert.equal(loc.searchParams.get('scope'), 'profile');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.equal(loc.searchParams.get('disable_auto_login'), null);
  const sc = cookieOf(r, 'sb_oauth_state');
  assert.match(sc, /SameSite=Lax/);
  assert.match(sc, /Path=\/auth\/line;/);

  const sw = new URL((await fetch(`${BASE}/auth/line/login?switch=1`, { redirect: 'manual' })).headers.get('location'));
  assert.equal(sw.searchParams.get('prompt'), 'consent');
  assert.equal(sw.searchParams.get('disable_auto_login'), 'true', '換帳號：關掉 LINE App 的自動登入');
  assert.equal((await fetch(`${BASE}/auth/nope/login`, { redirect: 'manual' })).status, 404);
});

test('LINE 登入成功：身分是 line:U…，/api/me 顯示平台與兩種登入方式', async () => {
  const r = await oauth('line', `U${lineHex(1)}`, { next: '/?x=1' });
  assert.equal(r.status, 200);
  assert.equal(await refreshTarget(r), '/?x=1');
  const cookie = pair(r, 'sb_session');
  const me = await api('/api/me', cookie);
  assert.equal(me.body.oauth, true);
  assert.deepEqual(me.body.providers, { discord: true, line: true });
  assert.equal(me.body.user.id, L(1));
  assert.equal(me.body.user.provider, 'line');
  assert.equal(me.body.user.name, 'LINE 01');
  assert.equal(me.body.user.avatar, 'https://profile.line-scdn.net/pic');
  assert.deepEqual(me.body.user.accounts, { discord: null, line: true });
});

test('LINE callback：格式不對的 userId 當成登入失敗；Discord 的 state 不能拿來用在 LINE', async () => {
  const bad = await oauth('line', 'Uxyz');
  assert.equal(bad.status, 302);
  assert.equal(bad.headers.get('location'), '/?login=failed');

  const r1 = await fetch(`${BASE}/auth/discord/login`, { redirect: 'manual' });
  const state = new URL(r1.headers.get('location')).searchParams.get('state');
  const cross = await fetch(`${BASE}/auth/line/callback?code=code-U${lineHex(1)}&state=${state}`, {
    redirect: 'manual', headers: { cookie: pair(r1, 'sb_oauth_state') },
  });
  assert.equal(cross.status, 400);
});

test('CSP 允許 LINE 頭像網域', async () => {
  const csp = (await fetch(`${BASE}/`)).headers.get('content-security-policy');
  assert.match(csp, /img-src [^;]*https:\/\/profile\.line-scdn\.net/);
});

// ─────────────────────── 只用 LINE 的成員 ───────────────────────

test('LINE 使用者建立行程、用邀請連結加入：成員記在 lineId，權限照常；訪客只看到 linked', async () => {
  const a = sessionCookie(L(10));
  const b = sessionCookie(L(11));
  const trip = await createTrip(a, 'LINE 行程');
  assert.equal(trip.ownerId, L(10));
  assert.equal(trip.members[0].lineId, L(10));
  assert.equal(trip.members[0].discordId, undefined);

  const memberId = await joinTrip(a, trip.id, b, 'B');
  const t = await api(`/api/trip/${trip.id}`, b);
  assert.equal(t.status, 200, 'B 加入後是成員');
  assert.equal(t.body.members.find((m) => m.id === memberId).lineId, L(11));
  const mine = await api('/api/my/trips', b);
  assert.deepEqual(mine.body.trips.map((x) => [x.id, x.role]), [[trip.id, 'member']]);

  // 訪客：不帶 lineId，也不帶建立者
  const link = await j(await fetch(`${BASE}/api/trip/${trip.id}/links`, {
    method: 'POST', headers: web(a), body: JSON.stringify({ guest: 'read', join: false }),
  }));
  const guest = await j(await fetch(`${BASE}/api/shared-trip/${link.body.token}`));
  assert.equal(guest.status, 200);
  const raw = JSON.stringify(guest.body);
  assert.ok(!raw.includes('line:U'), raw);
  assert.ok(guest.body.trip.members.every((m) => m.linked === true));
});

test('整包 PUT 不能寫入或清掉 lineId；Bot 不能把 Discord 帳號連到已用 LINE 認領的成員', async () => {
  const a = sessionCookie(L(20));
  const b = sessionCookie(L(21));
  const trip = await createTrip(a, 'PUT 測試');
  const bId = await joinTrip(a, trip.id, b, 'B');

  const cur = (await api(`/api/trip/${trip.id}`, b)).body;
  const members = cur.members.map((m) => ({ id: m.id, name: m.name })); // 拿掉所有 lineId
  members.push({ id: 'mem_fake', name: '偽造', lineId: L(99) });
  const put = await api(`/api/trip/${trip.id}`, b, { method: 'PUT', body: JSON.stringify({ ...cur, members, expectedUpdatedAt: cur.updatedAt }) });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.members.find((m) => m.id === bId).lineId, L(21), '沿用伺服器上的 lineId');
  assert.equal(put.body.members[0].lineId, L(20));
  assert.equal(put.body.members.find((m) => m.id === 'mem_fake').lineId, undefined, '網頁不能替人連結');

  // B（一般成員）整包 PUT 漏掉建立者 → 建立者（已連結）被補回來
  const cur2 = put.body;
  const put2 = await api(`/api/trip/${trip.id}`, b, {
    method: 'PUT', body: JSON.stringify({ ...cur2, members: cur2.members.filter((m) => m.lineId !== L(20)), expectedUpdatedAt: cur2.updatedAt }),
  });
  assert.ok(put2.body.members.some((m) => m.lineId === L(20)), '一般成員不能移除已連結 LINE 的成員');

  // Bot：替 B 補上 discordId → 不生效
  const cur3 = put2.body;
  const botPut = await j(await fetch(`${BASE}/api/trip/${trip.id}`, {
    method: 'PUT', headers: BOT,
    body: JSON.stringify({ ...cur3, members: cur3.members.map((m) => (m.id === bId ? { ...m, discordId: D3 } : m)) }),
  }));
  const bAfter = botPut.body.members.find((m) => m.id === bId);
  assert.equal(bAfter.discordId, undefined);
  assert.equal(bAfter.lineId, L(21));
});

test('解除成員連結：LINE 成員可以解除自己，建立者可以解除別人', async () => {
  const a = sessionCookie(L(30));
  const b = sessionCookie(L(31));
  const trip = await createTrip(a, '解除測試');
  const bId = await joinTrip(a, trip.id, b, 'B');
  const r = await api(`/api/trip/${trip.id}/members/${bId}/unlink`, b, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.trip.members.find((m) => m.id === bId).lineId, undefined);
  assert.equal((await api(`/api/trip/${trip.id}`, b)).status, 403, '解除後就不是成員了');
});

// ─────────────────────── 帳號綁定 ───────────────────────

test('綁定一定要先登入，而且要用另一個平台', async () => {
  const anon = await fetch(`${BASE}/auth/line/login?link=1`, { redirect: 'manual' });
  assert.equal(anon.status, 401);
  const same = await fetch(`${BASE}/auth/line/login?link=1`, { redirect: 'manual', headers: { cookie: sessionCookie(L(40)) } });
  assert.equal(same.status, 400);
  const cross = await fetch(`${BASE}/auth/line/login?link=1`, {
    redirect: 'manual', headers: { cookie: sessionCookie(D1), 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(cross.status, 401, '跨站請求不認登入 Cookie，不能誘導別人的瀏覽器發起綁定');
});

test('綁定沒有資料的 LINE 帳號：直接完成；之後用 LINE 登入就是那個 Discord 帳號', async () => {
  const d = sessionCookie(D2);
  const trip = await createTrip(d, 'D2 的行程');
  const r = await oauth('line', `U${lineHex(42)}`, { cookie: d, link: true, next: '/' });
  assert.equal(r.status, 200);
  assert.equal(await refreshTarget(r), '/?bind=done');
  assert.equal(cookieOf(r, 'sb_session'), '', '綁定不換掉目前的登入');

  const viaLine = sessionCookie(L(42));
  const me = await api('/api/me', viaLine);
  assert.equal(me.body.user.id, D2);
  assert.equal(me.body.user.provider, 'line');
  assert.deepEqual(me.body.user.accounts, { discord: D2, line: true });
  assert.deepEqual((await api('/api/me', d)).body.user.accounts, { discord: D2, line: true });
  assert.deepEqual((await api('/api/my/trips', viaLine)).body.trips.map((t) => t.id), [trip.id]);

  // 已經綁過：再綁一次回報 already；同一個 Discord 不能再綁第二個 LINE；同一個 LINE 不能綁第二個 Discord
  assert.equal(await refreshTarget(await oauth('line', `U${lineHex(42)}`, { cookie: d, link: true })), '/?bind=already');
  assert.equal((await oauth('line', `U${lineHex(43)}`, { cookie: d, link: true })).status, 409);
  assert.equal((await oauth('line', `U${lineHex(42)}`, { cookie: sessionCookie(D3), link: true })).status, 409);
});

test('綁定有資料的 LINE 帳號：先確認，再把行程合併到 Discord 帳號（同行程衝突時 LINE 那位改未連結）', async () => {
  const line = sessionCookie(L(50));
  const disc = sessionCookie(D1);
  const owned = await createTrip(line, 'LINE 建立的');           // L50 是建立者＋成員
  const both = await createTrip(disc, '兩邊都在');               // D1 建立，L50 也加入
  const lineMemberInBoth = await joinTrip(disc, both.id, line, 'L50 分身');
  const solo = await createTrip(sessionCookie(L(51)), '別人的'); // L50 只是成員
  await joinTrip(sessionCookie(L(51)), solo.id, line, 'L50');

  const r = await oauth('line', `U${lineHex(50)}`, { cookie: disc, link: true, next: '/' });
  assert.equal(await refreshTarget(r), '/?bind=confirm');
  const pending = pair(r, 'sb_link_pending');
  assert.ok(pending, '等待確認的 Cookie');

  // 別的 session 拿這個 Cookie 也不能確認（綁在發起的 session 上）
  const other = await api('/api/account-link/confirm', `${sessionCookie(D1)}; ${pending}`, { method: 'POST' });
  assert.equal(other.status, 409);

  const pv = await api('/api/account-link/pending', `${disc}; ${pending}`);
  assert.equal(pv.body.pending.trips.length, 3);
  const byName = Object.fromEntries(pv.body.pending.trips.map((t) => [t.name, t]));
  assert.equal(byName['LINE 建立的'].owner, true);
  assert.equal(byName['兩邊都在'].willUnlink, true);
  assert.equal(byName['別人的'].willUnlink, false);
  assert.ok(!JSON.stringify(pv.body).includes('line:U'), '不回傳帳號 ID');

  // 還沒確認：LINE 登入仍是自己
  assert.equal((await api('/api/me', line)).body.user.id, L(50));

  const ok = await api('/api/account-link/confirm', `${disc}; ${pending}`, { method: 'POST' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const t1 = (await api(`/api/trip/${owned.id}`, disc)).body;
  assert.equal(t1.ownerId, D1, '建立者改成 Discord 帳號');
  assert.equal(t1.members[0].discordId, D1);
  assert.equal(t1.members[0].lineId, undefined);
  const t2 = (await api(`/api/trip/${both.id}`, disc)).body;
  const dup = t2.members.find((m) => m.id === lineMemberInBoth);
  assert.equal(dup.lineId, undefined, '同一個行程裡 Discord 帳號已經是成員 → LINE 那位改成未連結');
  assert.equal(dup.discordId, undefined);
  const t3 = (await api(`/api/trip/${solo.id}`, disc)).body;
  assert.equal(t3.members.find((m) => m.name === 'L50').discordId, D1);
  assert.ok(!JSON.stringify([t1, t2, t3]).includes(L(50)), '行程裡不再有這個 LINE 帳號');

  // 用 LINE 登入（同一個舊 Cookie）就是 D1，看得到全部三個行程
  const viaLine = await api('/api/my/trips', line);
  assert.deepEqual(viaLine.body.trips.map((t) => t.id).sort(), [owned.id, both.id, solo.id].sort());

  // 操作紀錄標示帳號綁定（LINE→Discord 是同一個人，不算「連結／解除」）
  const hist = await api(`/api/trip/${owned.id}/activity`, disc);
  assert.equal(hist.status, 200);
  assert.equal(hist.body.items[0].reason && hist.body.items[0].reason.type, 'account-merge', JSON.stringify(hist.body.items[0]));
  assert.deepEqual(hist.body.items[0].changes.map((c) => c.type), ['member.account']);

  // 解除綁定：行程留在 D1，LINE 變回空帳號
  const un = await api('/api/account-link', line, { method: 'DELETE' });
  assert.equal(un.status, 200);
  assert.equal(un.body.nowAccount, 'line');
  assert.equal((await api('/api/me', line)).body.user.id, L(50));
  assert.deepEqual((await api('/api/my/trips', line)).body.trips, []);
  assert.equal((await api('/api/my/trips', disc)).body.trips.length, 3);
  assert.equal((await api('/api/account-link', disc, { method: 'DELETE' })).status, 404);
});

test('從 LINE 那邊發起綁定 Discord：確認後 LINE 的登入直接變成 Discord 帳號', async () => {
  const line = sessionCookie(L(60));
  const trip = await createTrip(line, 'L60 的行程');
  const r = await oauth('discord', D4, { cookie: line, link: true, next: '/' });
  assert.equal(await refreshTarget(r), '/?bind=confirm');
  const pending = pair(r, 'sb_link_pending');
  const ok = await api('/api/account-link/confirm', `${line}; ${pending}`, { method: 'POST' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const me = (await api('/api/me', line)).body.user;
  assert.equal(me.id, D4);
  assert.deepEqual(me.accounts, { discord: D4, line: true });
  assert.equal((await api(`/api/trip/${trip.id}`, sessionCookie(D4))).body.ownerId, D4);
});

test('取消等待確認的綁定：什麼都不變', async () => {
  const line = sessionCookie(L(70));
  await createTrip(line, 'L70');
  const disc = sessionCookie(D3);
  const r = await oauth('line', `U${lineHex(70)}`, { cookie: disc, link: true });
  const pending = pair(r, 'sb_link_pending');
  const c = await fetch(`${BASE}/api/account-link/cancel`, { method: 'POST', headers: web(`${disc}; ${pending}`) });
  assert.equal(c.status, 200);
  assert.match(cookieOf(c, 'sb_link_pending'), /Max-Age=0/);
  assert.equal((await api('/api/me', line)).body.user.id, L(70));
  assert.equal((await api('/api/account-link/pending', disc)).body.pending, null);
});

test('寫入請求一樣要 CSRF 標頭', async () => {
  const r = await fetch(`${BASE}/api/account-link`, { method: 'DELETE', headers: { cookie: sessionCookie(D1) } });
  assert.equal(r.status, 403);
});
