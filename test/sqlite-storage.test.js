'use strict';
// SQLite 儲存層的測試：舊 JSON 匯入、損毀時拒絕啟動、重啟後資料仍在、樂觀鎖版本號、
// 寫入失敗回滾、SSE 事件延到寫入成功之後、歷史版本、每日備份。
// 執行：npm test（資料都放在暫存目錄，不會動到正式資料）
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KEY = 'test-owner-key';
const G = '100000000000000001';
const OWNER = { 'x-api-key': KEY, 'content-type': 'application/json' };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sqlite-')); }
async function j(res) { return { status: res.status, body: await res.json().catch(() => ({})) }; }

// ───────────── 啟動一個真的 server（子行程） ─────────────
async function startServer(dataDir, extraEnv = {}) {
  const port = 44000 + Math.floor(Math.random() * 1500);
  const base = `http://127.0.0.1:${port}`;
  let stderr = '';
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SPLITBILL_API_KEY: KEY, SPLITBILL_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => proc.once('exit', (code) => r(code)));
  for (let i = 0; i < 60; i++) {
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 100))]);
    if (code !== undefined) return { proc, base, exitCode: code, stderr };
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (_) { /* not up yet */ }
  }
  return {
    proc, base, stderr: () => stderr,
    async stop() { proc.kill('SIGTERM'); await exited; },
  };
}

// ───────────── 在同一個行程裡直接載入 storage（每次都是全新模組） ─────────────
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

function makeTrip(storage, id, extra = {}) {
  const t = storage.repairTrip({ id, name: id, members: [{ id: 'm1', name: 'A' }], ...extra });
  storage.setTrip(t);
  storage.touchTrip(t);
  storage.persist();
  return t;
}

const V2_JSON = {
  version: 2,
  trips: {
    t1: {
      id: 't1', name: '舊行程', baseCurrency: 'TWD', rates: { TWD: 1 }, guildId: G, ownerId: '200000000000000002',
      members: [{ id: '200000000000000002', name: 'A', discordId: '200000000000000002' }],
      expenses: [{ id: 'e1', description: '晚餐', amount: 300, currency: 'TWD', amountInBase: 300, payers: [], participants: [], createdAt: 1, createdBy: 'x' }],
      deposits: [], shareLinks: [{ token: 'a'.repeat(48), label: '', permission: 'read', expiresAt: null, createdAt: 1 }],
      archived: false, createdAt: 1, updatedAt: 1000,
    },
  },
  guilds: { [G]: { defaultTripId: 't1', activeTripByUser: {} } },
};

describe('從舊的 splitbill.json 匯入', () => {
  test('v2 JSON：資料、分享連結、伺服器指標都匯入，原檔改名，並產生備份', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'splitbill.json'), JSON.stringify(V2_JSON));
    const s = await startServer(dir);
    try {
      const trip = await j(await fetch(`${s.base}/api/trip/t1`, { headers: OWNER }));
      assert.equal(trip.status, 200);
      assert.equal(trip.body.name, '舊行程');
      assert.equal(trip.body.expenses[0].amount, 300);
      assert.equal(trip.body.updatedAt, 1000);
      assert.equal(trip.body.shareLinks, undefined, '回應仍然不能帶出分享連結');

      const shared = await j(await fetch(`${s.base}/api/shared-trip/${'a'.repeat(48)}`));
      assert.equal(shared.status, 200, '匯入的分享連結要能用');

      const guild = await j(await fetch(`${s.base}/api/guild/${G}`, { headers: OWNER }));
      assert.equal(guild.body.defaultTripId, 't1');

      const files = fs.readdirSync(dir);
      assert.ok(!files.includes('splitbill.json'), '原 JSON 應該被改名');
      assert.ok(files.some((f) => f.startsWith('splitbill.json.imported-')));
      assert.ok(files.includes('splitbill.db'));
      const backups = fs.readdirSync(path.join(dir, 'backups'));
      assert.equal(backups.length, 1);
      assert.match(backups[0], /^splitbill-\d{4}-\d{2}-\d{2}\.db$/);
    } finally {
      await s.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('v1 JSON（行程掛在伺服器底下）也會轉換後匯入', async () => {
    const dir = tmpDir();
    const v1 = {
      [G]: {
        trips: { old1: { id: 'old1', name: 'v1 行程', members: [{ id: '300000000000000003', name: 'B' }], expenses: [], deposits: [] } },
        defaultTripId: 'old1',
        activeTripByUser: {},
      },
    };
    fs.writeFileSync(path.join(dir, 'splitbill.json'), JSON.stringify(v1));
    const s = await startServer(dir);
    try {
      const trip = await j(await fetch(`${s.base}/api/trip/old1`, { headers: OWNER }));
      assert.equal(trip.status, 200);
      assert.equal(trip.body.guildId, G);
      assert.equal(trip.body.members[0].discordId, '300000000000000003');
    } finally {
      await s.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('JSON 損毀：服務拒絕啟動、原檔不動、沒有標記初始化；修好之後可以正常匯入', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'splitbill.json');
    fs.writeFileSync(file, '{"version":2,"trips":{ 這不是 JSON');
    const s = await startServer(dir);
    assert.notEqual(s.exitCode, undefined, '服務應該啟動失敗');
    assert.notEqual(s.exitCode, 0);
    assert.match(s.stderr, /不是合法的 JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"version":2,"trips":{ 這不是 JSON');

    fs.writeFileSync(file, JSON.stringify(V2_JSON));
    const s2 = await startServer(dir);
    try {
      assert.equal(s2.exitCode, undefined);
      const trip = await j(await fetch(`${s2.base}/api/trip/t1`, { headers: OWNER }));
      assert.equal(trip.status, 200);
    } finally {
      await s2.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('沒有 JSON 的全新安裝：建立空的資料庫', async () => {
    const dir = tmpDir();
    const s = await startServer(dir);
    try {
      const list = await j(await fetch(`${s.base}/api/my/trips`, { headers: OWNER }));
      assert.deepEqual(list.body.trips, []);
      assert.ok(fs.existsSync(path.join(dir, 'splitbill.db')));
    } finally {
      await s.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('透過 HTTP 的寫入', () => {
  test('重啟後資料仍在：編輯、分享連結、撤銷、刪除行程', async () => {
    const dir = tmpDir();
    let s = await startServer(dir);
    let token, revoked;
    try {
      const T = { name: 'p', members: [{ id: 'u1', name: 'A' }] };
      assert.equal((await fetch(`${s.base}/api/trip/${G}/keep`, { method: 'PUT', headers: OWNER, body: JSON.stringify(T) })).status, 200);
      assert.equal((await fetch(`${s.base}/api/trip/${G}/gone`, { method: 'PUT', headers: OWNER, body: JSON.stringify(T) })).status, 200);
      await fetch(`${s.base}/api/trip/keep`, { method: 'PUT', headers: OWNER, body: JSON.stringify({ ...T, name: '改過的名字' }) });
      token = (await j(await fetch(`${s.base}/api/trip/keep/links`, { method: 'POST', headers: OWNER, body: JSON.stringify({ guest: 'write' }) }))).body.token;
      revoked = (await j(await fetch(`${s.base}/api/trip/keep/links`, { method: 'POST', headers: OWNER, body: JSON.stringify({ guest: 'read' }) }))).body.token;
      assert.equal((await fetch(`${s.base}/api/trip/keep/links/${revoked}`, { method: 'DELETE', headers: OWNER })).status, 200);
      assert.equal((await fetch(`${s.base}/api/trip/gone`, { method: 'DELETE', headers: OWNER })).status, 200);
      await fetch(`${s.base}/api/guild/${G}/active-trip`, { method: 'PATCH', headers: OWNER, body: JSON.stringify({ userId: '400000000000000004', tripId: 'keep' }) });
    } finally {
      await s.stop();
    }

    s = await startServer(dir);
    try {
      const trip = await j(await fetch(`${s.base}/api/trip/keep`, { headers: OWNER }));
      assert.equal(trip.body.name, '改過的名字');
      assert.equal((await fetch(`${s.base}/api/shared-trip/${token}`)).status, 200);
      assert.equal((await fetch(`${s.base}/api/shared-trip/${revoked}`)).status, 404, '撤銷的連結重啟後也不能復活');
      assert.equal((await fetch(`${s.base}/api/trip/gone`, { headers: OWNER })).status, 404);
      const guild = await j(await fetch(`${s.base}/api/guild/${G}`, { headers: OWNER }));
      assert.equal(guild.body.activeTripByUser['400000000000000004'], 'keep');
    } finally {
      await s.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('樂觀鎖：版本號嚴格遞增，用舊版本存檔一律 409', async () => {
    const dir = tmpDir();
    const s = await startServer(dir);
    try {
      const T = { name: 'lock', members: [{ id: 'u1', name: 'A' }] };
      const created = await j(await fetch(`${s.base}/api/trip/${G}/lock`, { method: 'PUT', headers: OWNER, body: JSON.stringify(T) }));
      let v = created.body.updatedAt;
      const v0 = v;
      // 連續快速存檔：每次都要拿到比上一次大的版本號（多數會落在同一毫秒內）
      for (let i = 0; i < 30; i++) {
        const r = await j(await fetch(`${s.base}/api/trip/lock`, { method: 'PUT', headers: OWNER, body: JSON.stringify({ ...T, name: `n${i}`, expectedUpdatedAt: v }) }));
        assert.equal(r.status, 200);
        assert.ok(r.body.updatedAt > v, `第 ${i} 次：${r.body.updatedAt} 應該大於 ${v}`);
        v = r.body.updatedAt;
      }
      const stale = await j(await fetch(`${s.base}/api/trip/lock`, { method: 'PUT', headers: OWNER, body: JSON.stringify({ ...T, name: 'stale', expectedUpdatedAt: v0 }) }));
      assert.equal(stale.status, 409);
      assert.equal(stale.body.currentTrip.name, 'n29');
    } finally {
      await s.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('storage 模組本身', () => {
  test('同一毫秒內多次 touchTrip，updatedAt 仍然嚴格遞增', () => {
    const dir = tmpDir();
    const storage = freshStorage(dir);
    const realNow = Date.now;
    try {
      storage.loadAll();
      const t = makeTrip(storage, 'same-ms');
      Date.now = () => 5000;
      const seen = [];
      for (let i = 0; i < 5; i++) { storage.touchTrip(t); seen.push(t.updatedAt); }
      for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1]);
      // 用戶端送來的 updatedAt（整包取代成新物件）不會拉低下一個版本號
      const replaced = storage.repairTrip({ ...t, updatedAt: 1 });
      storage.setTrip(replaced);
      storage.touchTrip(replaced);
      assert.ok(replaced.updatedAt > seen[seen.length - 1]);
    } finally {
      Date.now = realNow;
      storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('SSE 事件要等 persist() 成功才發出', () => {
    const dir = tmpDir();
    const storage = freshStorage(dir);
    try {
      storage.loadAll();
      const t = makeTrip(storage, 'ev');
      const events = [];
      storage.tripEvents.on('trip-updated', (id, meta) => events.push([id, meta]));
      t.name = '改名';
      storage.touchTrip(t, { writerId: 'w1' });
      assert.equal(events.length, 0, 'touchTrip 當下不能廣播');
      storage.persist();
      assert.deepEqual(events, [['ev', { writerId: 'w1' }]]);
    } finally {
      storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('寫入失敗：整筆回滾、cache 恢復成資料庫的內容、不廣播；之後的寫入照常', () => {
    const dir = tmpDir();
    const storage = freshStorage(dir);
    try {
      storage.loadAll();
      const t = makeTrip(storage, 'rb', { name: '原本的名字' });
      const other = makeTrip(storage, 'rb2');

      // 用另一條連線在資料庫裡裝一個「內容含 FAILME 就拒絕寫入」的 trigger，模擬寫入失敗
      const { DatabaseSync } = require('node:sqlite');
      const side = new DatabaseSync(storage.DB_FILE);
      side.exec(`CREATE TRIGGER fail_me BEFORE UPDATE ON trips WHEN NEW.data LIKE '%FAILME%'
                 BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;`);

      const events = [];
      storage.tripEvents.on('trip-updated', (id) => events.push(id));

      // 建立 trigger 本身就是「另一條連線寫入過」：第一次寫入會被多實例保護擋下並重新載入
      const early = storage.getTrip('rb');
      early.name = '被擋下的修改';
      storage.touchTrip(early);
      assert.throws(() => storage.persist(), (err) => err.status === 503);
      assert.equal(storage.getTrip('rb').name, '原本的名字');

      const t2 = storage.getTrip('rb');
      const other2 = storage.getTrip('rb2');
      t2.name = 'FAILME';
      other2.name = '同一批的另一個修改';
      storage.touchTrip(t2);
      storage.touchTrip(other2);
      assert.throws(() => storage.persist(), /simulated disk failure/);

      assert.equal(storage.getTrip('rb').name, '原本的名字', '記憶體要回到資料庫裡的狀態');
      assert.equal(storage.getTrip('rb2').name, 'rb2', '同一個交易裡的其他修改也一起回滾');
      assert.equal(events.length, 0, '沒存進去的修改不能廣播');

      side.exec('DROP TRIGGER fail_me');
      side.close();
      // DROP TRIGGER 又是一次外部寫入：先被擋一次，重新載入後的寫入就照常
      const blocked = storage.getTrip('rb');
      blocked.name = '外部寫入後第一次';
      storage.touchTrip(blocked);
      assert.throws(() => storage.persist(), (err) => err.status === 503);
      const fresh = storage.getTrip('rb');
      fresh.name = '之後的修改';
      storage.touchTrip(fresh);
      storage.persist();
      assert.deepEqual(events, ['rb']);
    } finally {
      storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('歷史版本：只在 updatedAt 變動時記錄、不含憑證、依設定保留份數；刪除行程一併清掉', () => {
    const dir = tmpDir();
    const storage = freshStorage(dir, { SPLITBILL_REVISIONS_KEEP: '3' });
    try {
      storage.loadAll();
      const t = makeTrip(storage, 'rev');
      const versions = [t.updatedAt];
      for (let i = 0; i < 4; i++) {
        t.name = `v${i}`;
        storage.touchTrip(t);
        storage.persist();
        versions.push(t.updatedAt);
      }
      // 只改行程連結（不 touchTrip）不產生新版本
      t.links.push({ token: 'b'.repeat(48), label: '', guest: 'read', join: false, expiresAt: null, createdAt: 1 });
      storage.persist();

      const list = storage.listTripRevisions('rev');
      assert.deepEqual(list.map((r) => r.updatedAt), versions.slice(-3).reverse());
      const base = storage.getTripRevision('rev', versions[3]);
      assert.equal(base.name, 'v2');
      assert.equal(base.links, undefined);
      assert.equal(storage.getTripRevision('rev', versions[0]), null, '超過保留份數的舊版本已被清掉');

      storage.removeTrip('rev');
      storage.persist();
      assert.deepEqual(storage.listTripRevisions('rev'), []);
    } finally {
      storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('重新載入後內容完全一致（含 "__proto__" 這種特殊 ID）', () => {
    const dir = tmpDir();
    let storage = freshStorage(dir);
    try {
      storage.loadAll();
      makeTrip(storage, '__proto__', { name: '特殊 ID' });
      makeTrip(storage, 'normal');
      const before = JSON.stringify(storage.listTrips().map(storage.toPublicTrip));
      storage.close();

      storage = freshStorage(dir);
      storage.loadAll();
      assert.equal(storage.getTrip('__proto__').name, '特殊 ID');
      assert.equal(JSON.stringify(storage.listTrips().map(storage.toPublicTrip)), before);
    } finally {
      storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('每日備份：保留份數之外的舊備份會被刪掉，備份檔本身是可以開的資料庫', () => {
    const dir = tmpDir();
    const storage = freshStorage(dir, { SPLITBILL_BACKUP_KEEP: '2' });
    try {
      storage.loadAll();
      makeTrip(storage, 'bk');
      const bdir = path.join(dir, 'backups');
      fs.mkdirSync(bdir, { recursive: true });
      for (const d of ['2020-01-01', '2020-01-02', '2020-01-03']) fs.writeFileSync(path.join(bdir, `splitbill-${d}.db`), '');
      const made = storage.runDailyBackup();
      const left = fs.readdirSync(bdir).sort();
      assert.deepEqual(left, ['splitbill-2020-01-03.db', path.basename(made)]);

      const { DatabaseSync } = require('node:sqlite');
      const copy = new DatabaseSync(made, { readOnly: true });
      assert.equal(copy.prepare('SELECT count(*) AS n FROM trips').get().n, 1);
      copy.close();
    } finally {
      storage.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

