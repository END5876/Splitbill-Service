'use strict';
// 回歸測試：分享連結與邀請連結合併成「行程連結」（trip.links，見 routes/links.js）。
// 執行：npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 44600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-links-key';
const SESSION_SECRET = 'y'.repeat(32);
const OWNER = { 'x-api-key': KEY, 'content-type': 'application/json' };
const ALICE = '300000000000000001';
const BOB = '300000000000000002';
const CAROL = '300000000000000003';

let proc, dataDir;

async function j(res) { return { status: res.status, body: await res.json().catch(() => ({})) }; }
function cookieFor(uid) {
  process.env.SESSION_SECRET = SESSION_SECRET;
  const session = require('../lib/session');
  let header = [];
  session.writeSession({ getHeader: () => header, setHeader: (_, v) => { header = v; } }, { id: uid, name: 'u' });
  return header[0].split(';')[0];
}
const as = (uid, extra = {}) => ({ cookie: cookieFor(uid), 'x-requested-with': 'splitbill', 'content-type': 'application/json', ...extra });
const createLink = (tripId, body) => fetch(`${BASE}/api/trip/${tripId}/links`, { method: 'POST', headers: OWNER, body: JSON.stringify(body) }).then(j);

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-links-'));
  // 舊格式資料：shareLinks＋invite，啟動時應該自動轉進 links
  fs.writeFileSync(path.join(dataDir, 'splitbill.json'), JSON.stringify({
    version: 2,
    trips: {
      legacy: {
        id: 'legacy', name: '舊行程', baseCurrency: 'TWD', rates: { TWD: 1 }, ownerId: ALICE,
        members: [{ id: 'mA', name: 'A', discordId: ALICE }, { id: 'mB', name: 'B' }],
        expenses: [], deposits: [],
        shareLinks: [{ token: 's'.repeat(48), label: '舊分享', permission: 'write', expiresAt: null, createdAt: 1 }],
        invite: { token: 'i'.repeat(48), createdAt: 2 },
      },
    },
    guilds: {},
  }));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), SPLITBILL_API_KEY: KEY, SPLITBILL_DATA_DIR: dataDir, SESSION_SECRET, OWNER_USER_ID: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch (_) { /* 還沒起來 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
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

test('舊資料轉換：分享連結→訪客連結、邀請連結→只能加入，token 不變', async () => {
  const list = await j(await fetch(`${BASE}/api/trip/legacy/links`, { headers: OWNER }));
  assert.equal(list.status, 200);
  const byToken = Object.fromEntries(list.body.map((l) => [l.token, l]));
  assert.deepEqual([byToken['s'.repeat(48)].guest, byToken['s'.repeat(48)].join], ['write', false]);
  assert.deepEqual([byToken['i'.repeat(48)].guest, byToken['i'.repeat(48)].join], ['none', true]);

  // 舊分享連結照樣能以訪客開啟；舊邀請連結不開放訪客
  assert.equal((await fetch(`${BASE}/api/shared-trip/${'s'.repeat(48)}`)).status, 200);
  const inv = await j(await fetch(`${BASE}/api/shared-trip/${'i'.repeat(48)}`));
  assert.equal(inv.status, 403);
  assert.equal(inv.body.needLogin, true);
});

test('解析連結：匿名看不到 tripId；成員名單只給允許加入的連結', async () => {
  const share = await j(await fetch(`${BASE}/api/link/${'s'.repeat(48)}`));
  assert.equal(share.status, 200);
  assert.equal(share.body.tripName, '舊行程');
  assert.equal(share.body.tripId, null);
  assert.equal(share.body.viewer, null);
  assert.deepEqual(share.body.members, []);

  const invite = await j(await fetch(`${BASE}/api/link/${'i'.repeat(48)}`));
  assert.deepEqual(invite.body.members.map((m) => [m.id, m.linked]), [['mA', true], ['mB', false]]);

  // 本來就是成員的人會拿到 tripId（前端直接用成員身分開啟）
  const mine = await j(await fetch(`${BASE}/api/link/${'s'.repeat(48)}`, { headers: as(ALICE) }));
  assert.equal(mine.body.tripId, 'legacy');
  assert.equal(mine.body.viewer.role, 'owner');

  assert.equal((await fetch(`${BASE}/api/link/${'0'.repeat(48)}`)).status, 404);
});

test('認領：需要登入、連結必須允許加入，認領後就是成員', async () => {
  const claim = (token, uid, body) => fetch(`${BASE}/api/link/${token}/claim`, {
    method: 'POST', headers: uid ? as(uid) : { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(j);

  assert.equal((await claim('i'.repeat(48), null, { memberId: 'mB' })).status, 401);
  assert.equal((await claim('s'.repeat(48), BOB, { memberId: 'mB' })).status, 403, '只開放訪客的連結不能拿來加入');
  assert.equal((await claim('i'.repeat(48), BOB, { memberId: 'mA' })).status, 409, '已連結的成員不能被搶');

  const ok = await claim('i'.repeat(48), BOB, { memberId: 'mB' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.tripId, 'legacy');
  assert.equal((await claim('i'.repeat(48), BOB, { newMemberName: 'B2' })).status, 409, '同一個帳號只能連結一位');

  const trip = await j(await fetch(`${BASE}/api/trip/legacy`, { headers: as(BOB) }));
  assert.equal(trip.status, 200);
  assert.equal(trip.body.links, undefined, '回傳的行程不能帶出連結');
});

test('建立／修改連結：至少要開放訪客或允許加入其中一項', async () => {
  assert.equal((await createLink('legacy', { guest: 'none', join: false })).status, 400);
  assert.equal((await createLink('legacy', { guest: 'admin', join: false })).status, 400);
  const both = await createLink('legacy', { guest: 'read', join: true, label: '朋友' });
  assert.equal(both.status, 201);

  const patch = (body) => fetch(`${BASE}/api/trip/legacy/links/${both.body.token}`, { method: 'PATCH', headers: OWNER, body: JSON.stringify(body) }).then(j);
  assert.equal((await patch({ guest: 'none', join: false })).status, 400);
  const joinOnly = await patch({ guest: 'none' });
  assert.deepEqual([joinOnly.body.guest, joinOnly.body.join], ['none', true]);

  // 成員不能管理連結
  assert.equal((await fetch(`${BASE}/api/trip/legacy/links`, { headers: as(BOB) })).status, 403);
});

test('成員取得預設邀請連結：沿用既有的「只能加入」連結，被撤銷後自動產生新的', async () => {
  const first = await j(await fetch(`${BASE}/api/trip/legacy/invite`, { headers: as(BOB) }));
  assert.equal(first.status, 200);
  assert.equal(first.body.token, 'i'.repeat(48), '沿用最早建立的那條');
  assert.equal((await fetch(`${BASE}/api/trip/legacy/invite`, { headers: as(CAROL) })).status, 403);

  await fetch(`${BASE}/api/trip/legacy/links/${'i'.repeat(48)}`, { method: 'DELETE', headers: OWNER });
  // 上一個測試把「朋友」那條改成只能加入了，它會接手；全部撤銷才會新建
  const list = (await j(await fetch(`${BASE}/api/trip/legacy/links`, { headers: OWNER }))).body;
  for (const l of list.filter((x) => x.join && x.guest === 'none')) {
    await fetch(`${BASE}/api/trip/legacy/links/${l.token}`, { method: 'DELETE', headers: OWNER });
  }
  const fresh = await j(await fetch(`${BASE}/api/trip/legacy/invite`, { headers: as(BOB) }));
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.token, 'i'.repeat(48));
  const info = await j(await fetch(`${BASE}/api/link/${fresh.body.token}`));
  assert.deepEqual([info.body.guest, info.body.join], ['none', true]);
});

test('🔒 整包 PUT 夾帶 links／舊版 shareLinks／invite 都不會變成真的連結', async () => {
  const smuggled = { token: 'x'.repeat(48), label: '', permission: 'write', guest: 'write', join: true, expiresAt: null, createdAt: 1 };
  const cur = (await j(await fetch(`${BASE}/api/trip/legacy`, { headers: as(BOB) }))).body;
  const r = await j(await fetch(`${BASE}/api/trip/legacy`, {
    method: 'PUT', headers: as(BOB),
    body: JSON.stringify({ ...cur, links: [smuggled], shareLinks: [smuggled], invite: { token: 'y'.repeat(48) }, expectedUpdatedAt: cur.updatedAt }),
  }));
  assert.equal(r.status, 200);

  // 可編輯訪客連結的 PUT 也一樣
  const guestLink = (await createLink('legacy', { guest: 'write', join: false })).body.token;
  const cur2 = (await j(await fetch(`${BASE}/api/shared-trip/${guestLink}`))).body.trip;
  const g = await j(await fetch(`${BASE}/api/shared-trip/${guestLink}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...cur2, links: [smuggled], shareLinks: [smuggled], invite: { token: 'y'.repeat(48) }, expectedUpdatedAt: cur2.updatedAt }),
  }));
  assert.equal(g.status, 200);

  for (const t of ['x'.repeat(48), 'y'.repeat(48)]) {
    assert.equal((await fetch(`${BASE}/api/link/${t}`)).status, 404, `夾帶的 token ${t[0]} 不能生效`);
    assert.equal((await fetch(`${BASE}/api/shared-trip/${t}`)).status, 404);
  }
});
