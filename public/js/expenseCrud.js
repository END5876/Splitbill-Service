'use strict';
// 支出的新增/編輯/刪除，與「表單是否有未儲存內容」的保護判斷。
/* ===================== expense CRUD ===================== */
// 🆕 [即時同步保護] 判斷「新增支出」表單目前是否有使用者還沒送出的內容——
// 不只是編輯既有支出（editingExpenseId），也包含「正在填一筆全新的支出」：
// 已輸入項目名稱/金額，或已勾選任何代墊人/分攤成員。
// 用途：renderAll() 在別人透過 SSE 存檔、或任何其他操作觸發重繪時，
// 都會呼叫 buildChips() 整個重建 chips 清單（innerHTML 覆蓋），這會讓
// 使用者剛勾選的成員與手動調整的金額無聲消失。呼叫端只要偵測到這裡回傳
// true，就該跳過重建，保留使用者正在輸入的內容。
function hasUnsavedExpenseFormContent(){
  if (editingExpenseId) return true; // 正在編輯既有一筆，本來就該保護
  const descEl = document.getElementById('expDesc');
  const amountEl = document.getElementById('expAmount');
  if ((descEl && descEl.value.trim()) || (amountEl && amountEl.value.trim())) return true;
  if (document.querySelector('#payerChips .chip.checked')) return true;
  if (document.querySelector('#participantChips .chip.checked')) return true;
  return false;
}

function resetExpenseForm(){
  if (typeof dropLayer === 'function') dropLayer('expenseForm');
  editingExpenseId = null;
  participantsDirty = false;
  setSplitModeState('equal');
  setExpenseStep(0);
  document.getElementById('expenseFormTitle').textContent = '新增一筆支出';
  setFormCardEditing('expenseFormCard', 'btnSaveExpenseSync', 'btnResetExpense', false);
  document.getElementById('expDesc').value = '';
  document.getElementById('expDesc').removeAttribute('aria-invalid');
  document.getElementById('expDate').value = toDateInputValue(Date.now());
  document.getElementById('expAmount').value = '';
  document.getElementById('expAmountInBase').value = '';
  buildChips('payerChips','payer');
  buildChips('participantChips','participant');
  renderExpenseHint();
  refreshExpenseLiveRate();
}
function resolveExpenseRate(currency){
  if (currency === trip.baseCurrency) return 1;
  if (expenseLiveRate && expenseLiveRate.currency === currency) return expenseLiveRate.rate;
  return trip.rates[currency];
}
function saveExpense(){
  const descEl = document.getElementById('expDesc');
  const description = descEl.value.trim();
  if (!description){
    setExpenseStep(0);
    descEl.setAttribute('aria-invalid', 'true');
    descEl.focus();
    toast('請填寫項目說明，之後查帳才認得出這筆是什麼。', 'error');
    return false;
  }
  const dateStr = document.getElementById('expDate').value;
  const amount = parseFloat(document.getElementById('expAmount').value);
  const currency = document.getElementById('expCurrency').value;
  if (!(amount>0)){ setExpenseStep(0); toast('請輸入大於 0 的金額。', 'error'); return false; }
  const customBaseRaw = document.getElementById('expAmountInBase').value.trim();
  const customBase = parseFloat(customBaseRaw);
  let amountInBase;
  if (currency !== trip.baseCurrency && customBaseRaw !== ''){
    if (!(customBase > 0)){ setExpenseStep(0); toast('實際金額要大於 0。', 'error'); return false; }
    amountInBase = round2(customBase);
  } else {
    const rate = resolveExpenseRate(currency);
    if (!(rate>0)){ toast(`查不到 ${currency} 的匯率，請到「設定 → 行程」自己輸入匯率。`, 'error'); return false; }
    amountInBase = round2(amount*rate);
  }

  const payers = readChipValues('payer').filter(p=>p.amount>0 || document.querySelector(`#payerChips .chip[data-id="${p.userId}"]`).classList.contains('checked'));
  const participants = readChipValues('participant');

  if (!payers.length){ setExpenseStep(1); toast('請至少勾選一位先付錢的人。', 'error'); return false; }
  if (!participants.length){ setExpenseStep(2); toast('請至少勾選一位要分攤的人。', 'error'); return false; }

  const payerSum = round2(payers.reduce((s,p)=>s+p.amount,0));
  if (round2(Math.abs(payerSum-amount)) > 0.01){ setExpenseStep(1); toast(`代墊金額加起來是 ${payerSum}，跟總金額 ${amount} 不一樣，請調整後再記下。`, 'error'); return false; }
  const partSum = round2(participants.reduce((s,p)=>s+p.amount,0));
  if (round2(Math.abs(partSum-amount)) > 0.01){ setExpenseStep(2); toast(`分攤金額加起來是 ${partSum}，跟總金額 ${amount} 不一樣，請調整後再記下。`, 'error'); return false; }

  let saved;
  if (editingExpenseId){
    saved = trip.expenses.find(e=>e.id===editingExpenseId);
    if (!saved){
      // 編輯期間這筆被別人刪掉了（SSE 合併已移除）：退出編輯模式但保留表單內容，
      // 使用者想保留的話可以直接再按一次「儲存」重新新增
      editingExpenseId = null;
      document.getElementById('expenseFormTitle').textContent = '新增一筆支出';
      setFormCardEditing('expenseFormCard', 'btnSaveExpenseSync', 'btnResetExpense', false);
      toast('這筆支出已經被其他人刪除。表單內容還在，按「記下這筆」可以重新新增。', 'error');
      return false;
    }
    Object.assign(saved, { description, amount, currency, amountInBase, payers, participants, createdAt: applyDateToTimestamp(dateStr, saved.createdAt) });
    toast(`已儲存「${description}」的修改`, 'success');
  } else {
    saved = {
      id: genId('exp'), description, amount, currency, amountInBase,
      payers, participants, createdAt: applyDateToTimestamp(dateStr, Date.now()), createdBy: 'web-ui'
    };
    trip.expenses.push(saved);
    toast(`已記下「${description}」`, 'success');
  }
  resetExpenseForm();
  renderAll();
  return saved;
}
// 只把這一筆送到伺服器（見 js/tripSync.js 的 syncEntry）
async function saveExpenseAndSync(){
  const isNew = !editingExpenseId;
  const saved = saveExpense();
  if (!saved) return;
  closeQuickAdd(); // 從「＋ 記一筆」打開的：存好就收起來，回到原本的畫面
  await syncEntry('expenses', saved.id, saved, { isNew });
}

/* ---------- 快速記一筆（手機）：右下浮動按鈕打開底部面板，就是支出／轉帳分頁的同一張表單，上方可以切換 ---------- */
let quickAddReturnTab = null; // 從哪個分頁打開的：收起面板時回到那裡
async function openQuickAdd(){
  if (!trip.members || !trip.members.length){
    toast('先到「設定 → 成員與分享」新增成員，才能記帳', 'info');
    return;
  }
  const tab = document.body.dataset.tab || 'overview';
  if (!await showQuickAddForm(tab === 'deposits' ? 'deposits' : 'expenses', openQuickAddSheet)) return;
  quickAddReturnTab = tab;
}
function openQuickAddSheet(){
  document.body.classList.add('quick-add');
  document.getElementById('quickAddBackdrop').hidden = false;
  pushLayer('quickAdd', closeQuickAdd); // 返回鍵先收起面板
}
// 面板上方「支出｜轉帳／預收」：兩張表單各自保留填到一半的內容
async function switchQuickAdd(kind){
  if (document.body.dataset.tab !== kind) await showQuickAddForm(kind);
}
async function showQuickAddForm(kind, beforeFocus){
  const dep = kind === 'deposits';
  const editing = dep ? editingDepositId : editingExpenseId;
  // 正在編輯別筆而且改過：先問，不要默默丟掉
  if (editing && (dep ? isDepositFormDirty() : isExpenseFormDirty())){
    const ok = await confirmModal('剛剛改的內容還沒儲存。', { title: '放棄這次修改？', confirmText: '放棄修改', cancelText: '繼續編輯' });
    if (!ok) return false;
  }
  if (document.body.dataset.tab !== kind) showMainTab(kind);
  if (editing) (dep ? resetDepositForm : resetExpenseForm)(); // 正在編輯別筆：改成新增
  setFormCardOpen(dep ? 'depositFormCard' : 'expenseFormCard', true);
  if (beforeFocus) (dep ? setDepositStep : setExpenseStep)(0);
  if (beforeFocus) beforeFocus();
  // iOS 只有在使用者點擊的同一輪才會跳出鍵盤，不能延遲
  document.getElementById(dep ? 'depAmount' : 'expAmount').focus({ preventScroll: true });
  return true;
}
function closeQuickAdd(){
  if (!document.body.classList.contains('quick-add')) return;
  document.body.classList.remove('quick-add');
  document.getElementById('quickAddBackdrop').hidden = true;
  dropLayer('quickAdd');
  const back = quickAddReturnTab;
  quickAddReturnTab = null;
  if (back && back !== document.body.dataset.tab) showMainTab(back);
}

// 表單填了東西但還沒儲存（返回鍵、關閉頁面前提醒用）
function isExpenseFormDirty(){
  const desc = document.getElementById('expDesc'), amt = document.getElementById('expAmount');
  return !!((desc && desc.value.trim()) || (amt && amt.value));
}
function editExpense(id){
  const exp = trip.expenses.find(e=>e.id===id);
  if (!exp) return;
  editingExpenseId = id;
  setExpenseStep(0);
  participantsDirty = true; // 編輯既有支出時，尊重原本已經存好的分攤金額，不要自動覆蓋
  document.getElementById('expenseFormTitle').textContent = '編輯支出';
  setFormCardEditing('expenseFormCard', 'btnSaveExpenseSync', 'btnResetExpense', true);
  document.getElementById('expDesc').value = exp.description;
  document.getElementById('expDesc').removeAttribute('aria-invalid');
  document.getElementById('expDate').value = toDateInputValue(exp.createdAt);
  document.getElementById('expAmount').value = exp.amount;
  document.getElementById('expCurrency').innerHTML = currencyOptions(exp.currency);
  document.getElementById('expAmountInBase').value = exp.currency !== trip.baseCurrency ? exp.amountInBase : '';
  buildChips('payerChips','payer');
  buildChips('participantChips','participant');
  // 🆕 [成員膠囊重新設計] 金額欄位預設是 disabled 的幽靈槽位，這裡改用
  // setChipChecked() 統一處理（同步勾選 checkbox、切掉 disabled、更新樣式），
  // 而不是只加 .checked class——不然輸入框雖然顯示了金額，卻仍是唯讀的。
  exp.payers.forEach(p=>{
    const chip = document.querySelector(`#payerChips .chip[data-id="${p.userId}"]`);
    if (chip){ setChipChecked(chip, true); chip.querySelector('.amt').value = p.amount; }
  });
  // 載入既有支出時，所有儲存的代墊金額都是既有的手動分配；
  // 標記後可避免自動平衡機制改寫歷史紀錄。
  payerManualIds = new Set(exp.payers.map(p=>p.userId));
  exp.participants.forEach(s=>{
    const chip = document.querySelector(`#participantChips .chip[data-id="${s.userId}"]`);
    if (chip){ setChipChecked(chip, true); chip.querySelector('.amt').value = s.amount; }
  });
  // 🆕 同理，載入既有支出時所有儲存的分攤金額也視為既有的手動分配；
  // 標記後可避免 rebalanceParticipantAmounts() 之後改寫這些歷史紀錄
  // （目前 participantsDirty=true 已會整組跳過自動平衡，這裡補上是為了
  // 讓狀態保持一致——萬一之後 participantsDirty 被重置為 false，
  // 例如使用者中途按了其他按鈕，仍能正確識別哪些人是「已手動」金額）。
  participantManualIds = new Set(exp.participants.map(p=>p.userId));
  updateChipFieldMeta('payerChips');
  updateChipFieldMeta('participantChips');
  // 分攤方式依存檔的金額判斷：存的是平分／各付各的就用那個方式，其他一律當自訂
  const mode = detectSplitMode(exp);
  if (mode !== 'custom'){ participantsDirty = false; participantManualIds = new Set(); }
  idsBeforeSelf = null;
  setSplitModeState(mode);
  // 🆕 [手動標記視覺化] 編輯既有支出時載入的金額全部視為「手動」，
  // 同步套上 .chip.manual 視覺標記，讓使用者知道這些是原始存檔的值。
  syncManualMarks('payer');
  syncManualMarks('participant');
  renderExpenseHint();
  refreshExpenseLiveRate();
  showMainTab('expenses');
  document.getElementById('expenseFormCard').scrollIntoView({behavior:'smooth'});
}
// 刪別人記的帳時多提醒一句「這筆是阿華記的」（自己記的、看不出是誰的就不說）
function othersEntryNote(x){
  const who = authorName(x.createdBy);
  return who && who !== '你' ? `這筆是${who}記的。` : '';
}
// 刪一筆帳：自己記的直接刪、提示可以復原；別人記的（含認不出是誰、訪客）先確認
async function deleteEntry(kind, id, el, kindName, label, afterDelete){
  const entry = trip[kind].find(x => x.id === id);
  if (!entry || document.body.matches('.share-readonly, .trip-archived')) return;
  if (authorName(entry.createdBy) !== '你'){
    const ok = await confirmModal(
      `「${label(entry)}」會被刪除，其他成員也會立刻看到。${othersEntryNote(entry)}需要的話可以到「設定 → 紀錄」還原。`,
      { title: `刪除這筆${kindName}？`, confirmText: `刪除${kindName}`, cancelText: '取消', danger: true }
    );
    if (!ok) return;
  }
  const tripId = trip.id;
  await swipeRowOut(el);
  if (trip.id !== tripId) return;
  // 確認視窗、動畫期間 trip 可能被 SSE／存檔換掉，要用 id 重新找位置
  const idx = trip[kind].findIndex(x => x.id === id);
  if (idx === -1){ renderAll(); return; }
  const [removed] = trip[kind].splice(idx, 1);
  afterDelete();
  renderAll();
  const saved = syncEntry(kind, id, null);
  toastUndo(`已刪除「${label(removed)}」`, async () => {
    await saved; // 等刪除存完再還原，順序不會顛倒
    if (trip.id !== tripId || trip[kind].some(x => x.id === id)) return;
    trip[kind].push(removed);
    renderAll();
    await syncEntry(kind, id, removed, { restore: true });
  });
  await saved;
}
async function deleteExpense(id, el){
  await deleteEntry('expenses', id, el, '支出', x => x.description || '未命名支出', () => { if (editingExpenseId === id) resetExpenseForm(); });
}
