'use strict';
// 回歸測試：操作紀錄（誰、改了什麼）、單筆還原、整份回到某個版本、權限。
// 執行：npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 45600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-history-key';
const OWNER = { 'x-api-key': KEY, 'content-type': 'application/json' };
const JSONH = { 'content-type': 'application/json' };
const ALICE = '300000000000000001';
const SESSION_SECRET = 'y'.repeat(32);
let proc, dataDir, RO, RW, aliceCookie;

function loginCookie(uid, name) {
  process.env.SESSION_SECRET = SESSION_SECRET;
  const session = require('../lib/session');
  let header = [];
  session.writeSession({ getHeader: () => header, setHeader: (_, v) => { header = v; } }, { id: uid, name });
  return header[0].split(';')[0];
}
async function j(res) { return { status: res.status, body: await res.json().catch(() => ({})) }; }
const asAlice = () => ({ ...JSONH, cookie: aliceCookie, 'x-requested-with': 'splitbill' });
const activity = (q = '', base = `${BASE}/api/trip/h1`, headers = OWNER) => fetch(`${base}/activity${q}`, { headers }).then(j);
const putEntry = (kind, id, body, base = `${BASE}/api/trip/h1`, headers = OWNER) =>
  fetch(`${base}/${kind}/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) }).then(j);
const delEntry = (kind, id, base = `${BASE}/api/trip/h1`, headers = OWNER) =>
  fetch(`${base}/${kind}/${id}`, { method: 'DELETE', headers, body: '{}' }).then(j);
const getTrip = () => fetch(`${BASE}/api/trip/h1`, { headers: OWNER }).then(j).then((r) => r.body);
const expense = (extra = {}) => ({
  description: '早餐', amount: 100, currency: 'TWD', amountInBase: 100,
  payers: [{ userId: 'a', amount: 100 }], participants: [{ userId: 'a', amount: 50 }, { userId: 'b', amount: 50 }],
  createdAt: 1700000000000, ...extra,
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-history-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), SPLITBILL_API_KEY: KEY, SPLITBILL_DATA_DIR: dataDir, SESSION_SECRET },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  aliceCookie = loginCookie(ALICE, 'alice_discord');
  await fetch(`${BASE}/api/trip/g/h1`, {
    method: 'PUT', headers: OWNER,
    body: JSON.stringify({ name: '紀錄測試', baseCurrency: 'TWD', rates: { TWD: 1 }, members: [{ id: 'a', name: '阿明', discordId: ALICE }, { id: 'b', name: '小美' }] }),
  });
  RO = (await j(await fetch(`${BASE}/api/trip/h1/links`, { method: 'POST', headers: OWNER, body: JSON.stringify({ guest: 'read' }) }))).body.token;
  RW = (await j(await fetch(`${BASE}/api/trip/h1/links`, { method: 'POST', headers: OWNER, body: JSON.stringify({ guest: 'write', label: '小華' }) }))).body.token;
});

after(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited;
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('建立行程留下第一筆紀錄', async () => {
  const { status, body } = await activity();
  assert.equal(status, 200);
  const last = body.items[body.items.length - 1];
  assert.equal(last.changes[0].type, 'trip.create');
  assert.equal(last.actor.kind, 'admin');
});

test('訪客新增、成員修改、刪除：紀錄寫出是誰、改了哪些欄位，並帶完整內容可以還原', async () => {
  assert.equal((await putEntry('expenses', 'e1', { entry: expense() }, `${BASE}/api/shared-trip/${RW}`, JSONH)).status, 200);
  assert.equal((await putEntry('expenses', 'e1', { entry: expense({ description: '豪華早餐', amount: 120, amountInBase: 120, payers: [{ userId: 'a', amount: 120 }], participants: [{ userId: 'a', amount: 60 }, { userId: 'b', amount: 60 }] }) }, undefined, asAlice())).status, 200);
  assert.equal((await delEntry('expenses', 'e1', undefined, asAlice())).status, 200);

  const { body } = await activity('', undefined, asAlice());
  const [del, edit, add] = body.items;
  assert.equal(add.actor.name, '訪客（小華）');
  assert.equal(add.changes[0].type, 'expense.add');
  assert.equal(add.changes[0].after.description, '早餐');

  assert.equal(edit.actor.name, '阿明', '已連結的成員顯示行程裡的名字');
  assert.equal(edit.actor.isMe, true);
  const fields = edit.changes[0].fields.map((f) => f.field);
  assert.deepEqual(fields, ['description', 'amount', 'amountInBase', 'payers', 'participants']);
  assert.equal(edit.changes[0].before.description, '早餐');

  assert.equal(del.changes[0].type, 'expense.remove');
  assert.equal(del.changes[0].before.description, '豪華早餐');
  assert.ok(!JSON.stringify(body).includes(ALICE), '不能把 Discord ID 送出去');
});

test('單筆還原：用紀錄裡的內容寫回去，紀錄標示為還原', async () => {
  const del = (await activity()).body.items[0];
  const r = await putEntry('expenses', 'e1', { entry: del.changes[0].before, restore: true });
  assert.equal(r.status, 200);
  assert.equal((await getTrip()).expenses.find((e) => e.id === 'e1').description, '豪華早餐');
  const top = (await activity()).body.items[0];
  assert.deepEqual(top.reason, { type: 'restore-entry' });
  assert.equal(top.changes[0].type, 'expense.add');
});

test('內容沒有變動的整包 PUT 不會留下空紀錄', async () => {
  const before0 = (await activity()).body.items.length;
  const t = await getTrip();
  assert.equal((await j(await fetch(`${BASE}/api/trip/h1`, { method: 'PUT', headers: OWNER, body: JSON.stringify(t) }))).status, 200);
  assert.equal((await activity()).body.items.length, before0);
});

test('回到某個版本：之後的修改被蓋掉，已連結的成員保留，紀錄標示來源版本', async () => {
  const target = (await activity()).body.items[0]; // 剛還原 e1 之後的版本
  await putEntry('deposits', 'd1', { entry: { payerId: 'b', collectorId: 'a', amount: 30, currency: 'TWD', amountInBase: 30 } });
  // 把已連結的阿明從名單拿掉（Bot 的整包 PUT 可以做到），之後還原不能讓他消失
  const t = await getTrip();
  await fetch(`${BASE}/api/trip/h1`, { method: 'PUT', headers: OWNER, body: JSON.stringify({ ...t, name: '改過的名字', members: [...t.members, { id: 'c', name: '新來的' }] }) });

  const list = (await activity()).body.items;
  const old = list.find((x) => x.updatedAt === target.updatedAt);
  assert.equal(old.restorable, true);

  // 唯讀連結看得到紀錄，但不能還原
  assert.equal((await activity('', `${BASE}/api/shared-trip/${RO}`, {})).status, 200);
  const denied = await j(await fetch(`${BASE}/api/shared-trip/${RO}/revisions/${target.updatedAt}/restore`, { method: 'POST', headers: JSONH, body: '{}' }));
  assert.equal(denied.status, 403);

  const snap = await j(await fetch(`${BASE}/api/trip/h1/revisions/${target.updatedAt}`, { headers: OWNER }));
  assert.equal(snap.status, 200);
  assert.ok(!snap.body.trip.deposits.length);

  const r = await j(await fetch(`${BASE}/api/trip/h1/revisions/${target.updatedAt}/restore`, { method: 'POST', headers: asAlice(), body: '{}' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.trip.deposits.length, 0);
  assert.equal(r.body.trip.name, '紀錄測試');
  assert.ok(!r.body.trip.members.some((m) => m.id === 'c'), '那個版本沒有的未連結成員會被拿掉');
  assert.equal(r.body.trip.members.find((m) => m.id === 'a').discordId, ALICE, '已連結的成員保留連結');

  const top = (await activity()).body.items[0];
  assert.deepEqual(top.reason, { type: 'restore-revision', from: target.updatedAt });
  assert.ok(top.changes.some((c) => c.type === 'deposit.remove'));
});

test('還原不存在的版本、目前的版本：回錯誤', async () => {
  assert.equal((await j(await fetch(`${BASE}/api/trip/h1/revisions/123/restore`, { method: 'POST', headers: OWNER, body: '{}' }))).status, 404);
  const cur = (await getTrip()).updatedAt;
  assert.equal((await j(await fetch(`${BASE}/api/trip/h1/revisions/${cur}/restore`, { method: 'POST', headers: OWNER, body: '{}' }))).status, 400);
});

test('分頁：limit／before 往前翻，hasMore 正確', async () => {
  const all = (await activity('?limit=100')).body.items;
  const p1 = (await activity('?limit=2')).body;
  assert.equal(p1.items.length, 2);
  assert.equal(p1.hasMore, true);
  const p2 = (await activity(`?limit=100&before=${p1.items[1].updatedAt}`)).body;
  assert.equal(p2.items.length, all.length - 2);
  assert.equal(p2.hasMore, false);
});

test('沒有權限看不到紀錄', async () => {
  assert.equal((await activity('', undefined, {})).status, 401);
  const stranger = loginCookie('300000000000000099', 'x');
  assert.equal((await activity('', undefined, { cookie: stranger })).status, 403);
});
