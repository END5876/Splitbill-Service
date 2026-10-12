'use strict';

/* =====================================================================
   資料結構（與 Mousebot handlers/splitbill/utils/storage.js 對齊）
   Trip = {
     id, name, baseCurrency, rates:{cur:rate}, members:[{id,name}],
     expenses:[{id,description,amount,currency,amountInBase,payers:[{userId,amount}],
                participants:[{userId,amount}],createdAt,createdBy}],
     deposits:[{id,collectorId,payerId,amount,currency,amountInBase,note,createdAt}],
     archived, createdAt
   }
===================================================================== */

function genId(prefix){ return prefix + '_' + Math.random().toString(16).slice(2,10); }
function round2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }
function fmtMoney(amount, currency){
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '-';
  return amount.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// 明細裡的小金額（膠囊、對你的影響）：整數就不顯示 .00，省版面
function fmtMoneyCompact(amount){
  if (!Number.isFinite(amount)) return '-';
  const r = round2(amount);
  return r.toLocaleString('en-US', Number.isInteger(r) ? {maximumFractionDigits:0} : {minimumFractionDigits:2, maximumFractionDigits:2});
}

// 🆕 [成員頭像] 已連結 Discord、而且登入過網頁的成員，伺服器會附上 avatar（Discord CDN
// 網址，見 lib/storage.js 的 toPublicTrip）；其他成員用「名字第一個字＋固定色」。
// 顏色由成員 id 算出來，同一個人在每台裝置都是同一個顏色，不用另外存。
// 圖片疊在字母上面，載入失敗（換過頭像、網址失效）就移除圖片，露出字母頭像。
const AVATAR_COLORS = ['#5865F2', '#2D8A4E', '#C76A14', '#C2357F', '#2B7FB8', '#8E44AD', '#B83B3B', '#4A7A1E'];
function avatarColor(id){
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function memberAvatarHtml(memberId, size){
  const m = trip.members.find(x=>x.id===memberId);
  const name = m ? m.name : '?';
  const initial = escapeHtml(Array.from(name.trim())[0] || '?');
  const img = m && m.avatar
    ? `<img src="${escapeHtml(m.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  return `<span class="av${size==='sm'?' sm':''}" style="--av:${avatarColor(memberId)}" title="${escapeHtml(name)}" aria-hidden="true">${initial}${img}</span>`;
}

// 🆕 [時間資訊] 支出／轉帳明細列需要顯示「這筆是什麼時候記的」，同一年只顯示
// 月/日 時:分（多天行程最常見的情境，不需要年份佔版面）；跨年（例如年底/年初
// 出遊，或很久以前的舊行程）才自動補上年份，避免誤判成今年的紀錄。
function fmtDateTime(ts){
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const datePart = d.getFullYear() === now.getFullYear()
    ? `${d.getMonth()+1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
  return `${datePart} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 🆕 [日期分組] 只回傳「時:分」不含日期，用於已經依日期分組的清單（分組
// 標題已經顯示日期，每筆底下不需要再重複印一次日期，避免同一筆資訊
// 「9/23 14:30」旁邊又有一個「9/23」分組標題重複顯示同一件事）。
function fmtTime(ts){
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2,'0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 表單上的 <input type="date"> 用本地時區的 YYYY-MM-DD。
function toDateInputValue(ts){
  const d = new Date(ts);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
// 把表單選的日期套到時間戳上：只換年月日，保留 baseTs 原本的時:分
// （新增時傳 Date.now()，編輯時傳原本的 createdAt），同一天內的先後順序不會亂掉。
// 日期欄位空白或格式不對時原樣回傳 baseTs。
function applyDateToTimestamp(dateStr, baseTs){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return baseTs;
  const d = new Date(baseTs);
  d.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getTime();
}

// 🆕 [日期分組] 把一組帳目（支出／轉帳，需已依 createdAt 由新到舊排序）
// 依「日曆日期」分組，回傳 [{ label, items, subtotal }]。
// label：今天／昨天／M-D（同年）／Y/M/D（跨年）。
// subtotal：該組項目的 amountInBase 加總（沒有 amountInBase 則退回 amount），
// 一律以 trip.baseCurrency 顯示，方便一眼看出「這天大概花了多少」。
function fmtDateKey(d){
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
const WEEKDAY_LABELS = ['日','一','二','三','四','五','六'];
function groupItemsByDate(items){
  const groups = [];
  const now = new Date();
  const todayKey = fmtDateKey(now);
  const yest = new Date(now); yest.setDate(yest.getDate()-1);
  const yestKey = fmtDateKey(yest);
  let currentKey = null, currentGroup = null;
  for (const item of items){
    const d = new Date(item.createdAt || 0);
    const key = fmtDateKey(d);
    if (key !== currentKey){
      currentKey = key;
      const label = key === todayKey ? '今天'
        : key === yestKey ? '昨天'
        : d.getFullYear() === now.getFullYear() ? `${d.getMonth()+1}/${d.getDate()} · 週${WEEKDAY_LABELS[d.getDay()]}`
        : `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} · 週${WEEKDAY_LABELS[d.getDay()]}`;
      currentGroup = { label, items: [], subtotal: 0 };
      groups.push(currentGroup);
    }
    currentGroup.items.push(item);
    currentGroup.subtotal = round2(currentGroup.subtotal + (typeof item.amountInBase === 'number' ? item.amountInBase : (item.amount||0)));
  }
  return groups;
}

// 窄螢幕上按鈕改成只顯示圖示（文字仍保留給螢幕閱讀器與寬螢幕），見 style.css 的 .btn-label／.btn-ic。
const ICON_UNLINK = '<svg class="btn-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 4 8"/><line x1="8" y1="12" x2="12" y2="12"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
const ICON_TRASH = '<svg class="btn-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
