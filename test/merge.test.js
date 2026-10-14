'use strict';
// 前端三方合併（public/js/tripSync.js 的 tryMergeTrips）的單元測試。
// 前端是一般的 <script>，這裡用 vm 把需要的檔案載進同一個沙盒，直接呼叫裡面的函式。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ctx = { console, document: { getElementById: () => null } };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['helpers.js', 'tripModel.js', 'tripSync.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8'), ctx, { filename: f });
}
// 沙盒裡的陣列／物件跟這裡不同 realm，deepStrictEqual 會判定不相等；轉一次 JSON 帶回來
const merge = (l, s, b) => JSON.parse(JSON.stringify(ctx.tryMergeTrips(ctx.repairTrip(l), ctx.repairTrip(s), b && ctx.repairTrip(b))));
const conflicts = () => vm.runInContext('lastMergeConflicts', ctx);

const exp = (id, description = id, createdAt = 1) => ({
  id, description, amount: 10, currency: 'TWD', amountInBase: 10,
  payers: [{ userId: 'a', amount: 10 }], participants: [{ userId: 'a', amount: 10 }], createdAt, createdBy: 'web-ui',
});
const tripWith = (expenses, extra = {}) => ({
  id: 't', name: '行程', baseCurrency: 'TWD', rates: { TWD: 1 }, members: [{ id: 'a', name: 'A' }],
  expenses, deposits: [], createdAt: 1, ...extra,
});
const ids = (t) => t.expenses.map((e) => e.id).sort();

test('別人刪掉、我沒動 → 刪除（以前會復活）', () => {
  const base = tripWith([exp('e1'), exp('e2')]);
  const local = tripWith([exp('e1'), exp('e2')]);
  const server = tripWith([exp('e1')]);
  assert.deepEqual(ids(merge(local, server, base)), ['e1']);
  assert.equal(conflicts(), 0);
});

test('我刪掉、別人沒動 → 刪除（以前會被別人的版本補回來）', () => {
  const base = tripWith([exp('e1'), exp('e2')]);
  const local = tripWith([exp('e1')]);
  const server = tripWith([exp('e1'), exp('e2')]);
  assert.deepEqual(ids(merge(local, server, base)), ['e1']);
});

test('兩邊各自新增 → 都保留', () => {
  const base = tripWith([exp('e1')]);
  const local = tripWith([exp('e1'), exp('mine', 'mine', 3)]);
  const server = tripWith([exp('e1'), exp('theirs', 'theirs', 2)]);
  const m = merge(local, server, base);
  assert.deepEqual(m.expenses.map((e) => e.id), ['e1', 'theirs', 'mine'], '依建立時間排序');
});

test('只有別人改過 → 用別人的；兩邊都改 → 以本地為準並計入衝突', () => {
  const base = tripWith([exp('e1', '原本'), exp('e2', '原本')]);
  const local = tripWith([exp('e1', '原本'), exp('e2', '我改的')]);
  const server = tripWith([exp('e1', '別人改的'), exp('e2', '別人也改了')]);
  const m = merge(local, server, base);
  assert.equal(m.expenses.find((e) => e.id === 'e1').description, '別人改的');
  assert.equal(m.expenses.find((e) => e.id === 'e2').description, '我改的');
  assert.equal(conflicts(), 1);
});

test('別人刪掉、我改過 → 保留我的修改；我刪掉、別人改過 → 保留別人的修改', () => {
  const base = tripWith([exp('e1', '原本'), exp('e2', '原本')]);
  const local = tripWith([exp('e1', '我改的')]);
  const server = tripWith([exp('e2', '別人改的')]);
  const m = merge(local, server, base);
  assert.deepEqual(ids(m), ['e1', 'e2']);
  assert.equal(conflicts(), 2);
});

test('沒有 base（第一次存檔）→ 退回聯集、同 id 以本地為準', () => {
  const m = merge(tripWith([exp('e1', '我的')]), tripWith([exp('e1', '別人的'), exp('e2')]), null);
  assert.deepEqual(ids(m), ['e1', 'e2']);
  assert.equal(m.expenses.find((e) => e.id === 'e1').description, '我的');
});

test('匯率與行程名稱也是三方合併', () => {
  const base = tripWith([], { rates: { TWD: 1, USD: 30 } });
  const local = tripWith([], { rates: { TWD: 1 }, name: '行程' });                         // 我刪了 USD
  const server = tripWith([], { rates: { TWD: 1, USD: 30, JPY: 0.2 }, name: '別人改名' }); // 別人加了 JPY、改了名字
  const m = merge(local, server, base);
  assert.deepEqual(Object.keys(m.rates).sort(), ['JPY', 'TWD']);
  assert.equal(m.name, '別人改名');
});

test('版本號一律用伺服器的', () => {
  const m = merge(tripWith([], { updatedAt: 5 }), tripWith([], { updatedAt: 9 }), tripWith([], { updatedAt: 5 }));
  assert.equal(m.updatedAt, 9);
});
