'use strict';
// 全域狀態（trip/editingExpenseId/shareMode 等）、分頁切換、行程名稱/幣別欄位監聽。
/* ===================== state ===================== */
let trip = defaultTrip();
let editingExpenseId = null;
let editingDepositId = null;
// 🆕 [日期分組＋收合明細] 記錄目前哪些支出／轉帳的明細是「展開」狀態；
// 不在集合裡＝預設收合（只顯示一行摘要），點擊該列標題即可展開/收合。
let expandedExpenseIds = new Set();
let expandedDepositIds = new Set();
// 🆕 [篩選／搜尋] 支出／轉帳明細各自獨立的篩選條件：關鍵字（支出比對說明、
// 轉帳比對備註）與成員（可複選；支出比對代墊人/分攤人、轉帳比對付款人/
// 收款人，符合「任一位」已勾選成員即算命中）。
// 換行程（載入／匯入／清空重開／進入分享模式）時應重置，見各呼叫端的
// resetListFilters()（定義於 render.js）。
let expenseFilterText = '';
let expenseFilterMemberIds = new Set();
let depositFilterText = '';
let depositFilterMemberIds = new Set();
// 🆕 [分享連結] null＝一般模式（Discord 登入）；
// 有值時代表這個分頁是透過分享連結打開的：{ token, permission:'read'|'write' }。
// 一旦進入分享模式就不會再切回擁有者模式（同一個分頁不混用兩種身分），
// 相關 UI 收斂見 body.share-mode / body.share-readonly 這兩個 CSS class。
let shareMode = null;

function memberName(id){ const m = trip.members.find(x=>x.id===id); return m ? m.name : '（已刪除成員）'; }
function currencyOptions(selected){
  return Object.keys(trip.rates).sort().map(c=>`<option value="${c}" ${c===selected?'selected':''}>${c}${c===trip.baseCurrency?' (基準)':''}</option>`).join('');
}

/* ===================== tabs ===================== */
let currentSettingsSub = 'trip';
// 設定頁從 6 個子分頁整併成 4 組；舊名稱保留成別名（程式各處與舊書籤仍在用），
// 會切到所屬分組並捲到對應卡片。
const SETTINGS_SUB_ALIASES = {
  members:  { sub: 'people',   anchor: 'membersCard' },
  share:    { sub: 'people',   anchor: 'shareCard' },
  rates:    { sub: 'trip',     anchor: 'ratesCard' },
  discord:  { sub: 'trip',     anchor: 'discordCard' },
  connect:  { sub: 'account',  anchor: null },
  io:       { sub: 'advanced', anchor: null },
};
function showMainTab(tab){
  document.querySelectorAll('#topNav .nav-btn, #bottomNav .nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.panel[data-panel]').forEach(p=>p.classList.toggle('active', p.dataset.panel===tab));
  if (tab === 'settings') showSettingsSub(currentSettingsSub);
  if (tab === 'expenses' && typeof checkReceiptSessionAvailability === 'function') checkReceiptSessionAvailability(); // 🆕 [多人協作] 進入支出分頁時，順便確認有沒有人正在進行帳單辨識協作
  renderAll();
  window.scrollTo({top:0, behavior:'smooth'});
}
function showSettingsSub(sub){
  const alias = SETTINGS_SUB_ALIASES[sub];
  if (alias) sub = alias.sub;
  currentSettingsSub = sub;
  document.querySelectorAll('.settings-subnav .subtab-btn').forEach(b=>b.classList.toggle('active', b.dataset.subtab===sub));
  document.querySelectorAll('.subpanel[data-subpanel]').forEach(p=>p.classList.toggle('active', p.dataset.subpanel===sub));
  if (sub === 'advanced'){ syncAdvDetailsState(); renderJsonPreview(); }
  if (sub === 'people') renderTripLinksPanel();
  if (sub === 'trip') renderDiscordPanel();
  // 有指定卡片就捲過去；否則切換分組後回到頂端，不要停在上一個分組的捲動位置
  const anchorEl = alias && alias.anchor && document.getElementById(alias.anchor);
  if (anchorEl) requestAnimationFrame(()=>anchorEl.scrollIntoView({ behavior:'smooth', block:'start' }));
  else if (document.getElementById('panel-settings').classList.contains('active')) window.scrollTo({ top:0 });
}
// 已開啟雲端行程時，把「本機檔案／下載貼上／匯入」這些備用方式預設收合，
// 減少畫面雜訊；沒連線時預設展開，因為那時候本機方式就是主要路徑。
function syncAdvDetailsState(){
  const details = document.getElementById('advFileDetails');
  if (!details) return;
  const connected = isConnected();
  if (!details.dataset.userToggled) details.open = !connected;
}

/* ===================== cover fields ===================== */
document.getElementById('tripName').addEventListener('input', e=>{ trip.name = e.target.value; scheduleAutoSave(); scheduleCloudSave(1000); });
document.addEventListener('DOMContentLoaded', ()=>{
  const details = document.getElementById('advFileDetails');
  if (details) details.addEventListener('toggle', ()=>{ details.dataset.userToggled = '1'; });
});

