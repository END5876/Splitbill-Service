'use strict';
// 事件委派：取代 HTML 裡 inline 的 onclick／onchange／oninput 屬性。
/* =====================================================================
   🔒 [安全性] 為什麼不用 inline handler
   ---------------------------------------------------------------------
   以前的寫法是把 id 直接拼進 onclick 屬性裡的 editExpense('…')：資料被拼進一段
   「會被當成 JavaScript 執行」的字串，就算用 escapeHtml() 也擋不住（瀏覽器會先把 &#39;
   解回 ' 再執行），只要有人存進一個含引號的 id 就是 stored XSS。

   現在一律寫成資料屬性，由這裡統一接手：
     <button data-click="editExpense" data-args='["exp_1"]'>
     data-click / data-change / data-input：對應的事件
     data-enter：在輸入框按 Enter（輸入法組字中不算）
     data-loading="儲存中…"：用 withLoading() 包起來（按鈕轉圈、防連點）
   data-args 是 JSON 陣列，其中這幾個字串會換成執行當下的值：
     "$value" → 元素的 value　"$checked" → checkbox 是否勾選
     "$el"    → 元素本身　　　"$event"   → 事件物件
   只能呼叫 UI_ACTIONS 列出的函式；伺服器另外送出 CSP，瀏覽器根本不會執行 inline handler。

   在 template 裡用 act() 產生屬性，參數會被正確地 JSON 化＋跳脫：
     `<button ${act('click', 'editExpense', e.id)}>`
===================================================================== */
const UI_ACTIONS = new Set([
  'abandonReceiptSession', 'addMember', 'addRate', 'checkAllParticipants', 'chooseGuestMode',
  'claimJoinAsNew', 'clearDepositFilter', 'clearExpenseFilter', 'clearInvalid', 'closeLinkComposer',
  'confirmJoinClaim', 'copyBindCommand', 'copyInviteLink', 'copyJson', 'copyLinkUrl',
  'createTripLink', 'createTripOnServer', 'deleteDeposit', 'deleteExpense', 'detachFromDiscord',
  'downloadJson', 'editDeposit', 'editExpense', 'equalFillChips', 'finalizeReceiptExpense',
  'focusNewMemberInput', 'generateBindCode', 'goAddMember', 'goHome', 'handleFileImport',
  'handleReceiptUpload', 'importJsonAsNewTrip', 'joinReceiptSession', 'leaveJoinScreen',
  'loadTripFromApi', 'loadTripLinks', 'loginWithDiscord', 'logout', 'markTransferPaid',
  'onChipToggle', 'onDebtCurrencyChange', 'onDebtViewChange', 'onDepositFilterChange',
  'onExpenseFilterChange', 'onParticipantAmountInput', 'onPayerAmountInput', 'onSyncStatusClick',
  'openLinkComposer', 'openTripSwitcher', 'pickLinkPreset', 'receiptAddManualItem',
  'receiptRemoveItem', 'receiptResetUpload', 'receiptSetField', 'receiptSetShared',
  'receiptToggleAttendee', 'receiptToggleClaim', 'receiptToggleItemType', 'receiptUpdateField',
  'receiptUpdateServiceChargeRate', 'refreshTripList', 'removeMember', 'removeRate', 'renameMember',
  'resetDepositForm', 'resetExpenseForm', 'revealInviteNewBlock', 'revokeTripLink',
  'saveDepositAndSync', 'saveExpenseAndSync', 'saveLinkEdit', 'saveMyNickname',
  'selfShareParticipants', 'setLinkComposerDays', 'setLinkComposerJoin', 'setLinkComposerLabel',
  'setLinkEditGuest', 'setLinkEditJoin', 'setLinkEditLabel', 'setShowAllTrips', 'showMainTab',
  'showSettingsSub', 'startFirstDeposit', 'startFirstExpense', 'toggleDepositExpand',
  'toggleDepositFilterMember', 'toggleExpenseExpand', 'toggleExpenseFilterMember', 'toggleFormCard',
  'toggleLinkEditor', 'toggleMemberDetail', 'toggleTheme', 'unlinkMember', 'updateRate',
]);

/** 產生 data-<type>="name" data-args="[…]" 屬性字串（放進 HTML template 用）。 */
function act(type, name, ...args){
  const argsAttr = args.length ? ` data-args="${escapeHtml(JSON.stringify(args))}"` : '';
  return `data-${type}="${escapeHtml(name)}"${argsAttr}`;
}

function resolveActionArg(arg, el, ev){
  switch (arg){
    case '$value': return el.value;
    case '$checked': return el.checked;
    case '$el': return el;
    case '$event': return ev;
    default: return arg;
  }
}

function runUiAction(el, ev, name){
  if (!UI_ACTIONS.has(name) || typeof window[name] !== 'function'){
    console.warn('[actions] 未登記的動作：', name);
    return;
  }
  let args = [];
  try{ args = el.dataset.args ? JSON.parse(el.dataset.args) : []; }catch(e){ args = []; }
  if (!Array.isArray(args)) args = [];
  args = args.map(a => resolveActionArg(a, el, ev));
  const fn = window[name];
  if (el.dataset.loading) return withLoading(el, el.dataset.loading, () => fn(...args));
  return fn(...args);
}

function delegate(eventName, attr, filter){
  document.addEventListener(eventName, ev => {
    const el = ev.target instanceof Element ? ev.target.closest(`[${attr}]`) : null;
    if (!el || (filter && !filter(ev, el))) return;
    runUiAction(el, ev, el.getAttribute(attr));
  });
}
delegate('click', 'data-click');
delegate('change', 'data-change');
delegate('input', 'data-input');
delegate('keydown', 'data-enter', (ev) => {
  if (ev.key !== 'Enter' || ev.isComposing) return false;
  ev.preventDefault();
  return true;
});

/* ---- 原本寫在 inline handler 裡的小段程式 ---- */
function clearInvalid(el){
  el.removeAttribute('aria-invalid');
}
function startFirstExpense(){
  showMainTab('expenses');
  setFormCardOpen('expenseFormCard', true);
  document.getElementById('expDesc').focus();
}
function startFirstDeposit(){
  showMainTab('deposits');
  setFormCardOpen('depositFormCard', true);
  document.getElementById('depPayer').focus();
}
function focusNewMemberInput(){
  document.getElementById('newMemberName').focus();
}
function goAddMember(){
  showMainTab('settings');
  showSettingsSub('members');
  focusNewMemberInput();
}
