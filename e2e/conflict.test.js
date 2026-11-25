'use strict';
// 兩個人同時改同一筆帳：一定要問過才覆蓋
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, addExpense, waitFor, SAVED } = require('./helpers');

let app, A, B, tripId;
before(async () => {
  app = await start();
  A = await app.newPage();
  B = await app.newPage();
  await app.login(A.page, { id: '500000000000000011', name: '小明' });
  const trip = (await app.api(A.page, '/api/trips', 'POST', { name: '衝突', memberName: '小明' })).body;
  tripId = trip.id;
  await app.openTrip(A.page, tripId);
  // B 是同一個人的另一台裝置（SSE 關掉，模擬還沒收到更新）
  await app.login(B.page, { id: '500000000000000011', name: '小明' });
});
after(async () => { if (app) await app.stop(); });

const server = async () => (await app.api(A.page, `/api/trip/${tripId}`)).body;
/** 記一筆，讓 B 打開編輯畫面停在舊內容 */
async function setup(desc) {
  await addExpense(A.page, { desc, amount: 100, payer: '小明' });
  const id = (await server()).expenses.find((e) => e.description === desc).id;
  await app.openTrip(B.page, tripId);
  await B.page.evaluate('disconnectTripEventStream()');
  await B.page.evaluate(`editExpense(${JSON.stringify(id)})`);
  return id;
}
async function edit(p, id, desc) {
  await p.page.evaluate(`if (editingExpenseId !== ${JSON.stringify(id)}) editExpense(${JSON.stringify(id)})`);
  await p.page.fill('#expDesc', desc);
  await p.page.evaluate('void saveExpenseAndSync()');
}
const descOf = async (id) => ((await server()).expenses.find((e) => e.id === id) || {}).description;

for (const [button, expected] of [['#modalConfirmBtn', '我的'], ['#modalCancelBtn', '對方的']]) {
  test(`兩邊都改：按鈕選「${expected}」`, { timeout: 60_000 }, async () => {
    const id = await setup(`午餐-${expected}`);
    await edit(A, id, '對方的');
    await waitFor(A.page, SAVED);
    await edit(B, id, '我的');
    await B.page.locator('#modalTitle', { hasText: '這筆剛被改過' }).waitFor();
    const text = await B.page.locator('#modalBody').innerText();
    assert.match(text, /你的：我的 100/);
    assert.match(text, /對方：對方的 100/);
    assert.match(text, /不同：項目說明/);
    assert.equal(await descOf(id), '對方的', '選之前不能蓋掉');
    await B.page.click(button);
    await waitFor(B.page, `${SAVED} && trip.expenses.find(e => e.id === ${JSON.stringify(id)}).description === ${JSON.stringify(expected)}`);
    assert.equal(await descOf(id), expected);
  });
}

test('打開編輯後才收到對方的更新：存檔仍然會問', { timeout: 60_000 }, async () => {
  const id = await setup('宵夜');
  await edit(A, id, '對方的');
  await waitFor(A.page, SAVED);
  await B.page.evaluate('refreshTripFromServer()'); // 背景已同步到對方的版本，表單還是舊內容
  await edit(B, id, '我的');
  await B.page.locator('#modalTitle', { hasText: '這筆剛被改過' }).waitFor();
  await B.page.click('#modalCancelBtn');
  await waitFor(B.page, SAVED);
  assert.equal(await descOf(id), '對方的');
});

test('對方刪掉、我在改：可以重新建立', { timeout: 60_000 }, async () => {
  const id = await setup('門票');
  await A.page.evaluate(`void deleteExpense(${JSON.stringify(id)}, null)`);
  await waitFor(A.page, `!trip.expenses.some(e => e.id === ${JSON.stringify(id)}) && ${SAVED}`);
  for (let i = 0; i < 100 && await descOf(id); i++) await new Promise((r) => setTimeout(r, 50));
  await edit(B, id, '改過的門票');
  await B.page.locator('#modalTitle', { hasText: '這筆已被刪除' }).waitFor();
  await B.page.click('#modalConfirmBtn');
  await waitFor(B.page, SAVED);
  assert.equal(await descOf(id), '改過的門票');
});

test('斷線時改的帳，連上後整包存檔也會先問', { timeout: 60_000 }, async () => {
  const id = await setup('飯店');
  await B.context.setOffline(true);
  await edit(B, id, '我的');
  await waitFor(B.page, 'document.getElementById("syncStatus").dataset.state === "error"');
  await edit(A, id, '對方的');
  await waitFor(A.page, SAVED);
  await B.context.setOffline(false);
  await B.page.evaluate('void refreshTripFromServer().then(() => saveTripToApi())');
  await B.page.locator('#modalTitle', { hasText: '這筆剛被改過' }).waitFor();
  await B.page.click('#modalCancelBtn');
  await waitFor(B.page, SAVED);
  assert.equal(await descOf(id), '對方的');
});

test('沒有人同時改：不會跳視窗，也沒有頁面錯誤', { timeout: 60_000 }, async () => {
  const id = await setup('早餐');
  await edit(B, id, '早餐改');
  await waitFor(B.page, SAVED);
  assert.equal(await B.page.locator('#modalTitle').count(), 0);
  assert.equal(await descOf(id), '早餐改');
  assert.deepEqual([...A.errors, ...B.errors], []);
});
