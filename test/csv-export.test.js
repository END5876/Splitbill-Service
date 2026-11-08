'use strict';
// 前端 CSV 匯出（public/js/importExport.js 的 buildTripCsv）的單元測試。
// 跟 merge.test.js 一樣用 vm 把前端檔案載進同一個沙盒。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ctx = { console, document: { getElementById: () => null } };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['helpers.js', 'tripModel.js', 'importExport.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8'), ctx, { filename: f });
}

const trip = ctx.repairTrip({
  id: 't', name: '沖繩, "三天"', baseCurrency: 'TWD', rates: { TWD: 1, JPY: 0.2 },
  members: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }, { id: 'c', name: '=HACK()' }],
  expenses: [
    { id: 'e1', description: '晚餐', amount: 300, currency: 'TWD', amountInBase: 300,
      payers: [{ userId: 'a', amount: 300 }],
      participants: [{ userId: 'a', amount: 100 }, { userId: 'b', amount: 100 }, { userId: 'c', amount: 100 }], createdAt: 1000 },
    { id: 'e2', description: '+門票', amount: 1000, currency: 'JPY', amountInBase: 200,
      payers: [{ userId: 'b', amount: 1000 }],
      participants: [{ userId: 'a', amount: 500 }, { userId: 'b', amount: 500 }], createdAt: 3000 },
  ],
  deposits: [{ id: 'd1', payerId: 'c', collectorId: 'a', amount: 50, currency: 'TWD', amountInBase: 50, note: '', createdAt: 2000 }],
});

// 簡易 CSV 解析（只處理本檔產生的格式：雙引號包住、"" 跳脫）
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') { /* CRLF */ }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  return rows;
}

const csv = ctx.buildTripCsv(trip);
const rows = parseCsv(csv.slice(1));

test('開頭有 BOM、用 CRLF 換行', () => {
  assert.equal(csv[0], '﻿');
  assert.ok(csv.includes('\r\n'));
});

test('含逗號與引號的名稱正確跳脫', () => {
  assert.deepEqual(rows[0], ['行程', '沖繩, "三天"']);
});

test('帳目依時間排序，轉帳排在兩筆支出中間', () => {
  const kinds = rows.filter(r => r[0] === '支出' || r[0] === '轉帳').map(r => r[0] + ':' + r[2]);
  assert.deepEqual(kinds, ['支出:晚餐', '轉帳:', "支出:'+門票"]);
});

test('成員名稱與項目開頭是公式符號時加上單引號', () => {
  const header = rows.find(r => r[0] === '類型');
  assert.equal(header[10], "'=HACK()（TWD）");
});

test('合計列等於總覽頁的淨額', () => {
  const header = rows.find(r => r[0] === '類型');
  const total = rows.find(r => r[0].startsWith('合計'));
  const net = ctx.calcNetBalances(trip);
  ['a', 'b', 'c'].forEach((id, i) => {
    assert.equal(header[8 + i].startsWith(trip.members[i].name.replace(/^=/, "'=")), true);
    assert.equal(Number(total[8 + i]), net[id]);
  });
  // Ann 付 300、分攤 100、收了 50 的轉帳、分攤門票 100 → +50
  assert.equal(Number(total[8]), 50);
});

test('附上建議轉帳', () => {
  const i = rows.findIndex(r => r[0] === '建議轉帳');
  assert.deepEqual(rows[i + 1], ['付款人', '收款人', '金額（TWD）']);
  const tx = rows.slice(i + 2).filter(r => r.length === 3);
  const sum = tx.reduce((s, r) => s + Number(r[2]), 0);
  assert.ok(sum > 0);
});
