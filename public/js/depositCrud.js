'use strict';
// 轉帳／預收款的新增/編輯/刪除與即時匯率提示。
/* ===================== deposit CRUD ===================== */
let depositLiveRate = null; // { currency, rate, asOf }
async function refreshDepositLiveRate(){
  const currency = document.getElementById('depCurrency').value;
  if (currency === trip.baseCurrency){ depositLiveRate = null; renderDepositHint(); return; }
  const result = await fetchLiveRate(currency, trip.baseCurrency);
  if (document.getElementById('depCurrency').value !== currency) return;
  if (result){
    depositLiveRate = { currency, rate: result.rate, asOf: result.asOf };
    trip.rates[currency] = result.rate;
  } else {
    depositLiveRate = null;
  }
  renderDepositHint();
}
function resolveDepositRate(currency){
  if (currency === trip.baseCurrency) return 1;
  if (depositLiveRate && depositLiveRate.currency === currency) return depositLiveRate.rate;
  return trip.rates[currency];
}
function renderDepositHint(){
  const amount = parseFloat(document.getElementById('depAmount').value) || 0;
  const currency = document.getElementById('depCurrency').value;
  const customInput = document.getElementById('depAmountInBase');
  const customBase = parseFloat(customInput.value);
  const hintEl = document.getElementById('depBaseHint');
  if (!hintEl) return;
  const isForeign = currency !== trip.baseCurrency;
  document.getElementById('depBaseCurrencyLabel').textContent = trip.baseCurrency;
  document.getElementById('depBaseAmountField').hidden = !isForeign;
  if (!isForeign){ customInput.value = ''; hintEl.innerHTML = ''; return; }
  if (customInput.value.trim() !== ''){
    hintEl.innerHTML = Number.isFinite(customBase) && customBase > 0
      ? `會用你填的金額：<b>${fmtMoney(customBase, trip.baseCurrency)} ${trip.baseCurrency}</b>`
      : `請輸入大於 0 的金額，或清空這一欄改用匯率換算。`;
  } else if (depositLiveRate && depositLiveRate.currency === currency){
    const base = round2(amount*depositLiveRate.rate);
    hintEl.innerHTML = `約 <b>${fmtMoney(base, trip.baseCurrency)}</b>（1 ${currency} ＝ ${depositLiveRate.rate} ${trip.baseCurrency}）`;
  } else {
    const rate = trip.rates[currency];
    if (rate){
      const base = round2(amount*rate);
      hintEl.innerHTML = `約 <b>${fmtMoney(base, trip.baseCurrency)}</b>（正在查詢最新匯率…）`;
    } else {
      hintEl.innerHTML = `正在查詢 ${currency} 的匯率…`;
    }
  }
}
document.getElementById('depAmount').addEventListener('input', ev=>{
  const clean = cleanAmountText(ev.target.value);
  if (clean !== ev.target.value) ev.target.value = clean;
  renderDepositHint();
  updateDepositSteps();
});
document.getElementById('depAmountInBase').addEventListener('input', renderDepositHint);
document.getElementById('depCurrency').addEventListener('change', ()=>{ document.getElementById('depAmountInBase').value = ''; renderDepositHint(); updateDepositSteps(); refreshDepositLiveRate(); });

// 表單填了東西但還沒儲存（返回鍵、關閉頁面前提醒用）
function isDepositFormDirty(){
  const amt = document.getElementById('depAmount'), note = document.getElementById('depNote');
  return !!((amt && amt.value) || (note && note.value.trim()));
}
/* ---------- 三步驟：0 金額、1 誰付、2 誰收 ---------- */
let depositStep = 0;
function setDepositStep(n){
  depositStep = n;
  updateDepositSteps();
}
function updateDepositSteps(){
  showFormStep('depositFormBody', depositStep);
  const amount = parseFloat(document.getElementById('depAmount').value);
  const payerId = document.getElementById('depPayer').value, collectorId = document.getElementById('depCollector').value;
  document.getElementById('depStepVal0').textContent = amount > 0 ? `${fmtMoneyCompact(amount)} ${document.getElementById('depCurrency').value}` : '還沒填';
  document.getElementById('depStepVal1').textContent = payerId ? memberName(payerId) : '還沒選';
  document.getElementById('depStepVal2').textContent = collectorId ? memberName(collectorId) : '還沒選';
  renderDepositPickList('depPayerList', 'payer', payerId, '');
  renderDepositPickList('depCollectorList', 'collector', collectorId, payerId);
  const last = depositStep === 2 || !!editingDepositId;
  document.getElementById('btnNextDeposit').hidden = last;
  document.getElementById('btnSaveDepositSync').hidden = !last;
}
// 一人一列的單選清單；收款人清單裡，付款人那一列不能選
function renderDepositPickList(listId, party, selectedId, blockedId){
  const el = document.getElementById(listId);
  const focused = el.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  el.innerHTML = trip.members.map(m=>`
    <button type="button" class="pick-row" data-id="${escapeHtml(m.id)}" aria-pressed="${m.id === selectedId}" ${m.id === blockedId ? 'disabled' : ''} ${act('click', 'pickDepositParty', party, m.id)}>
      <span class="pick-dot" aria-hidden="true"></span><span class="chip-label">${escapeHtml(m.name)}</span>${m.id === blockedId ? '<span class="pick-note">付款人</span>' : ''}
    </button>`).join('') || '<p class="hint">尚未新增成員，請先到「設定 → 成員與分享」新增。</p>';
  if (focused){
    const back = [...el.children].find(b=>b.dataset.id === focused);
    if (back) back.focus({ preventScroll: true });
  }
}
function pickDepositParty(party, id){
  const payer = document.getElementById('depPayer'), collector = document.getElementById('depCollector');
  if (party === 'payer'){
    payer.value = id;
    if (collector.value === id) collector.value = '';
  } else {
    collector.value = id;
  }
  // 選好付款人就直接到下一步（編輯既有一筆時不自動跳）
  if (party === 'payer' && !editingDepositId) depositStep = 2;
  updateDepositSteps();
}
function nextDepositStep(){
  if (depositStep === 0 && !(parseFloat(document.getElementById('depAmount').value) > 0)){
    toast('請輸入大於 0 的金額。', 'error');
    document.getElementById('depAmount').focus();
    return;
  }
  if (depositStep === 1 && !document.getElementById('depPayer').value){
    toast('請選擇付款人。', 'error');
    return;
  }
  if (depositStep < 2) setDepositStep(depositStep + 1);
  const btn = document.getElementById(depositStep === 2 ? 'btnSaveDepositSync' : 'btnNextDeposit');
  if (!btn.hidden) btn.focus({ preventScroll: true });
}
function resetDepositForm(){
  if (typeof dropLayer === 'function') dropLayer('depositForm');
  editingDepositId = null;
  document.getElementById('depositFormTitle').textContent = '新增一筆轉帳／預收款';
  setFormCardEditing('depositFormCard', 'btnSaveDepositSync', 'btnResetDeposit', false);
  document.getElementById('depDate').value = toDateInputValue(Date.now());
  document.getElementById('depAmount').value = '';
  document.getElementById('depAmountInBase').value = '';
  document.getElementById('depNote').value = '';
  document.getElementById('depPayer').value = '';
  document.getElementById('depCollector').value = '';
  setDepositStep(0);
  renderDepositHint();
  refreshDepositLiveRate();
}
function saveDeposit(){
  const payerId = document.getElementById('depPayer').value;
  const collectorId = document.getElementById('depCollector').value;
  const amount = parseFloat(document.getElementById('depAmount').value);
  const currency = document.getElementById('depCurrency').value;
  const note = document.getElementById('depNote').value.trim();
  const dateStr = document.getElementById('depDate').value;
  if (!payerId || !collectorId){ setDepositStep(payerId ? 2 : 1); toast('請選擇付款人和收款人。', 'error'); return false; }
  if (payerId === collectorId){ setDepositStep(2); toast('付款人和收款人不能是同一人。', 'error'); return false; }
  if (!(amount>0)){ setDepositStep(0); toast('請輸入大於 0 的金額。', 'error'); return false; }
  const customBaseRaw = document.getElementById('depAmountInBase').value.trim();
  const customBase = parseFloat(customBaseRaw);
  let amountInBase;
  if (currency !== trip.baseCurrency && customBaseRaw !== ''){
    if (!(customBase > 0)){ setDepositStep(0); toast('實際金額要大於 0。', 'error'); return false; }
    amountInBase = round2(customBase);
  } else {
    const rate = resolveDepositRate(currency);
    if (!(rate>0)){ toast(`查不到 ${currency} 的匯率，請到「設定 → 行程」自己輸入匯率。`, 'error'); return false; }
    amountInBase = round2(amount*rate);
  }

  let saved;
  if (editingDepositId){
    saved = trip.deposits.find(d=>d.id===editingDepositId);
    if (!saved){
      // 編輯期間這筆被別人刪掉了（SSE 合併已移除）：退出編輯模式但保留表單內容，
      // 使用者想保留的話可以直接再按一次「儲存」重新新增
      editingDepositId = null;
      document.getElementById('depositFormTitle').textContent = '新增一筆轉帳／預收款';
      setFormCardEditing('depositFormCard', 'btnSaveDepositSync', 'btnResetDeposit', false);
      toast('這筆轉帳已經被其他人刪除。表單內容還在，按「記下這筆」可以重新新增。', 'error');
      return false;
    }
    Object.assign(saved, { payerId, collectorId, amount, currency, amountInBase, note, createdAt: applyDateToTimestamp(dateStr, saved.createdAt) });
    toast('已儲存這筆轉帳的修改', 'success');
  } else {
    saved = { id: genId('dep'), payerId, collectorId, amount, currency, amountInBase, note, createdAt: applyDateToTimestamp(dateStr, Date.now()) };
    trip.deposits.push(saved);
    toast(`已記下 ${memberName(payerId)} 付給 ${memberName(collectorId)} 的轉帳`, 'success');
  }
  resetDepositForm();
  renderAll();
  return saved;
}
async function saveDepositAndSync(){
  const isNew = !editingDepositId;
  const saved = saveDeposit();
  if (!saved) return;
  closeQuickAdd(); // 從「＋ 記一筆」打開的：存好就收起來
  await syncEntry('deposits', saved.id, saved, { isNew });
}
function editDeposit(id){
  const dep = trip.deposits.find(d=>d.id===id);
  if (!dep) return;
  editingDepositId = id;
  document.getElementById('depositFormTitle').textContent = '編輯轉帳紀錄';
  setFormCardEditing('depositFormCard', 'btnSaveDepositSync', 'btnResetDeposit', true);
  document.getElementById('depDate').value = toDateInputValue(dep.createdAt);
  renderDepositSelects();
  document.getElementById('depPayer').value = dep.payerId;
  document.getElementById('depCollector').value = dep.collectorId;
  document.getElementById('depCurrency').innerHTML = currencyOptions(dep.currency);
  document.getElementById('depAmount').value = dep.amount;
  document.getElementById('depAmountInBase').value = dep.currency !== trip.baseCurrency ? dep.amountInBase : '';
  document.getElementById('depNote').value = dep.note;
  setDepositStep(0);
  renderDepositHint();
  refreshDepositLiveRate();
  showMainTab('deposits');
  document.getElementById('depositFormCard').scrollIntoView({behavior:'smooth'});
}
async function deleteDeposit(id){
  const idx = trip.deposits.findIndex(d => d.id === id);
  if (idx === -1) return;

  const deposit = trip.deposits[idx];
  const confirmed = await confirmModal(
    `「${memberName(deposit.payerId)} → ${memberName(deposit.collectorId)}」這筆轉帳會被刪除，其他成員也會立刻看到。${othersEntryNote(deposit)}需要的話可以到「設定 → 紀錄」還原。`,
    {
      title: '刪除這筆轉帳？',
      confirmText: '刪除轉帳',
      cancelText: '取消',
      danger: true,
    }
  );

  if (!confirmed) return;

  // 確認視窗開著時 trip 可能被 SSE／存檔換掉或重新排序，要用 id 重新找位置
  const idxNow = trip.deposits.findIndex(d => d.id === id);
  if (idxNow !== -1) trip.deposits.splice(idxNow, 1);

  if (editingDepositId === id) {
    resetDepositForm();
  }

  renderAll();

  // 確認刪除後立即寫入伺服器；分享連結模式也會自動走對應的 API。
  await syncEntry('deposits', id, null);
}

