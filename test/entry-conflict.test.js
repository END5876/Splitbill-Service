'use strict';
// 單筆寫入的衝突檢查（body.base）：見 routes/entries.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 45600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const H = { 'x-api-key': 'conflict-key', 'content-type': 'application/json' };
let proc, dataDir, guest;

const call = async (method, url, body, headers = H) => {
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const put = (id, entry, extra = {}) => call('PUT', `/api/trip/t1/expenses/${id}`, { entry, ...extra });
const del = (id, extra = {}) => call('DELETE', `/api/trip/t1/expenses/${id}`, extra);
const exp = (description, amount = 100) => ({
  description, amount, currency: 'TWD', amountInBase: amount, createdAt: 1700000000000,
  payers: [{ userId: 'a', amount }], participants: [{ userId: 'b', amount }],
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-conflict-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), SPLITBILL_API_KEY: 'conflict-key', SPLITBILL_DATA_DIR: dataDir, GEMINI_API_KEY: '' },
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* 還沒起來 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await call('PUT', '/api/trip/g/t1', { name: 't', baseCurrency: 'TWD', rates: { TWD: 1 }, members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  guest = (await call('POST', '/api/trip/t1/links', { guest: 'write' })).body.token;
});
after(async () => {
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill();
  await exited;
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('base 相符可以寫，不符回 409 並附上目前內容、不覆蓋', async () => {
  const v1 = (await put('e1', exp('晚餐'), { base: null })).body.entry;
  const ok = await put('e1', exp('改一'), { base: v1 });
  assert.equal(ok.status, 200);
  const bad = await put('e1', exp('改二'), { base: v1 });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.conflict, 'changed');
  assert.equal(bad.body.current.description, '改一');
  assert.equal((await call('GET', '/api/trip/t1')).body.expenses.find((e) => e.id === 'e1').description, '改一');
});

test('重送同樣內容不算衝突（上次有存到、只是沒收到回應）', async () => {
  assert.equal((await put('e2', exp('午餐'), { base: null })).status, 200);
  assert.equal((await put('e2', exp('午餐'), { base: null })).status, 200);
  const other = await put('e2', exp('別的'), { base: null });
  assert.equal(other.body.conflict, 'changed');
});

test('已被刪除：回 409 deleted；base 為 null 可以重新建立', async () => {
  const v1 = (await put('e3', exp('門票'))).body.entry;
  assert.equal((await del('e3', { base: v1 })).body.deleted, true);
  const r = await put('e3', exp('門票改'), { base: v1 });
  assert.equal(r.status, 409);
  assert.equal(r.body.conflict, 'deleted');
  assert.equal(r.body.current, null);
  assert.equal((await put('e3', exp('門票改'), { base: null })).status, 200);
});

test('刪除：對方改過就回 409；已經不在了仍算成功', async () => {
  const v1 = (await put('e4', exp('車票'))).body.entry;
  await put('e4', exp('車票改'));
  assert.equal((await del('e4', { base: v1 })).status, 409);
  assert.equal((await del('e4')).body.deleted, true);
  assert.equal((await del('e4', { base: v1 })).body.deleted, false);
});

test('沒帶 base（舊版網頁）與 restore 維持原行為', async () => {
  await put('e5', exp('一'));
  assert.equal((await put('e5', exp('二'))).status, 200);
  assert.equal((await put('e5', exp('三'), { base: exp('不對'), restore: true })).status, 200);
});

test('轉帳同樣檢查；訪客的 409 不帶記帳者帳號，也不會因為遮蔽而誤判衝突', async () => {
  const dep = { payerId: 'a', collectorId: 'b', amount: 5, currency: 'TWD', amountInBase: 5, note: '', createdAt: 1700000000000 };
  const url = '/api/trip/t1/deposits/d1';
  const v1 = (await call('PUT', url, { entry: dep, base: null }, { ...H, 'x-actor-id': '500000000000000001' })).body;
  if (v1.error) await call('PUT', url, { entry: dep, base: null }); // 這個使用者不是成員：改用管理端寫
  const g = { 'content-type': 'application/json' };
  const gurl = `/api/shared-trip/${guest}/deposits/d1`;
  const seen = (await call('GET', `/api/shared-trip/${guest}`, undefined, g)).body.trip.deposits[0];
  assert.equal((await call('PUT', gurl, { entry: { ...dep, amount: 6, amountInBase: 6 }, base: seen }, g)).status, 200);
  const r = await call('PUT', gurl, { entry: { ...dep, amount: 7, amountInBase: 7 }, base: seen }, g);
  assert.equal(r.status, 409);
  assert.equal(r.body.current.amount, 6);
  assert.ok(!/\d{17,20}/.test(String(r.body.current.createdBy || '')));
});
