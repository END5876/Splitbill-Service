'use strict';
const express = require('express');
const { createRateLimiter } = require('../lib/rateLimit');

// 帳單辨識會消耗共用的 Gemini 額度；任何 Discord 帳號都能登入網頁，因此每位呼叫者
// （登入者／分享連結）每小時最多 30 次。Bot 有自己的限流（Mousebot billScan.js），不在此限。
const receiptLimiter = createRateLimiter({ limit: 30, windowMs: 60 * 60 * 1000 });
const MAX_RECEIPT_IMAGE_BYTES = 4 * 1024 * 1024; // 收到的 JPEG 檔案大小上限（base64 解碼後；前端已先縮圖壓縮）

// 不綁定特定行程的共用工具端點：即時匯率查詢、帳單照片辨識。
// 同一組 handler 掛在兩種路徑上（做法同 routes/receiptSession.js）：
//   /api/<端點>                       Bot／登入的使用者
//   /api/shared-trip/:token/<端點>    分享連結訪客（token 本身就是憑證）
module.exports = function createUtilityRouter(ctx) {
  const { requireShareLink, getFxRatesFor, genAI, recognizeReceipt } = ctx;
  const router = express.Router();

  /**
   * 確認呼叫者可以使用工具端點；不通過時直接寫好錯誤回應並回傳 null。
   * 通過時回傳限流與記錄用的呼叫者代號（Bot 為 'service'）。
   * @param {string|null} writeDeniedMsg 需要可編輯權限時，唯讀分享連結看到的錯誤訊息
   */
  function utilityCaller(req, res, writeDeniedMsg) {
    if (req.params.token) {
      return requireShareLink(req, res, writeDeniedMsg) ? `s:${req.params.token}` : null;
    }
    const p = req.principal;
    if (p && p.kind === 'service') return 'service';
    if (p && p.kind === 'user') return `u:${p.userId}`;
    res.status(401).json({ error: '請先登入，或使用有效的分享連結', needLogin: true });
    return null;
  }

  // ---- GET /api/fx-rate?from=JPY&to=TWD：取得當下即時匯率（供非基準幣支出/轉帳換算 amountInBase 用）----
  // 🆕 [分享連結] 查即時匯率本身是唯讀操作、不會洩漏任何特定行程的私密資料，
  // 因此開放給任何一把尚未過期的分享連結使用（唯讀或可編輯皆可）——唯讀訪客
  // 雖然不能存檔，但檢視金額換算後的正確結果一樣需要即時匯率。
  router.get(['/fx-rate', '/shared-trip/:token/fx-rate'], async (req, res) => {
    if (!utilityCaller(req, res, null)) return;
    const from = String(req.query.from || '').trim().toUpperCase();
    const to = String(req.query.to || '').trim().toUpperCase();
    if (!from || !to) return res.status(400).json({ error: '缺少 from 或 to 參數' });
    if (from === to) return res.json({ rate: 1, asOf: null, source: 'same-currency' });
    try {
      const { rates, asOf } = await getFxRatesFor(from);
      const rate = rates[to];
      if (typeof rate !== 'number') {
        return res.status(404).json({ error: `即時匯率服務裡找不到 ${from} 兌 ${to} 的匯率` });
      }
      res.json({ rate, asOf, source: 'open.er-api.com' });
    } catch (err) {
      res.status(502).json({ error: '查詢即時匯率失敗：' + err.message });
    }
  });

  // ---- POST /api/parse-receipt：上傳帳單照片，用 Gemini 的視覺能力辨識出品項、金額、
  // 服務費比例、幣別。跟專案既有 /ai 指令共用同一把 GEMINI_API_KEY。 ----
  // body: { image: '<純 base64，不含 data: 前綴>', mediaType: 'image/jpeg' }
  // 🆕 [分享連結] 帳單照片辨識會消耗共用的 Gemini API 額度、且是「新增資料」
  // 性質的操作，因此只開放給擁有者本人，或是擁有「可編輯」權限的分享連結
  // （唯讀連結不行——唯讀訪客本來就不能新增花費，開放掃描給他們也用不上）。
  router.post(['/parse-receipt', '/shared-trip/:token/parse-receipt'], async (req, res) => {
    const who = utilityCaller(req, res, '此分享連結為唯讀，無法使用帳單辨識');
    if (!who) return;
    if (who !== 'service') {
      const r = receiptLimiter.take(who);
      if (!r.ok) {
        return res.status(429).json({ error: `帳單辨識次數已達上限，請 ${Math.ceil(r.retryAfterMs / 60000)} 分鐘後再試` });
      }
    }
    if (!genAI) {
      return res.status(500).json({ error: '伺服器尚未設定 GEMINI_API_KEY，無法使用帳單辨識功能' });
    }
    const { image, mediaType } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: '缺少圖片資料' });
    }
    // 前端會先縮圖，這裡再擋一次，避免繞過前端直接送超大原圖耗用 Gemini 額度
    if (image.length * 3 / 4 > MAX_RECEIPT_IMAGE_BYTES) {
      return res.status(413).json({ error: `圖片太大，請壓縮到 ${MAX_RECEIPT_IMAGE_BYTES / 1024 / 1024}MB 以下再上傳` });
    }
    try {
      const sanitized = await recognizeReceipt(image, mediaType, who.startsWith('s:') ? 'share-link' : who);
      res.json(sanitized);
    } catch (err) {
      res.status(500).json({ error: '帳單辨識失敗：' + err.message });
    }
  });

  return router;
};
