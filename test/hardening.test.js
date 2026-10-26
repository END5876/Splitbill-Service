'use strict';
// 回歸測試：schema 版本守門與遷移（v2：舊版成員 id）、保留不認得的欄位（回滾防護）、
// 正式環境拒絕以空帳本啟動、/healthz 的資料層狀態、訪客看不到記帳者的 Discord ID、
// SSE 換票只開放給金鑰。
// 執行：npm test（資料都放在暫存目錄，不會動到正式資料）
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KEY = 'test-owner-key';
const SESSION_SECRET = 'h'.repeat(32);
const OWNER = { 'x-api-key': KEY, 'content-type': 'application/json' };
const ALICE = '200000000000000002';
const BOB = '300000000000000003';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hardening-')); }
async function j(res) { return { status: res.status, body: await res.json().catch(() => ({})) }; }

function freshStorage(dataDir, env = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, 'lib') + path.sep)) delete require.cache[k];
  }
  const saved = {};
  const all = { SPLITBILL_DATA_DIR: dataDir, ...env };
  for (const [k, v] of Object.entries(all)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    return require(path.join(ROOT, 'lib', 'storage.js'));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function openRaw(dir) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path.join(dir, 'splitbill.db'));
}

async function startServer(dataDir, extraEnv = {}) {
  const port = 46000 + Math.floor(Math.random() * 1500);
  const base = `http://127.0.0.1:${port}`;
  let stderr = '';
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SPLITBILL_API_KEY: KEY, SPLITBILL_DATA_DIR: dataDir, SESSION_SECRET, ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => proc.once('exit', (code) => r(code)));
  for (let i = 0; i < 60; i++) {
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 100))]);
    if (code !== undefined) return { exitCode: code, stderr };
    try { if ((await fetch(`${base}/healthz`)).status) break; } catch (_) { /* not up yet */ }
  }
  return { proc, base, stderr: () => stderr, async stop() { proc.kill('SIGTERM'); await exited; } };
}

function loginCookie(uid) {
  process.env.SESSION_SECRET = SESSION_SECRET;
  const session = require('../lib/session');
  let header = '';
  session.writeSession({ getHeader: () => header, setHeader: (_, v) => { header = v; } }, { id: uid, name: 'u' });
  return String(Array.isArray(header) ? header[0] : header).split(';')[0];
}

// 建立一個 schema v1 的資料庫：一個行程有兩位舊版成員（id＝Discord ID），帶一份歷史版本與一筆操作紀錄
function makeV1Database(dir) {
  const storage = freshStorage(dir);
  storage.loadAll();
  storage.close();
  const db = openRaw(dir);
  const trip = {
    id: 'legacy', name: '舊行程', baseCurrency: 'TWD', rates: { TWD: 1 }, guildId: null, ownerId: ALICE,
    members: [{ id: ALICE, name: 'A', discordId: ALICE }, { id: BOB, name: 'B' }, { id: 'mem_keep', name: 'C' }],
    expenses: [{
      id: 'e1', description: '晚餐', amount: 300, currency: 'TWD', amountInBase: 300,
      payers: [{ userId: ALICE, amount: 300 }], participants: [{ userId: ALICE, amount: 150 }, { userId: BOB, amount: 150 }],
      createdAt: 1, createdBy: ALICE,
    }, {
      // 已經被移除、也不在任何保留的歷史版本裡的成員，帳目裡仍引用著他
      id: 'e2', description: '計程車', amount: 100, currency: 'TWD', amountInBase: 100,
      payers: [{ userId: '500000000000000005', amount: 100 }], participants: [{ userId: '500000000000000005', amount: 100 }],
      createdAt: 2, createdBy: 'web-ui',
    }],
    deposits: [{ id: 'd1', collectorId: ALICE, payerId: BOB, amount: 150, currency: 'TWD', amountInBase: 150, note: '', createdAt: 2 }],
    links: [], archived: false, createdAt: 1, updatedAt: 5000,
  };
  db.prepare('INSERT INTO trips (id, guild_id, owner_id, updated_at, created_at, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy', null, ALICE, 5000, 1, JSON.stringify(trip));
  db.prepare('INSERT INTO trip_revisions (trip_id, updated_at, saved_at, data) VALUES (?, ?, ?, ?)')
    .run('legacy', 4000, 1, JSON.stringify({ ...trip, updatedAt: 4000, members: [...trip.members, { id: '400000000000000004', name: '已刪除' }] }));
  const activity = {
    updatedAt: 5000, at: 1, actor: { kind: 'user', name: 'A', userId: ALICE },
    changes: [{ type: 'expense.add', id: 'e1', label: '晚餐', after: trip.expenses[0] }, { type: 'member.add', id: BOB, label: 'B' }],
  };
  db.prepare('INSERT INTO trip_activity (trip_id, updated_at, at, data) VALUES (?, ?, ?, ?)')
    .run('legacy', 5000, 1, JSON.stringify(activity));
  db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  db.close();
}

describe('schema 版本', () => {
  test('資料庫比程式新：拒絕啟動，資料不動', () => {
    const dir = tmpDir();
    try {
      const storage = freshStorage(dir);
      storage.loadAll();
      storage.close();
      const db = openRaw(dir);
      db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
      db.close();
      const again = freshStorage(dir);
      assert.throws(() => again.loadAll(), /較新版本的程式/);
      const check = openRaw(dir);
      assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '99');
      check.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('v1 → v2：舊版成員 id 換成 mem_，帳目、歷史版本、操作紀錄的引用一起改，discordId 與操作者不動', () => {
    const dir = tmpDir();
    try {
      makeV1Database(dir);
      const storage = freshStorage(dir);
      const trip = storage.loadAll().trips.legacy;
      const [a, b, c] = trip.members;
      assert.match(a.id, /^mem_[0-9a-f]{8}$/);
      assert.match(b.id, /^mem_[0-9a-f]{8}$/);
      assert.notEqual(a.id, b.id);
      assert.equal(c.id, 'mem_keep', '本來就不是 Discord ID 的不改');
      assert.equal(a.discordId, ALICE, 'discordId 不變，Bot 照樣找得到');
      assert.deepEqual(trip.expenses[0].payers, [{ userId: a.id, amount: 300 }]);
      assert.deepEqual(trip.expenses[0].participants.map((p) => p.userId), [a.id, b.id]);
      assert.equal(trip.expenses[0].createdBy, ALICE, 'createdBy 是記帳者，不是成員引用');
      assert.equal(trip.deposits[0].collectorId, a.id);
      assert.equal(trip.deposits[0].payerId, b.id);
      assert.equal(trip.updatedAt, 5001, '版本號加 1，開著舊頁面的分頁會拿到 409');
      const orphan = trip.expenses[1].payers[0].userId;
      assert.match(orphan, /^mem_/, '只剩帳目引用的舊成員 id 也要換掉');
      assert.equal(trip.expenses[1].participants[0].userId, orphan);
      assert.ok(!JSON.stringify(trip).includes('500000000000000005'));

      const rev = storage.getTripRevision('legacy', 4000);
      assert.equal(rev.members[0].id, a.id);
      assert.match(rev.members[3].id, /^mem_/, '只出現在舊版本裡的成員也要換');
      assert.equal(rev.expenses[0].payers[0].userId, a.id);

      const [act] = storage.listTripActivity('legacy');
      assert.equal(act.actor.userId, ALICE, '操作者是 Discord 使用者，不能被換掉');
      assert.equal(act.changes[0].after.payers[0].userId, a.id);
      assert.equal(act.changes[1].id, b.id);
      storage.close();

      const db = openRaw(dir);
      assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
      db.close();
      assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => /^splitbill-pre-v2-\d+\.db$/.test(f)), '遷移前要先備份');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('保留不認得的欄位（回滾防護）', () => {
  test('從資料庫載入再存回：較新版本寫的欄位不會被剝掉', () => {
    const dir = tmpDir();
    try {
      const s1 = freshStorage(dir);
      s1.loadAll();
      s1.close();
      const db = openRaw(dir);
      const trip = {
        id: 'future', name: '新版行程', baseCurrency: 'TWD', rates: { TWD: 1 },
        members: [{ id: 'm1', name: 'A', nickname: 'aa' }],
        expenses: [{ id: 'e1', description: 'x', amount: 1, currency: 'TWD', amountInBase: 1, payers: [], participants: [], createdAt: 1, createdBy: 'web-ui', tags: ['food'] }],
        deposits: [], links: [], archived: false, createdAt: 1, updatedAt: 10, budget: { total: 1000 },
      };
      db.prepare('INSERT INTO trips (id, updated_at, created_at, data) VALUES (?, ?, ?, ?)').run('future', 10, 1, JSON.stringify(trip));
      db.close();

      const s2 = freshStorage(dir);
      const loaded = s2.getTrip('future');
      assert.deepEqual(loaded.budget, { total: 1000 });
      assert.deepEqual(loaded.expenses[0].tags, ['food']);
      assert.equal(loaded.members[0].nickname, 'aa');
      loaded.name = '改名';
      s2.touchTrip(loaded);
      s2.persist();
      s2.close();

      const s3 = freshStorage(dir);
      const again = s3.getTrip('future');
      assert.equal(again.name, '改名');
      assert.deepEqual(again.budget, { total: 1000 }, '存回資料庫後還在');
      assert.deepEqual(again.expenses[0].tags, ['food']);
      s3.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('客戶端送來的不認得欄位照樣丟掉；伺服器原本的接回去；discordId 不能被帶進來', () => {
    const dir = tmpDir();
    try {
      const storage = freshStorage(dir);
      const existing = storage.repairTrip({
        id: 't', members: [{ id: 'm1', name: 'A', discordId: ALICE, nickname: 'aa' }],
        expenses: [{ id: 'e1', description: 'x', amount: 1, tags: ['food'] }], budget: 5,
      }, { keepUnknown: true });
      assert.equal(existing.budget, 5);

      const incoming = storage.repairTrip({
        id: 't', evil: 'x', __proto__: { polluted: true },
        members: [{ id: 'm1', name: 'A2' }], expenses: [{ id: 'e1', description: 'y', amount: 2, injected: 1 }],
      });
      assert.equal(incoming.evil, undefined);
      assert.equal(incoming.expenses[0].injected, undefined);
      storage.preserveUnknownFields(existing, incoming);
      assert.equal(incoming.budget, 5);
      assert.deepEqual(incoming.expenses[0].tags, ['food']);
      assert.equal(incoming.members[0].nickname, 'aa');
      assert.equal(incoming.members[0].discordId, undefined, 'discordId 不是「不認得的欄位」，不能被接回去');
      assert.equal({}.polluted, undefined);

      const noLink = storage.repairTrip({ id: 't', members: [{ id: 'm1', name: 'A', discordId: 'not-a-snowflake' }] }, { keepUnknown: true });
      assert.equal(noLink.members[0].discordId, undefined);
      storage.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('正式環境拒絕以空帳本啟動', () => {
  test('沒有資料：拒絕；設定 SPLITBILL_ALLOW_EMPTY_INIT=1 才建立', () => {
    const dir = tmpDir();
    try {
      withEnv({ NODE_ENV: 'production', SPLITBILL_ALLOW_EMPTY_INIT: undefined }, () => {
        const s = freshStorage(dir);
        assert.throws(() => s.loadAll(), /拒絕以空帳本啟動/);
        s.close();
      });
      withEnv({ NODE_ENV: 'production', SPLITBILL_ALLOW_EMPTY_INIT: '1' }, () => {
        const s = freshStorage(dir);
        s.loadAll();
        s.close();
      });
      // 已經初始化過，之後不需要這個變數
      withEnv({ NODE_ENV: 'production', SPLITBILL_ALLOW_EMPTY_INIT: undefined }, () => {
        const s = freshStorage(dir);
        s.loadAll();
        s.close();
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('訪客看不到記帳者的 Discord ID', () => {
  test('toGuestTrip／toGuestActivity 遮蔽 createdBy；訪客存回時沿用伺服器上的值', () => {
    const dir = tmpDir();
    try {
      const storage = freshStorage(dir);
      const trip = storage.repairTrip({
        id: 't', members: [{ id: 'm1', name: 'A' }],
        expenses: [{ id: 'e1', description: 'x', amount: 1, createdBy: ALICE }, { id: 'e2', description: 'y', amount: 1, createdBy: 'web-ui' }],
      });
      const guest = storage.toGuestTrip(trip);
      assert.equal(guest.expenses[0].createdBy, 'discord');
      assert.equal(guest.expenses[1].createdBy, 'web-ui');
      assert.equal(trip.expenses[0].createdBy, ALICE, '原物件不動');

      const act = storage.toGuestActivity({ changes: [{ type: 'expense.edit', before: trip.expenses[0], after: trip.expenses[0] }] });
      assert.equal(act.changes[0].before.createdBy, 'discord');
      assert.equal(act.changes[0].after.createdBy, 'discord');

      const back = storage.repairTrip({
        id: 't', expenses: [{ ...guest.expenses[0] }, { id: 'e3', description: 'z', amount: 1, createdBy: BOB }],
      });
      storage.restoreGuestCreatedBy(trip, back);
      assert.equal(back.expenses[0].createdBy, ALICE, '既有的支出沿用伺服器上的記帳者');
      assert.equal(back.expenses[1].createdBy, 'web-ui', '訪客新增的不能自稱是某個 Discord 使用者');
      storage.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HTTP', () => {
  test('/healthz 回報資料層狀態；SSE 換票只開放給金鑰；訪客 API 不帶記帳者的 Discord ID', async () => {
    const dir = tmpDir();
    const s = await startServer(dir);
    try {
      const health = await j(await fetch(`${s.base}/healthz`));
      assert.equal(health.status, 200);
      assert.equal(health.body.ok, true);
      assert.equal(health.body.db, 'ok');
      assert.equal(typeof health.body.backup.ok, 'boolean');
      assert.ok(health.body.backup.lastSuccessAt, '啟動時會先備份一次');
      assert.ok(health.body.freeMB === null || health.body.freeMB > 0);

      const svc = await j(await fetch(`${s.base}/api/sse-ticket`, { method: 'POST', headers: OWNER }));
      assert.equal(svc.status, 200);
      assert.ok(svc.body.ticket);
      const user = await j(await fetch(`${s.base}/api/sse-ticket`, {
        method: 'POST', headers: { cookie: loginCookie(ALICE), 'x-requested-with': 'splitbill', 'content-type': 'application/json' },
      }));
      assert.equal(user.status, 403);

      // 從 Discord 記的支出（Bot 帶 createdBy＝Discord ID），訪客讀取與單筆編輯的回應都不帶出來
      const put = await j(await fetch(`${s.base}/api/trip/gt`, {
        method: 'PUT', headers: OWNER,
        body: JSON.stringify({ name: 'g', members: [{ id: 'm1', name: 'A' }], expenses: [{ id: 'e1', description: 'x', amount: 1, currency: 'TWD', amountInBase: 1, payers: [{ userId: 'm1', amount: 1 }], participants: [{ userId: 'm1', amount: 1 }], createdBy: ALICE }] }),
      }));
      assert.equal(put.status, 200);
      const link = await j(await fetch(`${s.base}/api/trip/gt/links`, { method: 'POST', headers: OWNER, body: JSON.stringify({ guest: 'write' }) }));
      const token = link.body.link ? link.body.link.token : link.body.token;
      assert.ok(token, JSON.stringify(link.body));
      const shared = await j(await fetch(`${s.base}/api/shared-trip/${token}`));
      assert.equal(shared.body.trip.expenses[0].createdBy, 'discord');
      const edit = await j(await fetch(`${s.base}/api/shared-trip/${token}/expenses/e1`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entry: { ...shared.body.trip.expenses[0], description: 'y' } }),
      }));
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
      assert.equal(edit.body.entry.createdBy, 'discord');
      const after = await j(await fetch(`${s.base}/api/trip/gt`, { headers: OWNER }));
      assert.equal(after.body.expenses[0].createdBy, ALICE, '伺服器上的記帳者不變');
      const activity = await j(await fetch(`${s.base}/api/shared-trip/${token}/activity`));
      assert.ok(!JSON.stringify(activity.body).includes(ALICE), '訪客的操作紀錄不能出現 Discord ID');

      // 訪客刪掉再「還原」這筆支出（拿到的 createdBy 是遮蔽過的）：伺服器從操作紀錄找回原本的記帳者
      const del = await fetch(`${s.base}/api/shared-trip/${token}/expenses/e1`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(del.status, 200);
      const removed = (await j(await fetch(`${s.base}/api/shared-trip/${token}/activity`))).body.items
        .flatMap((a) => a.changes).find((c) => c.type === 'expense.remove' && c.id === 'e1');
      assert.equal(removed.before.createdBy, 'discord');
      const restore = await j(await fetch(`${s.base}/api/shared-trip/${token}/expenses/e1`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry: removed.before, restore: true }),
      }));
      assert.equal(restore.status, 200, JSON.stringify(restore.body));
      assert.equal((await j(await fetch(`${s.base}/api/trip/gt`, { headers: OWNER }))).body.expenses[0].createdBy, ALICE, '還原後記帳者不變');
    } finally {
      await s.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
