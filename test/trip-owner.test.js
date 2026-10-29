'use strict';
// 回歸測試：行程建立者（ownerId）不可被竄改；刪除行程時若宣告操作者，只有建立者／OWNER_USER_ID 可刪。
// 執行：npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 44000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-owner-key';
const OWNER = { 'x-api-key': KEY, 'content-type': 'application/json' };
// x-actor-id 必須是 Discord snowflake（17～20 位數字），否則會被忽略、當成管理端（見 lib/auth.js）
const ALICE = '300000000000000001';
const BOB = '300000000000000002';
const MALLORY = '300000000000000003';
const BOTOWNER = '300000000000000009';
let proc, dataDir, RW;
const SESSION_SECRET = 'x'.repeat(32);
// 產生 Discord 登入的 session cookie（跟伺服器用同一把 SESSION_SECRET 簽章）
function loginCookie(uid) {
  process.env.SESSION_SECRET = SESSION_SECRET;
  const session = require('../lib/session');
  let header = [];
  session.writeSession({ getHeader: () => header, setHeader: (_, v) => { header = v; } }, { id: uid, name: 'u' });
  return header[0].split(';')[0];
}

async function j(res) { return { status: res.status, body: await res.json().catch(() => ({})) }; }
const trip = (extra = {}) => ({ name: 't', baseCurrency: 'TWD', rates: { TWD: 1 }, members: [{ id: 'ALICE', name: 'A' }], ...extra });
const put = (id, body, headers = OWNER) => fetch(`${BASE}/api/trip/g/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) }).then(j);
const get = (id) => fetch(`${BASE}/api/trip/g/${id}`, { headers: OWNER }).then(j);
const del = (id, actor) => fetch(`${BASE}/api/trip/g/${id}`, { method: 'DELETE', headers: actor ? { ...OWNER, 'x-actor-id': actor } : OWNER }).then(j);

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-owner-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), SPLITBILL_API_KEY: KEY, SPLITBILL_DATA_DIR: dataDir, OWNER_USER_ID: BOTOWNER, SESSION_SECRET },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(async () => {
  // 先等子行程真的結束再刪資料夾：Windows 上行程還沒放開 splitbill.db 時刪除會 EBUSY
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited;
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('新行程的 ownerId 會被保存並在 GET 回傳', async () => {
  const r = await put('o1', trip({ ownerId: ALICE }));
  assert.equal(r.status, 200);
  assert.equal((await get('o1')).body.ownerId, ALICE);
});

test('非字串 ownerId 會被移除', async () => {
  await put('o2', trip({ ownerId: { evil: 1 } }));
  assert.equal('ownerId' in (await get('o2')).body, false);
});

test('已存在行程的 ownerId 不可被 PUT 改掉（擁有者金鑰也不行）', async () => {
  const cur = (await get('o1')).body;
  await put('o1', { ...cur, ownerId: MALLORY });
  assert.equal((await get('o1')).body.ownerId, ALICE);
});

test('持有可編輯分享連結的人不能改 ownerId', async () => {
  RW = (await j(await fetch(`${BASE}/api/trip/g/o1/links`, { method: 'POST', headers: OWNER, body: JSON.stringify({ guest: 'write' }) }))).body.token;
  const cur = (await get('o1')).body;
  const r = await fetch(`${BASE}/api/shared-trip/${RW}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...cur, ownerId: MALLORY, expectedUpdatedAt: cur.updatedAt }) }).then(j);
  assert.equal(r.status, 200);
  assert.equal((await get('o1')).body.ownerId, ALICE);
});

test('DELETE：非建立者的操作者被拒絕，行程仍在', async () => {
  const r = await del('o1', BOB);
  assert.equal(r.status, 403);
  assert.equal((await get('o1')).status, 200);
});

test('DELETE：建立者可以刪除', async () => {
  await put('o3', trip({ ownerId: ALICE }));
  assert.equal((await del('o3', ALICE)).status, 200);
  assert.equal((await get('o3')).status, 404);
});

test('DELETE：OWNER_USER_ID 名單內的人可以刪別人的行程', async () => {
  await put('o4', trip({ ownerId: ALICE }));
  assert.equal((await del('o4', BOTOWNER)).status, 200);
});

test('DELETE：沒帶 x-actor-id（擁有者金鑰）維持原行為', async () => {
  await put('o5', trip({ ownerId: ALICE }));
  assert.equal((await del('o5')).status, 200);
});

test('PUT：Bot 代使用者（x-actor-id）可以更新既有行程，但不能把剛刪掉的行程建回來', async () => {
  const asAlice = { ...OWNER, 'x-actor-id': ALICE };
  await put('o6', trip({ ownerId: ALICE }));
  const cur = (await get('o6')).body;
  const putDirect = (body) => fetch(`${BASE}/api/trip/o6`, { method: 'PUT', headers: asAlice, body: JSON.stringify(body) }).then(j);
  assert.equal((await putDirect({ ...cur, name: '改名' })).status, 200);
  const stale = (await get('o6')).body;
  assert.equal((await del('o6', ALICE)).status, 200);
  const r = await putDirect({ ...stale, name: '舊資料' });
  assert.equal(r.status, 404);
  assert.equal((await get('o6')).status, 404, '刪掉的行程不能被 Bot 的舊資料建回來');
});

test('DELETE：分享連結（含可編輯）仍然不能刪', async () => {
  // 分享 token 不能當成 x-api-key 用：金鑰不對一律 401
  const r = await fetch(`${BASE}/api/trip/g/o1`, { method: 'DELETE', headers: { 'x-api-key': RW, 'x-actor-id': ALICE } }).then(j);
  assert.equal(r.status, 401);
});

test('Bot 擁有者用 Discord 登入：/api/me 標示 admin，?all=1 列出所有行程', async () => {
  const me = await fetch(`${BASE}/api/me`, { headers: { cookie: loginCookie(BOTOWNER) } }).then(j);
  assert.equal(me.body.user.admin, true);
  const mine = await fetch(`${BASE}/api/my/trips`, { headers: { cookie: loginCookie(BOTOWNER) } }).then(j);
  const all = await fetch(`${BASE}/api/my/trips?all=1`, { headers: { cookie: loginCookie(BOTOWNER) } }).then(j);
  assert.equal(all.status, 200);
  assert.ok(all.body.trips.length > mine.body.trips.length);
  assert.ok(all.body.trips.some((t) => t.id === 'o1' && t.role === 'admin'));
});

test('一般使用者帶 ?all=1 只會看到自己的行程', async () => {
  const me = await fetch(`${BASE}/api/me`, { headers: { cookie: loginCookie(BOB) } }).then(j);
  assert.equal(me.body.user.admin, false);
  const all = await fetch(`${BASE}/api/my/trips?all=1`, { headers: { cookie: loginCookie(BOB) } }).then(j);
  assert.equal(all.status, 200);
  assert.ok(!all.body.trips.some((t) => t.id === 'o1'));
});
