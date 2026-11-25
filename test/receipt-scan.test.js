'use strict';
// 帳單辨識：送給 Gemini 的請求內容、回應解析、失敗時的紀錄
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = 'test-key';
const { recognizeReceipt } = require('../lib/receiptScan');
const upstream = require('../lib/upstreamStatus');

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('送出圖片與設定，並解析回應', async () => {
  let sent;
  let headers;
  const receipt = { currency: 'jpy', language: '日文', serviceChargeRate: 0.1, items: [{ name: 'ラーメン', nameTranslated: '拉麵', price: 900, type: 'item' }] };
  const out = await withFetch(async (url, init) => {
    assert.match(String(url), /models\/gemini-.*:generateContent/);
    sent = JSON.parse(init.body);
    headers = new Headers(init.headers);
    return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(receipt) }] } }], usageMetadata: { totalTokenCount: 5 } });
  }, () => recognizeReceipt('QUJD', 'image/png'));

  assert.deepEqual(sent.contents[0].parts[0].inlineData, { mimeType: 'image/png', data: 'QUJD' });
  assert.equal(sent.generationConfig.responseMimeType, 'application/json');
  assert.equal(sent.generationConfig.temperature, 0.1);
  assert.equal(headers.get('x-server-timeout'), '60');
  assert.equal(out.currency, 'JPY');
  assert.equal(out.items[0].nameTranslated, '拉麵');
});

test('沒有文字（被擋下）時丟出錯誤；呼叫失敗記進外部服務狀態', async () => {
  await withFetch(async () => reply({ promptFeedback: { blockReason: 'SAFETY' } }),
    () => assert.rejects(recognizeReceipt('QUJD'), /沒有回傳/));
  await withFetch(async () => { throw new TypeError('fetch failed'); },
    () => assert.rejects(recognizeReceipt('QUJD')));
  assert.equal(upstream.snapshot().gemini.state, 'degraded');
});
