'use strict';
// 回歸測試：分享連結的 token 不可以透過任何「行程資料」的回應被讀到。
// 執行：npm test（會自己啟動一個暫時的 server，資料放在暫存目錄，不會動到正式資料）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 43000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-owner-key';
const OWNER = { 'x-api-key': KEY, 'content-type': 'application/json' };
const JSONH = { 'content-type': 'application/json' };
let proc, dataDir, RO, RW;

async function j(res) { return { status: res.status, body: await res.json().catch(() => ({})) }; }
const T = { name: 't', baseCurrency: 'TWD', rates: { TWD: 1 }, members: [{ id: 'u1', name: 'A' }] };

async function readSse(url, trigger) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  const reader = res.body.getReader();
  let buf = '';
  const done = (async () => {
    const dec = new TextDecoder();
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && !/event: trip-updated/.test(buf)) {
      const { value, done: d } = await reader.read();
      if (d) break;
      buf += dec.decode(value);
      if (/event: trip-updated\ndata: .*\n\n/.test(buf)) break;
    }
  })();
  await new Promise((r) => setTimeout(r, 300));
  await trigger();
  await done;
  ac.abort();
  return buf;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), SPLITBILL_API_KEY: KEY, SPLITBILL_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await fetch(`${BASE}/api/trip/g/t1`, { method: 'PUT', headers: OWNER, body: JSON.stringify(T) });
  RO = (await j(await fetch(`${BASE}/api/trip/g/t1/share-links`, { method: 'POST', headers: OWNER, body: JSON.stringify({ permission: 'read' }) }))).body.token;
  RW = (await j(await fetch(`${BASE}/api/trip/g/t1/share-links`, { method: 'POST', headers: OWNER, body: JSON.stringify({ permission: 'write' }) }))).body.token;
});

after(() => { if (proc) proc.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const leaks = (body) => JSON.stringify(body).includes(RW) || JSON.stringify(body).includes(RO);

test('guest (read-only) GET shared-trip: no shareLinks, no tokens', async () => {
  const { status, body } = await j(await fetch(`${BASE}/api/shared-trip/${RO}`));
  assert.equal(status, 200);
  assert.equal(body.permission, 'read');
  assert.equal(body.trip.shareLinks, undefined);
  assert.equal(leaks(body), false);
});

test('guest cannot escalate: read token cannot write, unknown token is 404', async () => {
  assert.equal((await fetch(`${BASE}/api/shared-trip/${RO}`, { method: 'PUT', headers: JSONH, body: JSON.stringify(T) })).status, 403);
  assert.equal((await fetch(`${BASE}/api/shared-trip/${'0'.repeat(48)}`, { method: 'PUT', headers: JSONH, body: JSON.stringify(T) })).status, 404);
});

test('write-link PUT response and stale-PUT 409 body carry no shareLinks/tokens', async () => {
  const cur = (await j(await fetch(`${BASE}/api/shared-trip/${RW}`))).body.trip;
  const ok = await j(await fetch(`${BASE}/api/shared-trip/${RW}`, { method: 'PUT', headers: JSONH, body: JSON.stringify({ ...cur, expectedUpdatedAt: cur.updatedAt }) }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.trip.shareLinks, undefined);
  assert.equal(leaks(ok.body), false);
  const stale = await j(await fetch(`${BASE}/api/shared-trip/${RW}`, { method: 'PUT', headers: JSONH, body: JSON.stringify({ ...cur, expectedUpdatedAt: cur.updatedAt }) }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentTrip.shareLinks, undefined);
  assert.equal(leaks(stale.body), false);
});

test('owner GET trip / PUT response / guild list carry no shareLinks/tokens', async () => {
  const g = await j(await fetch(`${BASE}/api/trip/g/t1`, { headers: OWNER }));
  assert.equal(g.body.shareLinks, undefined); assert.equal(leaks(g.body), false);
  const p = await j(await fetch(`${BASE}/api/trip/g/t1`, { method: 'PUT', headers: OWNER, body: JSON.stringify({ ...g.body, expectedUpdatedAt: g.body.updatedAt }) }));
  assert.equal(p.status, 200); assert.equal(p.body.shareLinks, undefined); assert.equal(leaks(p.body), false);
  const guild = await j(await fetch(`${BASE}/api/guild/g`, { headers: OWNER }));
  assert.equal(guild.status, 200); assert.equal(leaks(guild.body), false);
  assert.equal(guild.body.trips.t1.shareLinks, undefined);
});

test('share-token holder using GET /api/trip sees no tokens either', async () => {
  const r = await j(await fetch(`${BASE}/api/trip/g/t1`, { headers: { 'x-api-key': RO } }));
  assert.equal(r.status, 200); assert.equal(leaks(r.body), false);
});

test('SSE trip-updated (guest connection) carries no shareLinks/tokens', async () => {
  const buf = await readSse(`${BASE}/api/shared-trip/${RO}/events`, async () => {
    const cur = (await j(await fetch(`${BASE}/api/trip/g/t1`, { headers: OWNER }))).body;
    await fetch(`${BASE}/api/trip/g/t1`, { method: 'PUT', headers: OWNER, body: JSON.stringify({ ...cur, name: 't-renamed', expectedUpdatedAt: cur.updatedAt }) });
  });
  assert.match(buf, /event: trip-updated/);
  assert.equal(buf.includes(RW) || buf.includes('shareLinks'), false);
});

test('regression: owner-only share-link management still works and links survive PUTs', async () => {
  const list = await j(await fetch(`${BASE}/api/trip/g/t1/share-links`, { headers: OWNER }));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((l) => l.token).sort(), [RO, RW].sort()); // 擁有者專用端點仍看得到 token
  // 擁有者送 shareLinks: [] 的整包 PUT 也不會洗掉分享連結
  const cur = (await j(await fetch(`${BASE}/api/trip/g/t1`, { headers: OWNER }))).body;
  await fetch(`${BASE}/api/trip/g/t1`, { method: 'PUT', headers: OWNER, body: JSON.stringify({ ...cur, shareLinks: [], expectedUpdatedAt: cur.updatedAt }) });
  assert.equal((await j(await fetch(`${BASE}/api/trip/g/t1/share-links`, { headers: OWNER }))).body.length, 2);
  // 分享連結持有者不能碰擁有者專用端點
  assert.equal((await fetch(`${BASE}/api/trip/g/t1/share-links`, { headers: { 'x-api-key': RW } })).status, 403);
  // 權限切換與撤銷仍有效
  assert.equal((await fetch(`${BASE}/api/trip/g/t1/share-links/${RO}`, { method: 'PATCH', headers: OWNER, body: JSON.stringify({ permission: 'write' }) })).status, 200);
  assert.equal((await fetch(`${BASE}/api/trip/g/t1/share-links/${RO}`, { method: 'DELETE', headers: OWNER })).status, 200);
  assert.equal((await fetch(`${BASE}/api/shared-trip/${RO}`)).status, 404);
});
