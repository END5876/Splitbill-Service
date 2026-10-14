'use strict';
// 回歸測試：stored XSS 防護（id／幣別白名單、收據協作狀態清洗、CSP）、單筆支出／轉帳 API、/healthz。
// 執行：npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 45000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-entries-key';
const OWNER = { 'x-api-key': KEY, 'content-type': 'application/json' };
const JSONH = { 'content-type': 'application/json' };
const EVIL = "x');fetch('/steal');//";
let proc, dataDir, RO, RW;

async function j(res) { return { status: res.status, body: await res.json().catch(() => ({})) }; }
const T = {
  name: 't', baseCurrency: 'TWD', rates: { TWD: 1 },
  members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
};
const getTrip = () => fetch(`${BASE}/api/trip/g/t1`, { headers: OWNER }).then(j);
const putEntry = (kind, id, entry, base = `${BASE}/api/trip/t1`, headers = OWNER) =>
  fetch(`${base}/${kind}/${encodeURIComponent(id)}`, { method: 'PUT', headers, body: JSON.stringify({ entry, writerId: 'w' }) }).then(j);
const delEntry = (kind, id, base = `${BASE}/api/trip/t1`, headers = OWNER) =>
  fetch(`${base}/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE', headers, body: '{}' }).then(j);
const expense = (extra = {}) => ({
  description: '晚餐', amount: 100, currency: 'TWD', amountInBase: 100,
  payers: [{ userId: 'a', amount: 100 }],
  participants: [{ userId: 'a', amount: 50 }, { userId: 'b', amount: 50 }],
  createdAt: 1700000000000, ...extra,
});

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-entries-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), SPLITBILL_API_KEY: KEY, SPLITBILL_DATA_DIR: dataDir, GEMINI_API_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await fetch(`${BASE}/api/trip/g/t1`, { method: 'PUT', headers: OWNER, body: JSON.stringify(T) });
  RO = (await j(await fetch(`${BASE}/api/trip/t1/links`, { method: 'POST', headers: OWNER, body: JSON.stringify({ guest: 'read' }) }))).body.token;
  RW = (await j(await fetch(`${BASE}/api/trip/t1/links`, { method: 'POST', headers: OWNER, body: JSON.stringify({ guest: 'write' }) }))).body.token;
});

after(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited;
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ───────────────────────── stored XSS ─────────────────────────

test('可編輯分享連結塞進含引號的成員 id／幣別：伺服器換成安全 id，帳目引用跟著改', async () => {
  const cur = (await j(await fetch(`${BASE}/api/shared-trip/${RW}`))).body.trip;
  const payload = {
    ...cur,
    members: [...cur.members, { id: EVIL, name: '壞人' }],
    rates: { ...cur.rates, "JPY'<x>": 0.2, JPY: 0.21 },
    expenses: [{ ...expense(), id: 'e"1', payers: [{ userId: EVIL, amount: 100 }] }],
    expectedUpdatedAt: cur.updatedAt,
  };
  const r = await j(await fetch(`${BASE}/api/shared-trip/${RW}`, { method: 'PUT', headers: JSONH, body: JSON.stringify(payload) }));
  assert.equal(r.status, 200);
  const t = r.body.trip;
  const text = JSON.stringify(t);
  assert.ok(!text.includes(EVIL), '惡意 id 不能出現在任何地方');
  assert.ok(!text.includes('e\\"1'));
  const evilMember = t.members.find((m) => m.name === '壞人');
  assert.match(evilMember.id, /^[A-Za-z0-9_-]+$/);
  assert.equal(t.expenses[0].payers[0].userId, evilMember.id, '帳目裡的引用要改成新的 id');
  assert.deepEqual(Object.keys(t.rates).sort(), ['JPY', 'TWD']);
});

test('數字欄位不是有限數字時一律修成 0，不會讓結算變成 NaN', async () => {
  const cur = (await getTrip()).body;
  const r = await j(await fetch(`${BASE}/api/trip/t1`, {
    method: 'PUT', headers: OWNER,
    body: JSON.stringify({ ...cur, members: T.members, expenses: [{ ...expense(), id: 'enan', amount: '100', payers: [{ userId: 'a', amount: 'x' }] }] }),
  }));
  assert.equal(r.status, 200);
  assert.equal(r.body.expenses[0].amount, 0);
  assert.equal(r.body.expenses[0].payers[0].amount, 0);
});

test('收據協作狀態：未知欄位丟掉、品項 id／照片網址／幣別不合格就清掉', async () => {
  const state = {
    imageDataUrl: 'javascript:alert(1)',
    detectedCurrency: '"><img src=x>',
    items: [
      { id: EVIL, name: 'x', price: 1 },
      { id: 'ritem_1', name: '拉麵', price: '12', type: 'evil', assignedTo: ['a', EVIL] },
    ],
    attendeeIds: ['a', EVIL],
    payerId: EVIL,
    extra: 'drop me',
  };
  const put = await j(await fetch(`${BASE}/api/shared-trip/${RW}/receipt-session`, { method: 'PUT', headers: JSONH, body: JSON.stringify({ state }) }));
  assert.equal(put.status, 200);
  const got = (await j(await fetch(`${BASE}/api/shared-trip/${RW}/receipt-session`))).body.state;
  assert.equal(got.imageDataUrl, undefined);
  assert.equal(got.detectedCurrency, null);
  assert.equal(got.payerId, null);
  assert.equal(got.extra, undefined);
  assert.deepEqual(got.items.map((i) => i.id), ['ritem_1']);
  assert.equal(got.items[0].price, 0);
  assert.equal(got.items[0].type, 'item');
  assert.deepEqual(got.items[0].assignedTo, ['a']);
  assert.deepEqual(got.attendeeIds, ['a']);
  await fetch(`${BASE}/api/shared-trip/${RW}/receipt-session`, { method: 'DELETE' });
});

test('網頁回應帶 CSP，而且 index.html 沒有任何 inline script／事件屬性', async () => {
  const res = await fetch(`${BASE}/`);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const html = await res.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, '不能有 inline <script>');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, '不能有 onclick 之類的屬性');
  const jsDir = path.join(__dirname, '..', 'public', 'js');
  for (const f of fs.readdirSync(jsDir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(jsDir, f), 'utf8'), /\son(click|change|input|keydown|submit|load|error)=["'`$]/, `${f} 不能產生 inline 事件屬性`);
  }
});

test('/healthz 回報外部服務狀態', async () => {
  const { status, body } = await j(await fetch(`${BASE}/healthz`));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.upstream.fx.state, 'unknown');
});

// ───────────────────────── 單筆支出／轉帳 API ─────────────────────────

test('單筆新增／編輯支出：回傳寫入前後的版本號，建立者不會被編輯改掉', async () => {
  const before0 = (await getTrip()).body.updatedAt;
  const add = await putEntry('expenses', 'e1', expense({ createdBy: 'web-ui' }));
  assert.equal(add.status, 200);
  assert.equal(add.body.prevUpdatedAt, before0);
  assert.ok(add.body.updatedAt > before0);
  assert.equal(add.body.entry.id, 'e1');

  const edit = await putEntry('expenses', 'e1', expense({ description: '宵夜', createdBy: 'someone-else' }));
  assert.equal(edit.status, 200);
  assert.equal(edit.body.prevUpdatedAt, add.body.updatedAt);
  const t = (await getTrip()).body;
  const e1 = t.expenses.filter((e) => e.id === 'e1');
  assert.equal(e1.length, 1, '同一個 id 重送是取代，不會變成兩筆');
  assert.equal(e1[0].description, '宵夜');
  assert.equal(e1[0].createdBy, 'web-ui');
});

test('單筆支出驗證：成員不存在、金額對不起來、id 格式錯誤都回 400', async () => {
  assert.equal((await putEntry('expenses', 'bad1', expense({ payers: [{ userId: 'nobody', amount: 100 }] }))).status, 400);
  assert.equal((await putEntry('expenses', 'bad2', expense({ participants: [{ userId: 'a', amount: 10 }] }))).status, 400);
  assert.equal((await putEntry('expenses', 'bad3', expense({ amount: -1 }))).status, 400);
  assert.equal((await putEntry('expenses', 'bad4', expense({ currency: '<b>' }))).status, 400);
  assert.equal((await putEntry('expenses', EVIL, expense())).status, 400);
  const ids = (await getTrip()).body.expenses.map((e) => e.id);
  assert.ok(!ids.some((id) => id.startsWith('bad')), '被拒絕的資料不能寫進去');
});

test('單筆轉帳：新增、刪除、重複刪除也算成功', async () => {
  const dep = { payerId: 'a', collectorId: 'b', amount: 30, currency: 'TWD', amountInBase: 30, note: '還錢' };
  assert.equal((await putEntry('deposits', 'd1', { ...dep, collectorId: 'a' })).status, 400, '付款人跟收款人不能同一個');
  const add = await putEntry('deposits', 'd1', dep);
  assert.equal(add.status, 200);
  assert.ok((await getTrip()).body.deposits.some((d) => d.id === 'd1'));
  const del = await delEntry('deposits', 'd1');
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  assert.ok(!(await getTrip()).body.deposits.some((d) => d.id === 'd1'));
  const again = await delEntry('deposits', 'd1');
  assert.equal(again.status, 200);
  assert.equal(again.body.deleted, false);
});

test('分享連結：可編輯的能寫單筆，唯讀的不行', async () => {
  const rw = await putEntry('expenses', 'e-rw', expense(), `${BASE}/api/shared-trip/${RW}`, JSONH);
  assert.equal(rw.status, 200);
  const ro = await putEntry('expenses', 'e-ro', expense(), `${BASE}/api/shared-trip/${RO}`, JSONH);
  assert.equal(ro.status, 403);
  assert.equal((await delEntry('expenses', 'e-rw', `${BASE}/api/shared-trip/${RO}`, JSONH)).status, 403);
  assert.equal((await delEntry('expenses', 'e-rw', `${BASE}/api/shared-trip/${RW}`, JSONH)).status, 200);
});

test('兩個人同時寫不同筆：兩筆都保留，不會互相覆蓋', async () => {
  const results = await Promise.all([
    putEntry('expenses', 'p1', expense({ description: '甲' })),
    putEntry('expenses', 'p2', expense({ description: '乙' }), `${BASE}/api/shared-trip/${RW}`, JSONH),
  ]);
  for (const r of results) assert.equal(r.status, 200);
  const ids = (await getTrip()).body.expenses.map((e) => e.id);
  assert.ok(ids.includes('p1') && ids.includes('p2'));
});

test('沒有權限的呼叫端不能寫單筆（沒帶金鑰、沒登入）', async () => {
  assert.equal((await putEntry('expenses', 'x1', expense(), `${BASE}/api/trip/t1`, JSONH)).status, 401);
});
