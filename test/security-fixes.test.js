'use strict';
// 回歸測試：安全檢查後的修正——SSE 權限即時失效、已連結成員不能被整包 PUT 踢掉、
// 只存已知欄位、訪客看不到 Discord ID、登出撤銷 session、匿名請求不洩漏行程是否存在、
// 限流與筆數上限、跨基準幣別的版本還原。
// 執行：npm test（會自己啟動一個暫時的 server，資料放在暫存目錄，不會動到正式資料）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 45000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-key';
const SVC = { 'x-api-key': KEY, 'content-type': 'application/json' };
const JSONH = { 'content-type': 'application/json' };
const ALICE = '400000000000000001'; // 建立者
const BOB = '400000000000000002';   // 已連結成員
const CAROL = '400000000000000003'; // 已連結成員
const SESSION_SECRET = 'z'.repeat(32);
let proc, dataDir;

function loginCookie(uid) {
  process.env.SESSION_SECRET = SESSION_SECRET;
  const session = require('../lib/session');
  let header = [];
  session.writeSession({ getHeader: () => header, setHeader: (_, v) => { header = v; } }, { id: uid, name: 'u' });
  return header[0].split(';')[0];
}
const asUser = (uid) => ({ cookie: loginCookie(uid), 'x-requested-with': 'splitbill', 'content-type': 'application/json' });
const asBot = (uid) => ({ ...SVC, 'x-actor-id': uid });

async function j(res) { return { status: res.status, body: await res.json().catch(() => ({})) }; }

const EXPENSE = (desc, amount = 100) => ({
  description: desc, amount, amountInBase: amount, currency: 'TWD',
  payers: [{ userId: 'a', amount }], participants: [{ userId: 'a', amount }],
});

// 建立一個有三位已連結成員的行程，回傳 tripId
let seq = 0;
async function makeTrip(extra = {}) {
  const id = `sec${++seq}`;
  const r = await j(await fetch(`${BASE}/api/trip/${id}`, { method: 'PUT', headers: SVC, body: JSON.stringify({
    name: id, ownerId: ALICE,
    members: [{ id: 'a', name: 'A', discordId: ALICE }, { id: 'b', name: 'B', discordId: BOB }, { id: 'c', name: 'C', discordId: CAROL }, { id: 'd', name: 'D' }],
    ...extra,
  }) }));
  assert.equal(r.status, 200);
  return id;
}
async function makeLink(tripId, guest) {
  return (await j(await fetch(`${BASE}/api/trip/${tripId}/links`, { method: 'POST', headers: SVC, body: JSON.stringify({ guest }) }))).body.token;
}

/** 開一條 SSE，回傳 { text(), closed, close() }。 */
async function openSse(url, headers = {}) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const closed = (async () => {
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } } catch (_) { /* aborted */ }
  })();
  await new Promise((r) => setTimeout(r, 200));
  return { text: () => buf, closed, close: () => ac.abort() };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p.then(() => true), wait(ms).then(() => false)]);

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sec-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), SPLITBILL_API_KEY: KEY, SPLITBILL_DATA_DIR: dataDir, SESSION_SECRET, OWNER_USER_ID: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch (_) { /* not up yet */ }
    await wait(100);
  }
});

after(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited;
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── SSE 權限即時失效 ──

test('撤銷分享連結後，已開著的 SSE 立刻被關閉，之後的資料不會送出', async () => {
  const id = await makeTrip();
  const RO = await makeLink(id, 'read');
  const sse = await openSse(`${BASE}/api/shared-trip/${RO}/events`);
  await fetch(`${BASE}/api/trip/${id}/links/${RO}`, { method: 'DELETE', headers: SVC });
  assert.ok(await within(sse.closed, 2000), '連線應該被伺服器關閉');
  await fetch(`${BASE}/api/trip/${id}/expenses/exp_x`, { method: 'PUT', headers: SVC, body: JSON.stringify({ entry: EXPENSE('AFTER-REVOKE') }) });
  await wait(200);
  assert.match(sse.text(), /event: access-revoked/);
  assert.doesNotMatch(sse.text(), /AFTER-REVOKE/);
  sse.close();
});

test('分享連結改成不開放訪客後，SSE 被關閉', async () => {
  const id = await makeTrip();
  const RW = await makeLink(id, 'write');
  const sse = await openSse(`${BASE}/api/shared-trip/${RW}/events`);
  await fetch(`${BASE}/api/trip/${id}/links/${RW}`, { method: 'PATCH', headers: SVC, body: JSON.stringify({ guest: 'none', join: true }) });
  assert.ok(await within(sse.closed, 2000));
  assert.match(sse.text(), /event: access-revoked/);
});

test('成員被解除連結後，他開著的 SSE 不會再收到行程更新', async () => {
  const id = await makeTrip();
  const sse = await openSse(`${BASE}/api/trip/${id}/events`, { cookie: loginCookie(BOB) });
  const r = await fetch(`${BASE}/api/trip/${id}/members/b/unlink`, { method: 'POST', headers: asUser(ALICE) });
  assert.equal(r.status, 200);
  assert.ok(await within(sse.closed, 2000));
  assert.match(sse.text(), /event: access-revoked/);
  assert.doesNotMatch(sse.text(), /event: trip-updated/);
});

test('仍有權限的成員照常收到更新', async () => {
  const id = await makeTrip();
  const sse = await openSse(`${BASE}/api/trip/${id}/events`, { cookie: loginCookie(BOB) });
  await fetch(`${BASE}/api/trip/${id}/expenses/exp_ok`, { method: 'PUT', headers: SVC, body: JSON.stringify({ entry: EXPENSE('STILL-OK') }) });
  await wait(300);
  assert.match(sse.text(), /STILL-OK/);
  assert.doesNotMatch(sse.text(), /access-revoked/);
  sse.close();
});

// ── 已連結成員不能被整包 PUT 踢掉 ──

test('可編輯分享連結整包 PUT 漏掉已連結成員時，伺服器會把他補回來', async () => {
  const id = await makeTrip();
  const RW = await makeLink(id, 'write');
  const cur = (await j(await fetch(`${BASE}/api/shared-trip/${RW}`))).body.trip;
  const r = await j(await fetch(`${BASE}/api/shared-trip/${RW}`, { method: 'PUT', headers: JSONH, body: JSON.stringify({
    ...cur, members: cur.members.filter((m) => m.id === 'a' || m.id === 'd'),
  }) }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.trip.members.map((m) => m.id).sort(), ['a', 'b', 'c', 'd']);
  assert.equal((await fetch(`${BASE}/api/trip/${id}`, { headers: asUser(BOB) })).status, 200, 'B 仍然可以存取');
});

test('一般成員只能移除自己，不能移除其他已連結成員；未連結成員可以移除', async () => {
  const id = await makeTrip();
  const cur = (await j(await fetch(`${BASE}/api/trip/${id}`, { headers: SVC }))).body;
  const r = await j(await fetch(`${BASE}/api/trip/${id}`, { method: 'PUT', headers: asUser(BOB), body: JSON.stringify({
    ...cur, members: cur.members.filter((m) => m.id === 'a'), // 想移除 b（自己）、c、d
  }) }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.members.map((m) => m.id).sort(), ['a', 'c'], 'c 被補回；b（自己）與未連結的 d 可以移除');
});

test('建立者可以移除已連結成員', async () => {
  const id = await makeTrip();
  const cur = (await j(await fetch(`${BASE}/api/trip/${id}`, { headers: SVC }))).body;
  const r = await j(await fetch(`${BASE}/api/trip/${id}`, { method: 'PUT', headers: asUser(ALICE), body: JSON.stringify({
    ...cur, members: cur.members.filter((m) => m.id !== 'c'),
  }) }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.members.map((m) => m.id).sort(), ['a', 'b', 'd']);
});

// ── 只存已知欄位、筆數上限 ──

test('整包 PUT 帶來的未知欄位不會被存下來', async () => {
  const id = await makeTrip();
  const RW = await makeLink(id, 'write');
  const cur = (await j(await fetch(`${BASE}/api/shared-trip/${RW}`))).body.trip;
  await fetch(`${BASE}/api/shared-trip/${RW}`, { method: 'PUT', headers: JSONH, body: JSON.stringify({ ...cur, junk: 'x'.repeat(1000), isAdmin: true }) });
  const after = (await j(await fetch(`${BASE}/api/trip/${id}`, { headers: SVC }))).body;
  assert.equal('junk' in after, false);
  assert.equal('isAdmin' in after, false);
});

test('整包 PUT 超過 5000 筆支出會被拒絕', async () => {
  const id = await makeTrip();
  const cur = (await j(await fetch(`${BASE}/api/trip/${id}`, { headers: SVC }))).body;
  const expenses = Array.from({ length: 5001 }, (_, i) => ({ id: `e${i}`, description: 'x', amount: 1 }));
  const r = await fetch(`${BASE}/api/trip/${id}`, { method: 'PUT', headers: SVC, body: JSON.stringify({ ...cur, expenses }) });
  assert.equal(r.status, 400);
});

// ── 訪客看不到 Discord ID ──

test('分享連結訪客拿到的行程不含 Discord ID 與 ownerId（GET、SSE、歷史版本）', async () => {
  const id = await makeTrip();
  const RO = await makeLink(id, 'read');
  const hasIds = (x) => [ALICE, BOB, CAROL].some((u) => JSON.stringify(x).includes(u));

  const got = (await j(await fetch(`${BASE}/api/shared-trip/${RO}`))).body.trip;
  assert.equal(hasIds(got), false);
  assert.equal('ownerId' in got, false);
  assert.equal(got.members.find((m) => m.id === 'b').linked, true);
  assert.equal(got.members.find((m) => m.id === 'd').linked, undefined);

  const sse = await openSse(`${BASE}/api/shared-trip/${RO}/events`);
  await fetch(`${BASE}/api/trip/${id}/expenses/exp_g`, { method: 'PUT', headers: SVC, body: JSON.stringify({ entry: EXPENSE('GUEST-SEE') }) });
  await wait(300);
  sse.close();
  assert.match(sse.text(), /GUEST-SEE/);
  assert.equal(hasIds(sse.text()), false);

  const rev = await j(await fetch(`${BASE}/api/shared-trip/${RO}/revisions/${got.updatedAt}`));
  assert.equal(rev.status, 200);
  assert.equal(hasIds(rev.body), false);

  // 成員自己看得到
  const asMember = (await j(await fetch(`${BASE}/api/trip/${id}`, { headers: asUser(BOB) }))).body;
  assert.equal(asMember.members.find((m) => m.id === 'b').discordId, BOB);
});

test('訪客存檔時送回的 linked 欄位不會影響伺服器上的連結', async () => {
  const id = await makeTrip();
  const RW = await makeLink(id, 'write');
  const cur = (await j(await fetch(`${BASE}/api/shared-trip/${RW}`))).body.trip;
  await fetch(`${BASE}/api/shared-trip/${RW}`, { method: 'PUT', headers: JSONH, body: JSON.stringify(cur) });
  const after = (await j(await fetch(`${BASE}/api/trip/${id}`, { headers: SVC }))).body;
  assert.equal(after.members.find((m) => m.id === 'b').discordId, BOB);
  assert.equal(after.ownerId, ALICE);
});

// ── 登出撤銷 session ──

test('登出之後，同一個 cookie 不能再使用', async () => {
  const headers = asUser(BOB);
  assert.equal((await j(await fetch(`${BASE}/api/me`, { headers }))).body.user.id, BOB);
  assert.equal((await fetch(`${BASE}/auth/logout`, { method: 'POST', headers })).status, 200);
  assert.equal((await j(await fetch(`${BASE}/api/me`, { headers }))).body.user, null);
  // 別的裝置（另一個 session）不受影響
  assert.equal((await j(await fetch(`${BASE}/api/me`, { headers: asUser(BOB) }))).body.user.id, BOB);
});

// ── 匿名請求、限流、body 大小 ──

test('沒登入時，不管行程存不存在都回 401', async () => {
  const id = await makeTrip();
  assert.equal((await fetch(`${BASE}/api/trip/${id}`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/trip/no-such-trip`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/trip/123456789012345678/${id}`)).status, 401, '舊網址也一樣');
});

test('匿名送大型 body 到帳單辨識：不會解析，直接 401', async () => {
  const r = await fetch(`${BASE}/api/parse-receipt`, { method: 'POST', headers: JSONH, body: JSON.stringify({ image: 'A'.repeat(6 * 1024 * 1024) }) });
  assert.equal(r.status, 401);
});

test('即時匯率：幣別格式錯誤直接 400，不打外部 API', async () => {
  const r = await fetch(`${BASE}/api/fx-rate?from=../x&to=TWD`, { headers: SVC });
  assert.equal(r.status, 400);
});

test('Bot 代為建立行程同樣有頻率限制', async () => {
  const user = '400000000000000077';
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    statuses.push((await fetch(`${BASE}/api/trips`, { method: 'POST', headers: asBot(user), body: JSON.stringify({ name: `t${i}`, guildId: '400000000000000999' }) })).status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
  assert.equal(statuses[10], 429);
});

test('建立行程的基準幣別規則與行程資料一致（可以含數字）', async () => {
  const r = await j(await fetch(`${BASE}/api/trips`, { method: 'POST', headers: asUser(CAROL), body: JSON.stringify({ name: 'usdt', baseCurrency: 'USDT0' }) }));
  assert.equal(r.status, 201);
  assert.equal(r.body.baseCurrency, 'USDT0');
});

// ── 版本還原 ──

test('還原到更換基準幣別之前的版本時，基準幣別一起還原', async () => {
  const id = await makeTrip({ baseCurrency: 'TWD', rates: { TWD: 1 } });
  const v1 = (await j(await fetch(`${BASE}/api/trip/${id}`, { headers: SVC }))).body;
  await fetch(`${BASE}/api/trip/${id}`, { method: 'PUT', headers: SVC, body: JSON.stringify({ ...v1, baseCurrency: 'JPY', rates: { JPY: 1, TWD: 4.5 } }) });
  const r = await j(await fetch(`${BASE}/api/trip/${id}/revisions/${v1.updatedAt}/restore`, { method: 'POST', headers: SVC, body: '{}' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.trip.baseCurrency, 'TWD');
});
