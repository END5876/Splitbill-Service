'use strict';
// 瀏覽器測試共用：啟動完整的 server.js，Discord 用本機假的伺服器代替（真的 Discord／LINE 登入測不到）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright-core');

const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => r(port)); });
});

/** 假的 Discord：授權頁直接導回 callback；nextUser 決定這次登入的是誰 */
function fakeDiscord() {
  const app = express();
  app.nextUser = { id: '500000000000000001', name: '小明' };
  app.get('/authorize', (req, res) => {
    const u = new URL(String(req.query.redirect_uri));
    u.searchParams.set('code', `code-${app.nextUser.id}-${encodeURIComponent(app.nextUser.name)}`);
    u.searchParams.set('state', String(req.query.state));
    res.redirect(u.toString());
  });
  app.post('/api/oauth2/token', express.urlencoded({ extended: false }), (req, res) => {
    res.json({ access_token: String(req.body.code).slice(5) });
  });
  app.get('/api/users/@me', (req, res) => {
    const [, id, name] = /^Bearer (\d+)-(.*)$/.exec(req.get('authorization') || '') || [];
    if (!id) return res.status(401).json({});
    res.json({ id, username: 'u', global_name: decodeURIComponent(name), avatar: null });
  });
  return app;
}

async function start() {
  const discord = fakeDiscord();
  const discordServer = await listen(discord);
  const fake = `http://127.0.0.1:${discordServer.address().port}`;
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), SPLITBILL_DATA_DIR: dataDir, SPLITBILL_API_KEY: 'e2e-key', SESSION_SECRET: 'e'.repeat(32),
      PUBLIC_BASE_URL: base, OWNER_USER_ID: '', GEMINI_API_KEY: '', ALERT_WEBHOOK_URL: '',
      DISCORD_CLIENT_ID: 'id', DISCORD_CLIENT_SECRET: 'secret',
      DISCORD_API_BASE: `${fake}/api`, DISCORD_AUTHORIZE_URL: `${fake}/authorize`,
      LINE_CHANNEL_ID: '', LINE_CHANNEL_SECRET: '',
    },
    stdio: process.env.E2E_DEBUG ? 'inherit' : 'ignore',
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* 還沒起來 */ }
    if (i > 100) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  // 用系統已安裝的瀏覽器；GitHub 的 ubuntu 映像內建 Chrome
  const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'chrome' });

  /** 開一個獨立的瀏覽器身分；errors 收集頁面錯誤與 CSP 違規 */
  async function newPage(opts = {}) {
    const context = await browser.newContext({ locale: 'zh-TW', ...opts });
    // 不連外部網路（字型、匯率），測試結果才不受影響
    await context.route((u) => u.hostname !== 'localhost' && u.hostname !== '127.0.0.1', (r) => r.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) errors.push(m.text());
    });
    return { page, context, errors };
  }

  /** 走一次 Discord 登入，回到網頁 */
  async function login(page, user) {
    discord.nextUser = user;
    await page.goto(`${base}/auth/discord/login`);
    await waitFor(page, '!!currentUser');
  }
  const api = (page, url, method = 'GET', body) => page.evaluate(async ([u, m, b]) => {
    const r = await fetch(u, {
      method: m,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'splitbill' },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [url, method, body]);
  const openTrip = async (page, id) => {
    await page.evaluate(`loadTripFromApi({ tripId: ${JSON.stringify(id)} })`);
    await waitFor(page, `currentTripId === ${JSON.stringify(id)} && trip.id === currentTripId`);
  };

  async function stop() {
    await browser.close();
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited;
    discordServer.closeAllConnections();
    discordServer.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return { base, newPage, login, api, openTrip, stop };
}

/** 等頁面上的運算式成立。不用 waitForFunction：它在頁面裡 eval，會被網站的 CSP 擋掉 */
async function waitFor(page, expr, ms = 10_000) {
  for (const end = Date.now() + ms; ;) {
    const ok = await page.evaluate(`(() => { try { return !!(${expr}); } catch { return false; } })()`).catch(() => false);
    if (ok) return;
    if (Date.now() > end) throw new Error(`等不到：${expr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const SAVED = 'document.getElementById("syncStatus").dataset.state === "saved"';

/** 從「支出」分頁的三步驟表單記一筆（金額 → 代墊 → 分攤） */
async function addExpense(page, { desc, amount, payer }) {
  await page.evaluate('showMainTab("expenses"); setFormCardOpen("expenseFormCard", true); setExpenseStep(0)');
  await page.fill('#expAmount', String(amount));
  await page.fill('#expDesc', desc);
  await page.click('#btnNextExpense');
  const chip = page.locator('#payerChips .chip', { hasText: payer });
  if (!/checked/.test(await chip.getAttribute('class'))) await chip.locator('.chip-label').click();
  await page.click('#btnNextExpense');
  if (!await page.locator('#participantChips .chip.checked').count()) await page.click('#btnAllParticipants');
  await page.click('#btnSaveExpenseSync');
  await waitFor(page, `trip.expenses.some(e => e.description === ${JSON.stringify(desc)}) && ${SAVED}`);
}

module.exports = { start, addExpense, waitFor, SAVED };
