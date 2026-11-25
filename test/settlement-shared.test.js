'use strict';
// 與 Bot 共用的結算測試資料：Mousebot 的 test/splitbill.test.js 用同一份
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { cases } = require('./fixtures/splitbill-cases.json');

const ctx = { console, document: { getElementById: () => null } };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['helpers.js', 'tripModel.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8'), ctx, { filename: f });
}
const plain = (v) => JSON.parse(JSON.stringify(v)); // vm 裡的物件原型不同，deepEqual 前先轉成一般物件

for (const c of cases) {
  test(`共用結算資料：${c.name}`, () => {
    const net = ctx.calcNetBalances(c.trip);
    assert.deepEqual(plain(net), c.net);
    assert.deepEqual(plain(ctx.simplifyDebts(net)), c.settlement);
  });
}

test('共用結算資料：與 Bot 那份內容相同', (t) => {
  const other = path.join(__dirname, '../../Mousebot/test/fixtures/splitbill-cases.json');
  if (!fs.existsSync(other)) return t.skip('旁邊沒有 Mousebot');
  assert.deepEqual(JSON.parse(fs.readFileSync(other, 'utf8')).cases, cases);
});
