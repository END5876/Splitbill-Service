'use strict';
// 核心流程：登入、記帳、結算、登出。執行：npm run e2e（需要 Chrome；用 Edge 設 E2E_CHANNEL=msedge）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, addExpense, waitFor, SAVED } = require('./helpers');

let app;
before(async () => { app = await start(); });
after(async () => { if (app) await app.stop(); });

for (const [name, viewport] of [['電腦', { width: 1280, height: 900 }], ['手機', { width: 390, height: 844 }]]) {
  test(`${name}：登入 → 記帳 → 結算標記已付 → 登出`, { timeout: 60_000 }, async () => {
    const { page, context, errors } = await app.newPage({ viewport });
    await app.login(page, { id: '500000000000000001', name: '小明' });
    const trip = (await app.api(page, '/api/trips', 'POST', { name: `${name}行程`, memberName: '小明' })).body;
    const added = await app.api(page, `/api/trip/${trip.id}`, 'PUT', {
      ...trip, members: [...trip.members, { id: 'mem_hua', name: '小華' }], expectedUpdatedAt: trip.updatedAt,
    });
    assert.equal(added.status, 200);
    await app.openTrip(page, trip.id);

    await addExpense(page, { desc: '晚餐', amount: 300, payer: '小明' });
    let server = (await app.api(page, `/api/trip/${trip.id}`)).body;
    assert.equal(server.expenses.length, 1);
    assert.equal(server.expenses[0].amount, 300);
    assert.deepEqual(server.expenses[0].participants.map((p) => p.amount), [150, 150]);

    await page.evaluate('showMainTab("overview")');
    await page.locator('.settle-item', { hasText: '150' }).first().waitFor();
    await page.evaluate('void markTransferPaid("mem_hua", trip.members[0].id, document.querySelector(".settle-item"))');
    await page.click('#modalConfirmBtn');
    await waitFor(page, `trip.deposits.length === 1 && ${SAVED}`);
    server = (await app.api(page, `/api/trip/${trip.id}`)).body;
    assert.equal(server.deposits[0].amount, 150);
    assert.equal(await page.locator('.settle-item').count(), 0, '結清後沒有建議轉帳');

    assert.ok([200, 204].includes((await app.api(page, '/auth/logout', 'POST')).status));
    assert.equal((await app.api(page, `/api/trip/${trip.id}`)).status, 401);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('唯讀連結：看得到帳，不能記', { timeout: 60_000 }, async () => {
  const owner = await app.newPage();
  await app.login(owner.page, { id: '500000000000000002', name: '小華' });
  const trip = (await app.api(owner.page, '/api/trips', 'POST', { name: '分享', memberName: '小華' })).body;
  const link = (await app.api(owner.page, `/api/trip/${trip.id}/links`, 'POST', { guest: 'read' })).body;
  const guest = await app.newPage();
  await guest.page.goto(app.base);
  assert.equal((await app.api(guest.page, `/api/shared-trip/${link.token}`)).body.trip.name, '分享');
  assert.equal((await app.api(guest.page, `/api/shared-trip/${link.token}`, 'PUT', {})).status, 403);
  assert.deepEqual(guest.errors, []);
  await guest.context.close();
  await owner.context.close();
});
