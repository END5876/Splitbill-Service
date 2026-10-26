'use strict';
// 回歸測試：請求結果 log（403／409／429／5xx，token 不進 log）、匯率服務掛掉時沿用 7 天內的舊匯率、
// 帳單辨識模型可由環境變數設定。
// 執行：npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');

function freshRequire(rel, env = {}) {
  const file = path.join(ROOT, rel);
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, 'lib') + path.sep)) delete require.cache[k];
  }
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return require(file); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('requestLog：只記 403／409／429／5xx，分享連結 token 換成 :token', async () => {
  const { requestLog, redactPath } = freshRequire('lib/requestLog.js');
  assert.equal(redactPath('/api/shared-trip/abcDEF123/fx-rate?from=JPY'), '/api/shared-trip/:token/fx-rate');
  assert.equal(redactPath('/api/link/tok/claim'), '/api/link/:token/claim');
  assert.equal(redactPath('/api/trip/trip_1/links/tok'), '/api/trip/trip_1/links/:token');

  const lines = [];
  const log = { log: (l) => lines.push(['log', l]), warn: (l) => lines.push(['warn', l]), error: (l) => lines.push(['error', l]) };
  const app = express();
  app.use(requestLog({ log }));
  app.get('/ok', (req, res) => res.json({}));
  app.get('/api/shared-trip/:token', (req, res) => res.status(409).json({}));
  app.get('/boom', (req, res) => res.status(500).json({}));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/ok`);
    assert.match(ok.headers.get('x-request-id'), /^[0-9a-f]{8}$/);
    await fetch(`${base}/api/shared-trip/SECRET_TOKEN_123?x=1`);
    await fetch(`${base}/boom`, { headers: { 'x-request-id': 'req-42' } });
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    server.close();
  }
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.equal(lines[0][0], 'warn');
  assert.match(lines[0][1], /GET \/api\/shared-trip\/:token 409 \d+ms guest$/);
  assert.doesNotMatch(lines[0][1], /SECRET_TOKEN_123/);
  assert.equal(lines[1][0], 'error');
  assert.match(lines[1][1], /^\[splitbill-http\] req-42 GET \/boom 500 /);
});

test('匯率：外部服務掛掉時沿用 7 天內的舊匯率（stale），不認得的幣別照樣失敗', async () => {
  const fx = freshRequire('lib/fxRates.js');
  const realFetch = global.fetch;
  const realWarn = console.warn;
  let mode = 'ok';
  global.fetch = async () => {
    if (mode === 'down') throw new Error('connect ECONNREFUSED');
    if (mode === 'unsupported') return new Response(JSON.stringify({ result: 'error', 'error-type': 'unsupported-code' }), { status: 404 });
    return new Response(JSON.stringify({ result: 'success', rates: { TWD: 0.21 }, time_last_update_utc: 'Mon, 26 Oct 2026 00:00:01 +0000' }), { status: 200 });
  };
  console.warn = () => {};
  try {
    const fresh = await fx.getFxRatesFor('JPY');
    assert.equal(fresh.rates.TWD, 0.21);
    assert.equal(fresh.stale, false);

    // 快取過期（7 小時前抓的），外部服務掛了 → 沿用舊匯率並標 stale
    fx._cache.get('JPY').fetchedAt = Date.now() - 7 * 3600 * 1000;
    mode = 'down';
    const stale = await fx.getFxRatesFor('JPY');
    assert.equal(stale.stale, true);
    assert.equal(stale.rates.TWD, 0.21);

    // 超過 7 天就不能再用
    fx._cache.get('JPY').fetchedAt = Date.now() - fx.FX_STALE_MAX_MS - 1000;
    fx._cache.get('JPY').retryAt = 0;
    await assert.rejects(fx.getFxRatesFor('JPY'), /ECONNREFUSED/);

    // 外部服務恢復 → 換回新匯率
    mode = 'ok';
    assert.equal((await fx.getFxRatesFor('JPY')).stale, false);

    // 不認得的幣別是輸入問題，不拿舊資料頂替
    fx._cache.set('XXX', { rates: { TWD: 1 }, fetchedAt: Date.now() - 7 * 3600 * 1000, asOf: null, stale: false });
    mode = 'unsupported';
    await assert.rejects(fx.getFxRatesFor('XXX'), /unsupported-code/);
  } finally {
    global.fetch = realFetch;
    console.warn = realWarn;
  }
});

test('帳單辨識模型：GEMINI_RECEIPT_MODEL 可以覆寫，預設 gemini-3.1-flash-lite', () => {
  assert.equal(freshRequire('lib/receiptScan.js', { GEMINI_RECEIPT_MODEL: undefined }).RECEIPT_MODEL_NAME, 'gemini-3.1-flash-lite');
  assert.equal(freshRequire('lib/receiptScan.js', { GEMINI_RECEIPT_MODEL: 'gemini-9-test' }).RECEIPT_MODEL_NAME, 'gemini-9-test');
});
