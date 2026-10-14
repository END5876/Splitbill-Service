'use strict';
/**
 * 🔒 [安全性] 所有「由使用者決定、之後會被放進網頁」的識別碼與欄位，在這裡統一定義格式。
 * -----------------------------------------------------------------
 * 成員／支出／轉帳的 id、幣別代碼都會被前端放進 HTML 屬性（data-args、option value…），
 * 早期甚至直接拼進 inline onclick。只要伺服器願意存一個含引號的 id，任何拿到
 * 「可編輯分享連結」的人就能對行程建立者做 stored XSS。所以：
 *   - 伺服器只接受安全字元的 id／幣別（repairTrip 會修正或丟棄不合格的資料）
 *   - 前端另外一律跳脫、而且不再用 inline handler（見 public/js/actions.js）
 * 兩層都要有，任何一層單獨失守都不會出事。
 */

// 現有資料的 id：genId() 產生的 `prefix_8碼hex`、舊資料的 Discord snowflake、
// 早期 Bot 的 `exp_時間戳` 之類，全部落在這個字元集裡。
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// 幣別：ISO 4217 是三個大寫字母，但使用者可以自訂（例如 USDT），放寬到 2～10 個大寫英數。
const CURRENCY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

function isSafeId(v) {
  return typeof v === 'string' && SAFE_ID_RE.test(v);
}

function isCurrencyCode(v) {
  return typeof v === 'string' && CURRENCY_RE.test(v);
}

/** 有限數字才算數；其他（字串、NaN、Infinity、null）一律回傳 fallback。 */
function finiteOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 字串欄位：非字串回傳 fallback，否則截到 max 長度。 */
function str(v, max, fallback = '') {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 單筆支出／轉帳 API（routes/entries.js）的嚴格驗證。整包 PUT 為了相容舊版 Bot 只做
 * 修復（repairTrip），這裡則是新寫入的單筆資料，格式不對直接拒絕，不幫忙「猜」。
 * @returns {string|null} 錯誤訊息；null 表示通過
 */
function validateExpenseEntry(e, trip) {
  if (!e || typeof e !== 'object') return '缺少支出資料';
  if (typeof e.description !== 'string' || !e.description.trim()) return '請填寫項目說明';
  if (!(finiteOr(e.amount, 0) > 0)) return '金額必須是大於 0 的數字';
  if (!(finiteOr(e.amountInBase, 0) > 0)) return '換算後金額必須是大於 0 的數字';
  if (!isCurrencyCode(e.currency)) return '幣別格式錯誤';
  if (e.createdAt !== undefined && !Number.isFinite(e.createdAt)) return '日期格式錯誤';
  const memberIds = new Set(trip.members.map((m) => m.id));
  for (const [key, label] of [['payers', '代墊付款人'], ['participants', '分攤成員']]) {
    const list = e[key];
    if (!Array.isArray(list) || !list.length) return `請至少選擇一位${label}`;
    const seen = new Set();
    let sum = 0;
    for (const p of list) {
      if (!p || !isSafeId(p.userId) || !memberIds.has(p.userId)) return `${label}不是這個行程的成員`;
      if (seen.has(p.userId)) return `${label}重複`;
      seen.add(p.userId);
      const amt = p.amount;
      if (!Number.isFinite(amt) || amt < 0) return `${label}的金額必須是不小於 0 的數字`;
      sum += amt;
    }
    // 每個人四捨五入到小數兩位，總和最多差 0.01 × 人數
    if (Math.abs(round2(sum) - e.amount) > 0.01 * list.length + 1e-9) {
      return `${label}的金額總和（${round2(sum)}）與總金額（${e.amount}）不相符`;
    }
  }
  return null;
}

function validateDepositEntry(d, trip) {
  if (!d || typeof d !== 'object') return '缺少轉帳資料';
  const memberIds = new Set(trip.members.map((m) => m.id));
  if (!isSafeId(d.payerId) || !memberIds.has(d.payerId)) return '付款人不是這個行程的成員';
  if (!isSafeId(d.collectorId) || !memberIds.has(d.collectorId)) return '收款人不是這個行程的成員';
  if (d.payerId === d.collectorId) return '付款人與收款人不能是同一人';
  if (!(finiteOr(d.amount, 0) > 0)) return '金額必須是大於 0 的數字';
  if (!(finiteOr(d.amountInBase, 0) > 0)) return '換算後金額必須是大於 0 的數字';
  if (!isCurrencyCode(d.currency)) return '幣別格式錯誤';
  if (d.createdAt !== undefined && !Number.isFinite(d.createdAt)) return '日期格式錯誤';
  if (d.note !== undefined && typeof d.note !== 'string') return '備註格式錯誤';
  return null;
}

// ── 帳單辨識協作狀態（lib/receiptSessions.js）──
// 這份狀態完全由前端送上來、再透過 SSE 原樣廣播給同一個行程的其他人，
// 以前沒有任何檢查：品項 id、照片網址、偵測到的幣別都會被別人的瀏覽器放進 HTML。
// 這裡只留下已知欄位、而且每個欄位都限制型別與格式。
const IMAGE_DATA_URL_RE = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const MAX_RECEIPT_ITEMS = 200;

function sanitizeReceiptState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, MAX_RECEIPT_ITEMS)
    .filter((it) => it && typeof it === 'object' && isSafeId(it.id))
    .map((it) => ({
      id: it.id,
      name: str(it.name, 120),
      nameTranslated: str(it.nameTranslated, 120),
      basePrice: round2(finiteOr(it.basePrice, 0)),
      price: round2(finiteOr(it.price, 0)),
      priceOverridden: it.priceOverridden === true,
      type: it.type === 'fee' ? 'fee' : 'item',
      assignedTo: it.assignedTo === 'shared'
        ? 'shared'
        : (Array.isArray(it.assignedTo) ? [...new Set(it.assignedTo.filter(isSafeId))].slice(0, 100) : []),
    }));
  const state = {
    items,
    serviceChargeRate: Math.min(Math.max(finiteOr(raw.serviceChargeRate, 0), 0), 2),
    detectedCurrency: isCurrencyCode(raw.detectedCurrency) ? raw.detectedCurrency : null,
    detectedLanguage: str(raw.detectedLanguage, 20),
    attendeeIds: Array.isArray(raw.attendeeIds) ? [...new Set(raw.attendeeIds.filter(isSafeId))].slice(0, 100) : [],
    description: str(raw.description, 200),
    payerId: isSafeId(raw.payerId) ? raw.payerId : null,
    currency: isCurrencyCode(raw.currency) ? raw.currency : null,
  };
  // imageDataUrl：undefined＝沿用上一份（見 lib/receiptSessions.js），其他值必須是圖片 data URL
  if (typeof raw.imageDataUrl === 'string' && IMAGE_DATA_URL_RE.test(raw.imageDataUrl)) state.imageDataUrl = raw.imageDataUrl;
  else if (raw.imageDataUrl === null) state.imageDataUrl = null;
  return state;
}

module.exports = {
  SAFE_ID_RE,
  CURRENCY_RE,
  isSafeId,
  isCurrencyCode,
  finiteOr,
  str,
  validateExpenseEntry,
  validateDepositEntry,
  sanitizeReceiptState,
};
