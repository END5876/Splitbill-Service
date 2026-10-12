'use strict';
// renderAll()：把目前 trip 狀態重繪到整個頁面各個區塊。
/* ===================== render ===================== */
function renderDepositSelects(){
  const opts = trip.members.map(m=>`<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  const prevPayer = document.getElementById('depPayer').value;
  const prevCollector = document.getElementById('depCollector').value;
  const prevCurrency = document.getElementById('depCurrency').value || trip.baseCurrency;
  document.getElementById('depPayer').innerHTML = '<option value="">請選擇</option>' + opts;
  document.getElementById('depCollector').innerHTML = '<option value="">請選擇</option>' + opts;
  document.getElementById('depCurrency').innerHTML = currencyOptions(prevCurrency);
  if (prevPayer && trip.members.some(m=>m.id===prevPayer)) document.getElementById('depPayer').value = prevPayer;
  if (prevCollector && trip.members.some(m=>m.id===prevCollector)) document.getElementById('depCollector').value = prevCollector;
  syncDepositPartyOptions();
}
// 付款人與收款人不能是同一人：在另一邊的選單裡停用已被選走的成員，
// 從源頭避免選錯，而不是等按下儲存才跳錯誤提示。
function syncDepositPartyOptions(){
  const payerSel = document.getElementById('depPayer');
  const collectorSel = document.getElementById('depCollector');
  [...collectorSel.options].forEach(o=>{ o.disabled = !!o.value && o.value === payerSel.value; });
  [...payerSel.options].forEach(o=>{ o.disabled = !!o.value && o.value === collectorSel.value; });
}
function emptyState(icon, text, ctaLabel, ctaOnclick){
  return `<div class="empty-state">
    <div class="ic">${icon}</div>
    <p>${escapeHtml(text)}</p>
    ${ctaLabel ? `<button class="btn btn-ghost btn-sm" onclick="${ctaOnclick}">${escapeHtml(ctaLabel)}</button>` : ''}
  </div>`;
}

// 🆕 [日期分組＋收合明細] 展開/收合單一筆支出／轉帳的詳細內容。
// 直接呼叫 renderAll() 重繪整頁——跟 editExpense() 等既有操作走同一套模式，
// 筆數量級下（數百筆內）效能沒有問題，也不用另外維護局部更新的邏輯。
function toggleExpenseExpand(id){
  if (expandedExpenseIds.has(id)) expandedExpenseIds.delete(id); else expandedExpenseIds.add(id);
  renderExpenseList();
}
function toggleDepositExpand(id){
  if (expandedDepositIds.has(id)) expandedDepositIds.delete(id); else expandedDepositIds.add(id);
  renderDepositList();
}

// 🆕 [明細改版] 成員名字＋「你」標記（目前登入者連結的成員）。
function ledgerWho(memberId){
  const me = myTripMember();
  return `${escapeHtml(memberName(memberId))}${me && me.id === memberId ? '<span class="you-tag">你</span>' : ''}`;
}

// 「應收 X／應付 X／打平」：正＝別人要給他，負＝他要給別人。who 是前綴（例如「你」），可留空。
function netPhraseHtml(net, currency, who){
  const prefix = who || '';
  if (Math.abs(net) < 0.005) return `<span class="amt-zero">${prefix}打平</span>`;
  const unit = currency ? ` ${currency}` : '';
  return `<span class="${net > 0 ? 'amt-pos' : 'amt-neg'}">${prefix}${net > 0 ? '應收' : '應付'} <span class="num">${fmtMoneyCompact(Math.abs(net))}${unit}</span></span>`;
}

// 這筆支出對「我」的影響（先付 − 分攤，換算成基準幣別）；我沒參與、或沒有連結成員時回傳空字串。
function ledgerMeHtml(e){
  const me = myTripMember();
  if (!me) return '';
  const paid = e.payers.filter(p=>p.userId===me.id).reduce((s,p)=>s+p.amount,0);
  const share = e.participants.filter(p=>p.userId===me.id).reduce((s,p)=>s+p.amount,0);
  if (!paid && !share) return '';
  const net = e.amount ? round2((paid - share) * e.amountInBase / e.amount) : 0;
  return `<span class="ledger-entry-me">${netPhraseHtml(net, trip.baseCurrency, '你')}</span>`;
}

// 金額欄：原幣金額；外幣另外顯示換算成基準幣別的金額（整數不顯示 .00，手機上才不會擠掉標題）
function ledgerAmountHtml(amount, currency, amountInBase){
  const base = currency !== trip.baseCurrency && typeof amountInBase === 'number'
    ? `<small>≈ ${fmtMoneyCompact(amountInBase)} ${trip.baseCurrency}</small>` : '';
  return `<span class="ledger-entry-amt"><b>${fmtMoneyCompact(amount)}<span class="cur">${currency}</span></b>${base}</span>`;
}

// 展開明細：一個小框，上方一句說明怎麼分，底下每位相關成員一行，右側是這筆的「應收／應付」
// （先付 − 分攤）。有先付錢的人，名字下方補一行「先付 X・分攤 Y」。直式清單只會往下長，窄螢幕也不會擠。
function renderExpenseSplit(e, evenShare){
  const ids = [...new Set([...e.payers.map(p=>p.userId), ...e.participants.map(p=>p.userId)])];
  const sum = (list, id) => list.filter(p=>p.userId===id).reduce((s,p)=>s+p.amount, 0);
  const caption = evenShare
    ? `${e.participants.length} 人平均分攤，每人 <b>${fmtMoneyCompact(e.participants[0].amount)} ${e.currency}</b>`
    : `依金額分攤（${e.currency}）`;
  const rows = ids.map(id=>{
    const paid = sum(e.payers, id), share = sum(e.participants, id);
    const note = paid ? `<small>先付 ${fmtMoneyCompact(paid)}・${share ? `分攤 ${fmtMoneyCompact(share)}` : '不分攤'}</small>` : '';
    return `<li><span class="split-name">${ledgerWho(id)}${note}</span><span class="split-net">${netPhraseHtml(round2(paid - share))}</span></li>`;
  }).join('');
  return `<div class="split-box"><div class="split-caption">${caption}</div><ul class="split-list">${rows}</ul></div>`;
}

// 單筆支出列：左邊三行「說明／誰付・幾人分・時間／你應收或應付多少」，右邊原幣與換算金額；
// 摘要單行、太長就截斷（窄螢幕上被截掉的是最不重要的時間）。
// 展開後才顯示每位成員的分攤清單與編輯/刪除按鈕，避免筆數一多畫面被撐開。
function renderExpenseRow(e){
  const expanded = expandedExpenseIds.has(e.id);
  // 多人代墊時只列第一位
  const firstPayer = e.payers[0] ? escapeHtml(memberName(e.payers[0].userId)) : '?';
  const payerText = e.payers.length > 1 ? `${firstPayer} 等 ${e.payers.length} 人付` : `${firstPayer} 付`;
  const allShare = e.participants.length === trip.members.length && trip.members.length > 1;
  const shareText = `${allShare ? '全員' : `${e.participants.length} 人`}分攤`;
  const evenShare = e.participants.length > 1 && e.participants.every(p=>Math.abs(p.amount - e.participants[0].amount) < 0.005);
  const detailHtml = expanded ? `
      <div class="ledger-entry-detail">
        ${renderExpenseSplit(e, evenShare)}
        <div class="ledger-actions" data-write-only>
          <button class="btn btn-ghost btn-sm" onclick="editExpense('${e.id}')">編輯</button>
          <button class="btn btn-danger btn-sm" onclick="deleteExpense('${e.id}')">刪除</button>
        </div>
      </div>` : '';
  return `
    <div class="ledger-entry ${expanded?'open':''}">
      <button type="button" class="ledger-entry-row" onclick="toggleExpenseExpand('${e.id}')" aria-expanded="${expanded}">
        <span class="ledger-entry-main">
          <span class="ledger-entry-title">${escapeHtml(e.description)}</span>
          <span class="ledger-entry-meta">${payerText}<span class="sep">·</span>${shareText}<span class="sep">·</span>${fmtTime(e.createdAt)}</span>
          ${ledgerMeHtml(e)}
        </span>
        ${ledgerAmountHtml(e.amount, e.currency, e.amountInBase)}
        <span class="ledger-entry-chev" aria-hidden="true">▼</span>
      </button>
      ${detailHtml}
    </div>`;
}

// 單筆轉帳列：收合時顯示「付款人 → 收款人」、備註與時間（無備註時顯示淡化的提示文字），
// 展開後才顯示編輯/刪除按鈕。
function renderDepositRow(d){
  const expanded = expandedDepositIds.has(d.id);
  const detailHtml = expanded ? `
      <div class="ledger-entry-detail">
        <div class="ledger-actions" data-write-only>
          <button class="btn btn-ghost btn-sm" onclick="editDeposit('${d.id}')">編輯</button>
          <button class="btn btn-danger btn-sm" onclick="deleteDeposit('${d.id}')">刪除</button>
        </div>
      </div>` : '';
  return `
    <div class="ledger-entry ${expanded?'open':''}">
      <button type="button" class="ledger-entry-row" onclick="toggleDepositExpand('${d.id}')" aria-expanded="${expanded}">
        <span class="ledger-entry-main">
          <span class="ledger-entry-title">${ledgerWho(d.payerId)}<span class="ledger-entry-arrow">→</span>${ledgerWho(d.collectorId)}</span>
          <span class="ledger-entry-meta">${d.note ? escapeHtml(d.note) : '<span class="muted">無備註</span>'}<span class="sep">·</span>${fmtTime(d.createdAt)}</span>
        </span>
        ${ledgerAmountHtml(d.amount, d.currency, d.amountInBase)}
        <span class="ledger-entry-chev" aria-hidden="true">▼</span>
      </button>
      ${detailHtml}
    </div>`;
}

// 🆕 把一組已排序好的帳目依日期分組渲染成 HTML：每組一個小標頭（左邊日期，右邊
// 「N 筆・小計」），底下是一個圓角區塊裝著該日期所有項目（用 rowRenderer 渲染單筆）。
function renderDateGroupedList(items, rowRenderer){
  const groups = groupItemsByDate(items);
  return groups.map(g=>`
    <div class="ledger-day">
      <div class="ledger-day-head">
        <span class="ledger-day-date">${escapeHtml(g.label)}</span>
        <span class="ledger-day-sum">${g.items.length} 筆・${fmtMoneyCompact(g.subtotal)} ${trip.baseCurrency}</span>
      </div>
      <div class="ledger-day-box">${g.items.map(rowRenderer).join('')}</div>
    </div>`).join('');
}


// 🆕 [篩選／搜尋] 成員篩選改為複選 chip：把成員清單畫成可各自切換的按鈕，
// 沿用帳單辨識既有的 .claim-chip 樣式（開/關兩態視覺語彙一致）。
// toggleFnName 是點擊時要呼叫的全域函式名稱字串（見下方
// toggleExpenseFilterMember/toggleDepositFilterMember）。
function renderFilterMemberChips(selectedIds, toggleFnName){
  if (!trip.members.length) return '';
  return trip.members.map(m=>{
    const on = selectedIds.has(m.id);
    return `<button type="button" class="claim-chip ${on?'on':''}" onclick="${toggleFnName}('${m.id}')">${escapeHtml(m.name)}</button>`;
  }).join('');
}

// 依目前的篩選條件（關鍵字＋複選成員）過濾支出／轉帳清單。
// 成員篩選為「符合任一位已勾選成員」即算命中（OR 邏輯），沒有勾選任何
// 成員時視為不篩選成員。支出的「成員」比對代墊人與分攤人；轉帳的「成員」
// 比對付款人與收款人。
function filterExpenses(list){
  const text = expenseFilterText.trim().toLowerCase();
  const ids = expenseFilterMemberIds;
  return list.filter(e=>{
    if (ids.size && !e.payers.some(p=>ids.has(p.userId)) && !e.participants.some(s=>ids.has(s.userId))) return false;
    if (text && !(e.description||'').toLowerCase().includes(text)) return false;
    return true;
  });
}
function filterDeposits(list){
  const text = depositFilterText.trim().toLowerCase();
  const ids = depositFilterMemberIds;
  return list.filter(d=>{
    if (ids.size && !ids.has(d.payerId) && !ids.has(d.collectorId)) return false;
    if (text && !(d.note||'').toLowerCase().includes(text)) return false;
    return true;
  });
}

// 篩選列輸入變動時呼叫：把 DOM 上的值同步回全域篩選狀態，再重繪整頁。
// 跟 toggleExpenseExpand() 等既有操作一樣直接 renderAll()，篩選文字輸入框
// 本身是 index.html 裡的靜態元素、不會被 renderAll() 的 innerHTML 覆寫，
// 所以重繪不會讓使用者正在打的字或游標位置跑掉。
function onExpenseFilterChange(){
  expenseFilterText = document.getElementById('expenseFilterText').value;
  renderExpenseList();
}
function onDepositFilterChange(){
  depositFilterText = document.getElementById('depositFilterText').value;
  renderDepositList();
}
// 🆕 成員 chip 點擊：切換該成員是否在篩選集合中，可同時勾選多位。
function toggleExpenseFilterMember(id){
  if (expenseFilterMemberIds.has(id)) expenseFilterMemberIds.delete(id); else expenseFilterMemberIds.add(id);
  renderExpenseList();
}
function toggleDepositFilterMember(id){
  if (depositFilterMemberIds.has(id)) depositFilterMemberIds.delete(id); else depositFilterMemberIds.add(id);
  renderDepositList();
}
function clearExpenseFilter(){
  expenseFilterText = ''; expenseFilterMemberIds.clear();
  document.getElementById('expenseFilterText').value = '';
  renderExpenseList();
}
function clearDepositFilter(){
  depositFilterText = ''; depositFilterMemberIds.clear();
  document.getElementById('depositFilterText').value = '';
  renderDepositList();
}
// 🆕 換行程（載入／匯入／清空重開／進入分享模式）時呼叫：清空篩選條件，
// 避免用舊行程篩出來的成員 id、關鍵字誤套用到新行程上。
function resetListFilters(){
  expenseFilterText = ''; expenseFilterMemberIds.clear();
  depositFilterText = ''; depositFilterMemberIds.clear();
  const et = document.getElementById('expenseFilterText'); if (et) et.value = '';
  const dt = document.getElementById('depositFilterText'); if (dt) dt.value = '';
}

// 支出清單（🆕 依日期分組＋預設收合明細＋篩選／搜尋）。篩選與展開／收合只影響這一區，
// 只重繪清單就好，不必整頁 renderAll()（打字搜尋時才不會卡）。
function renderExpenseList(){
  document.getElementById('expenseFilterMemberChips').innerHTML = renderFilterMemberChips(expenseFilterMemberIds, 'toggleExpenseFilterMember');
  const allExpenses = trip.expenses.slice().sort((a,b)=>b.createdAt-a.createdAt);
  const filteredExpenses = filterExpenses(allExpenses);
  const filterActive = !!(expenseFilterText.trim() || expenseFilterMemberIds.size);
  document.getElementById('expenseCount').textContent = `(${allExpenses.length})`;
  document.getElementById('expenseFilterClearBtn').style.display = filterActive ? '' : 'none';
  const expSummaryEl = document.getElementById('expenseFilterSummary');
  if (filterActive){
    const filteredSubtotal = round2(filteredExpenses.reduce((s,e)=>s+(typeof e.amountInBase==='number'?e.amountInBase:(e.amount||0)),0));
    expSummaryEl.style.display = '';
    expSummaryEl.textContent = `顯示 ${filteredExpenses.length} / ${allExpenses.length} 筆・小計 ${fmtMoney(filteredSubtotal, trip.baseCurrency)} ${trip.baseCurrency}`;
  } else {
    expSummaryEl.style.display = 'none';
  }
  document.getElementById('expenseList').innerHTML = filteredExpenses.length
    ? renderDateGroupedList(filteredExpenses, renderExpenseRow)
    : (allExpenses.length
        ? emptyState('🔍', '沒有符合篩選條件的支出', '清除篩選 →', "clearExpenseFilter()")
        : emptyState('🧾', '還沒有任何支出', '新增第一筆 →', "showMainTab('expenses'); setFormCardOpen('expenseFormCard', true); document.getElementById('expDesc').focus();"));
}
// 轉帳／預收清單，同上。
function renderDepositList(){
  document.getElementById('depositFilterMemberChips').innerHTML = renderFilterMemberChips(depositFilterMemberIds, 'toggleDepositFilterMember');
  const allDeposits = trip.deposits.slice().sort((a,b)=>b.createdAt-a.createdAt);
  const filteredDeposits = filterDeposits(allDeposits);
  const filterActive = !!(depositFilterText.trim() || depositFilterMemberIds.size);
  document.getElementById('depositCount').textContent = `(${allDeposits.length})`;
  document.getElementById('depositFilterClearBtn').style.display = filterActive ? '' : 'none';
  const depSummaryEl = document.getElementById('depositFilterSummary');
  if (filterActive){
    const filteredSubtotal = round2(filteredDeposits.reduce((s,d)=>s+(typeof d.amountInBase==='number'?d.amountInBase:(d.amount||0)),0));
    depSummaryEl.style.display = '';
    depSummaryEl.textContent = `顯示 ${filteredDeposits.length} / ${allDeposits.length} 筆・小計 ${fmtMoney(filteredSubtotal, trip.baseCurrency)} ${trip.baseCurrency}`;
  } else {
    depSummaryEl.style.display = 'none';
  }
  document.getElementById('depositList').innerHTML = filteredDeposits.length
    ? renderDateGroupedList(filteredDeposits, renderDepositRow)
    : (allDeposits.length
        ? emptyState('🔍', '沒有符合篩選條件的轉帳／預收紀錄', '清除篩選 →', "clearDepositFilter()")
        : emptyState('💸', '還沒有任何轉帳／預收紀錄', '新增第一筆 →', "showMainTab('deposits'); setFormCardOpen('depositFormCard', true); document.getElementById('depPayer').focus();"));
}

function renderAll(){
  // cover
  document.getElementById('tripName').value = trip.name;
  document.getElementById('baseCurrencyLabel').textContent = trip.baseCurrency;
  document.getElementById('baseLabel').textContent = trip.baseCurrency;

  // members tab
  document.getElementById('memberCount').textContent = `(${trip.members.length})`;
  document.getElementById('memberList').innerHTML = trip.members.map(m=>`
    <div class="member-tag">
      <span class="dot"></span>
      <input type="text" value="${escapeHtml(m.name)}" onchange="renameMember('${m.id}', this.value)">
      <span class="member-actions">
        ${memberLinkBadgeHtml(m)}
        <button class="btn btn-danger btn-sm member-btn" onclick="removeMember('${m.id}')" title="刪除這位成員" aria-label="刪除">${ICON_TRASH}<span class="btn-label">刪除</span></button>
      </span>
    </div>`).join('') || emptyState('👥', '尚未新增任何成員', '新增第一位成員 →', "document.getElementById('newMemberName').focus()");

  // rates tab
  document.getElementById('rateTableBody').innerHTML = Object.entries(trip.rates).sort().map(([code,rate])=>`
    <tr>
      <td data-label="幣別"><span><b>${code}</b>${code===trip.baseCurrency?' <span class="hint">（基準）</span>':''}</span></td>
      <td data-label="匯率"><input type="number" inputmode="decimal" step="0.0001" value="${rate}" ${code===trip.baseCurrency?'disabled':''} onchange="updateRate('${code}', this.value)"></td>
      <td data-label="">${code===trip.baseCurrency?'':`<button class="btn btn-danger btn-sm" onclick="removeRate('${code}')">刪除</button>`}</td>
    </tr>`).join('');

  // 換行程／匯入時會直接把 editingExpenseId 清成 null，這裡把表單的「編輯中」外觀一起還原
  if (!editingExpenseId && document.getElementById('expenseFormCard').classList.contains('editing')){
    document.getElementById('expenseFormTitle').textContent = '新增一筆支出';
    setFormCardEditing('expenseFormCard', 'btnSaveExpenseSync', 'btnResetExpense', false);
  }
  if (!editingDepositId && document.getElementById('depositFormCard').classList.contains('editing')){
    document.getElementById('depositFormTitle').textContent = '新增一筆轉帳／預收款';
    setFormCardEditing('depositFormCard', 'btnSaveDepositSync', 'btnResetDeposit', false);
  }

  // expense form selects
  const curSel = document.getElementById('expCurrency');
  const prevCur = curSel.value || trip.baseCurrency;
  curSel.innerHTML = currencyOptions(prevCur);
  if (!hasUnsavedExpenseFormContent()) { buildChips('payerChips','payer'); buildChips('participantChips','participant'); }
  renderExpenseHint();

  renderExpenseList();

  // deposit form selects
  renderDepositSelects();
  if (editingDepositId){
    const dep = trip.deposits.find(d=>d.id===editingDepositId);
    if (dep){
      document.getElementById('depPayer').value = dep.payerId;
      document.getElementById('depCollector').value = dep.collectorId;
      syncDepositPartyOptions();
      document.getElementById('depCurrency').innerHTML = currencyOptions(dep.currency);
    }
  }
  renderDepositList();

  // overview
  document.getElementById('kvExpenses').textContent = trip.expenses.length;
  document.getElementById('kvDeposits').textContent = trip.deposits.length;
  const totalBase = round2(trip.expenses.reduce((s,e)=>s+e.amountInBase,0));
  document.getElementById('kvTotal').textContent = fmtMoney(totalBase, trip.baseCurrency);
  document.getElementById('kvAvg').textContent = trip.members.length ? fmtMoney(round2(totalBase / trip.members.length), trip.baseCurrency) : '-';

  const net = calcNetBalances(trip);

  // --- 1. 橫向長條圖 ---
  renderBalanceBarChart(net);

  const allSettled = trip.members.length>0 && trip.members.every(m=>Math.abs(net[m.id]||0)<=0.01);
  const stamp = document.getElementById('stampBadge');
  stamp.textContent = allSettled ? '已結清' : '待結算';
  stamp.classList.toggle('settled', allSettled);

  // --- 2. 建議轉帳／彼此累計欠款總額（合併卡片，共用同一個換算幣別；
  //        清單本身永遠先用基準幣別算好，換算只發生在顯示那一層） ---
  lastTransferTx = simplifyDebts(net);
  lastPairwiseDebts = calcPairwiseDebts(trip);
  if (!debtDisplayCurrency) debtDisplayCurrency = trip.baseCurrency;
  renderDebtSectionUI();
  renderMyStatusCard(net);

  // --- 3. 每位成員多幣別逐筆明細 ---
  renderMemberDetails(net);


  // 🆕 [行程獨立化] 帳號／邀請／Discord 綁定區塊跟著目前的行程與身分更新
  renderAccountArea();
  renderInviteSection();
  if (currentSettingsSub === 'trip') renderDiscordPanel();
  if (typeof renderSyncStatus === 'function') renderSyncStatus();
}

