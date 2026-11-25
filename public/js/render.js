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
  updateDepositSteps();
}
// ctaAction：按鈕要呼叫的動作名稱（見 js/actions.js）
function emptyState(icon, text, ctaLabel, ctaAction){
  return `<div class="empty-state">
    <div class="ic">${icon}</div>
    <p>${escapeHtml(text)}</p>
    ${ctaLabel ? `<button class="btn btn-ghost btn-sm" ${act('click', ctaAction)}>${escapeHtml(ctaLabel)}</button>` : ''}
  </div>`;
}

// 展開／收合一筆明細：只動這一列，不重畫清單，展開才有動畫
function toggleLedgerRow(row){
  const { ledger: kind, id } = row.dataset;
  const set = kind === 'expenses' ? expandedExpenseIds : expandedDepositIds;
  const on = !set.has(id);
  if (on) set.add(id); else set.delete(id);
  const fold = row.closest('.swipe-in').querySelector('.fold');
  if (on){
    const x = trip[kind].find(e => e.id === id);
    if (x) fold.firstElementChild.innerHTML = ledgerDetailHtml(kind, x);
    void fold.offsetHeight; // 內容先排好，才會從 0 展開
  }
  fold.classList.toggle('on', on);
  row.setAttribute('aria-expanded', String(on));
}

// 成員名字；目前登入者只寫「你」
function ledgerWho(memberId){
  const me = myTripMember();
  return me && me.id === memberId ? '<span class="you-tag">你</span>' : `<span class="ledger-name">${escapeHtml(memberName(memberId))}</span>`;
}

// 淨額的說法（跨產品用詞）：應收／應付／已結清。數字不帶正負號，方向靠文字
function netWords(net){
  if (Math.abs(net) < 0.005) return '已結清';
  return net > 0 ? '應收' : '應付';
}
function netPhraseHtml(net){
  if (Math.abs(net) < 0.005) return '<span class="amt-zero">已結清</span>';
  return `<span class="${net > 0 ? 'amt-pos' : 'amt-neg'}">${netWords(net)} <span class="num">${fmtMoneyCompact(Math.abs(net))}</span></span>`;
}

// 這筆支出對「我」的影響（代墊 − 分攤），跟上一行同一個幣別。
// 我沒參與、沒有連結成員或是訪客時回傳空字串。
function ledgerMeHtml(e){
  const me = myTripMember();
  if (!me) return '';
  const paid = shareOf(e.payers, me.id), share = shareOf(e.participants, me.id);
  return paid || share ? netPhraseHtml(round2(paid - share)) : '';
}
function shareOf(list, id){ return round2(list.filter(p=>p.userId===id).reduce((s,p)=>s+p.amount, 0)); }

// 外幣換算成結算幣別
function ledgerBaseNote(x){
  return x.currency !== trip.baseCurrency && typeof x.amountInBase === 'number'
    ? `≈ ${fmtMoneyCompact(x.amountInBase)} ${trip.baseCurrency}` : '';
}

// 展開清單右側兩欄：「應收／應付」靠左、金額靠右，各列對齊
function splitNetHtml(net){
  if (Math.abs(net) < 0.005) return '<span class="ledger-net-zero">已結清</span>';
  const cls = net > 0 ? 'amt-pos' : 'amt-neg';
  return `<span class="${cls}">${netWords(net)}</span><span class="ledger-net-num ${cls}">${fmtMoneyCompact(Math.abs(net))}</span>`;
}

// 展開支出：怎麼分，然後每人一行。代墊的人排前面，名字下面列算式「代墊 X − 分攤 Y」
function expenseSplitHtml(e){
  const ids = [...new Set([...e.payers.map(p=>p.userId), ...e.participants.map(p=>p.userId)])];
  const even = e.participants.length > 1 && e.participants.every(p=>Math.abs(p.amount - e.participants[0].amount) < 0.05);
  const caption = even ? `${e.participants.length} 人均分 · 每人 ${fmtMoneyCompact(e.participants[0].amount)}` : '自訂分攤';
  const rows = ids.map(id => ({ id, paid: shareOf(e.payers, id), share: shareOf(e.participants, id) }))
    .sort((a, b) => (b.paid > 0) - (a.paid > 0))
    .map(({ id, paid, share }) => `<div class="ledger-split">
      <span class="ledger-split-who">${ledgerWho(id)}${paid ? `<span class="ledger-eq">代墊 ${fmtMoneyCompact(paid)} − 分攤 ${fmtMoneyCompact(share)}</span>` : ''}</span>
      ${splitNetHtml(round2(paid - share))}
    </div>`).join('');
  return `<div class="ledger-cap"><span>${caption}</span><span>${ledgerBaseNote(e)}</span></div><div class="ledger-splits">${rows}</div>`;
}

// 誰記的、誰改過：帳號（createdBy／updatedBy）換成行程裡的名字，自己寫「你」，訪客寫「訪客」；
// 看不出是誰（舊資料、沒連結帳號的人）回空字串
function authorName(account){
  if (!account) return '';
  if (account === 'guest') return '訪客';
  const m = (trip.members || []).find(x => x.discordId === account || x.lineId === account);
  if (!m) return '';
  const me = typeof myTripMember === 'function' ? myTripMember() : null;
  return me && me.id === m.id ? '你' : m.name;
}
// 「20:14 · 你新增 · 小明 修改」；看不出是誰（訪客看到的、舊資料）就只寫時間
function authorFacts(x){
  const by = (name, verb) => name ? `${escapeHtml(name)}${/[\x21-\x7e]$/.test(name) ? ' ' : ''}${verb}` : '';
  return [fmtTime(x.createdAt), by(authorName(x.createdBy), '新增'), x.updatedBy ? by(authorName(x.updatedBy), '修改') : '']
    .filter(Boolean).join(' · ');
}

// 沒有網路時不能改、刪舊帳目（新增的帳目送不出去會先存在手機，舊的改了卻沒地方放，見第 2 批 C2）
const offlineLock = () => (navigator.onLine === false ? 'disabled' : '');
const offlineNote = () => (navigator.onLine === false ? '<span class="ledger-offline-note">連上網路後才能修改</span>' : '');
// 網路狀態一變就重畫，按鈕跟著停用／恢復
window.addEventListener('online', () => { if (currentTripId) renderAll(); });
window.addEventListener('offline', () => { if (currentTripId) renderAll(); });

// 一列明細：兩行，左邊項目、右邊金額靠右；左滑出現「刪除」，點一下展開（swipeRows.js）
function ledgerRowHtml(kind, x, title, sub, me){
  const on = (kind === 'expenses' ? expandedExpenseIds : expandedDepositIds).has(x.id);
  return `<div class="swipe-box"><div class="swipe-in">
      <div class="ledger-top">
        <button type="button" class="swipe-act danger" data-write-only tabindex="-1" aria-hidden="true" ${act('click', kind === 'expenses' ? 'deleteExpense' : 'deleteDeposit', x.id, '$el')}><span>刪除</span></button>
        <div class="ledger-item swipe-row" role="button" tabindex="0" aria-expanded="${on}" data-ledger="${kind}" data-id="${escapeHtml(x.id)}">
          ${title}
          <span class="ledger-amount">${fmtMoneyCompact(x.amount)}<span class="cur">${x.currency}</span></span>
          ${sub || me ? `<span class="ledger-sub2">${sub}</span><span class="ledger-me">${me}</span>` : ''}
        </div>
      </div>
      <div class="fold ${on ? 'on' : ''}"><div>${on ? ledgerDetailHtml(kind, x) : ''}</div></div>
    </div></div>`;
}
function ledgerDetailHtml(kind, x){
  const expense = kind === 'expenses';
  const base = ledgerBaseNote(x);
  const body = expense ? expenseSplitHtml(x)
    : base ? `<div class="ledger-cap"><span></span><span>${base}</span></div>` : '';
  return `<div class="ledger-detail">${body}
    <div class="ledger-foot"><span>${authorFacts(x)}</span><span class="ledger-links" data-write-only>${offlineNote()}
      <button type="button" class="link-btn" ${act('click', expense ? 'editExpense' : 'editDeposit', x.id)} ${offlineLock()}>編輯</button>
      <button type="button" class="link-btn danger" ${act('click', expense ? 'deleteExpense' : 'deleteDeposit', x.id, '$el')} ${offlineLock()}>刪除</button>
    </span></div></div>`;
}
function renderExpenseRow(e){
  const me = myTripMember();
  const first = e.payers[0] ? e.payers[0].userId : null;
  const name = first ? memberName(first) : '';
  const payer = e.payers.length > 1 ? `${e.payers.length} 人代墊`
    : me && first === me.id ? '你代墊' : `${escapeHtml(name)} 代墊`;
  return ledgerRowHtml('expenses', e, `<span class="ledger-title2">${escapeHtml(e.description)}</span>`, payer, ledgerMeHtml(e));
}
function renderDepositRow(d){
  return ledgerRowHtml('deposits', d,
    `<span class="ledger-title2 ledger-pair">${ledgerWho(d.payerId)}<span class="ledger-arrow" aria-label="付給">→</span>${ledgerWho(d.collectorId)}</span>`,
    escapeHtml(d.note || ''), '');
}
// 一天一組：日期寫一次，右邊是當天合計（結算幣別）
function renderDateGroupedList(items, rowRenderer){
  return groupItemsByDate(items).map(g=>`
    <div class="ledger-group">
      <div class="ledger-group-head"><span>${escapeHtml(g.label)}</span><span>${fmtMoneyCompact(g.subtotal)} ${trip.baseCurrency}</span></div>
      ${g.items.map(rowRenderer).join('')}
    </div>`).join('');
}

// 搜尋與成員篩選平常收起來，標題右邊的按鈕展開；篩選中按鈕變成「清除」
const ledgerFindOpen = { expenses: false, deposits: false };
function ledgerFilterActive(kind){
  return kind === 'expenses' ? !!(expenseFilterText.trim() || expenseFilterMemberIds.size)
    : !!(depositFilterText.trim() || depositFilterMemberIds.size);
}
function toggleLedgerFind(kind){
  const exp = kind === 'expenses';
  if (ledgerFilterActive(kind)){
    ledgerFindOpen[kind] = false;
    return exp ? clearExpenseFilter() : clearDepositFilter();
  }
  ledgerFindOpen[kind] = !ledgerFindOpen[kind];
  if (exp) renderExpenseList(); else renderDepositList();
}
function renderLedgerHead(kind, all, shown){
  const p = kind === 'expenses' ? 'expense' : 'deposit';
  const active = ledgerFilterActive(kind);
  document.getElementById(p + 'Count').textContent = `${all.length} 筆`;
  const btn = document.getElementById(p + 'FindBtn');
  const open = ledgerFindOpen[kind] || active;
  btn.hidden = !all.length && !active;
  btn.textContent = active ? '清除' : open ? '收起' : '搜尋';
  btn.setAttribute('aria-expanded', String(open));
  document.getElementById(p + 'Find').classList.toggle('on', open);
  const sumEl = document.getElementById(p + 'FilterSummary');
  sumEl.hidden = !active;
  if (active){
    const total = round2(shown.reduce((s,x)=>s+(typeof x.amountInBase==='number'?x.amountInBase:(x.amount||0)),0));
    sumEl.textContent = `${shown.length} 筆 · ${fmtMoneyCompact(total)} ${trip.baseCurrency}`;
  }
}

// 🆕 [篩選／搜尋] 成員篩選改為複選 chip：把成員清單畫成可各自切換的按鈕，
// 沿用帳單辨識既有的 .claim-chip 樣式（開/關兩態視覺語彙一致）。
// toggleFnName 是點擊時要呼叫的全域函式名稱字串（見下方
// toggleExpenseFilterMember/toggleDepositFilterMember）。
function renderFilterMemberChips(selectedIds, toggleFnName){
  if (!trip.members.length) return '';
  return trip.members.map(m=>{
    const on = selectedIds.has(m.id);
    return `<button type="button" class="claim-chip ${on?'on':''}" ${act('click', toggleFnName, m.id)}>${escapeHtml(m.name)}</button>`;
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
// 只重畫清單，篩選文字輸入框
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
  ledgerFindOpen.expenses = ledgerFindOpen.deposits = false;
  expenseFilterText = ''; expenseFilterMemberIds.clear();
  depositFilterText = ''; depositFilterMemberIds.clear();
  const et = document.getElementById('expenseFilterText'); if (et) et.value = '';
  const dt = document.getElementById('depositFilterText'); if (dt) dt.value = '';
}

// 支出清單（🆕 依日期分組＋預設收合明細＋篩選／搜尋）。篩選與展開／收合只影響這一區，
// 只重繪清單就好，不必整頁 renderAll()（打字搜尋時才不會卡）。
function renderExpenseList(){
  document.getElementById('expenseFilterMemberChips').innerHTML = renderFilterMemberChips(expenseFilterMemberIds, 'toggleExpenseFilterMember');
  const all = trip.expenses.slice().sort((a,b)=>b.createdAt-a.createdAt);
  const shown = filterExpenses(all);
  renderLedgerHead('expenses', all, shown);
  document.getElementById('expenseList').innerHTML = shown.length
    ? renderDateGroupedList(shown, renderExpenseRow)
    : (all.length
        ? emptyState(icon('search'), '無符合項目', '清除', "clearExpenseFilter")
        : emptyState(icon('receipt'), '尚無支出', '記第一筆支出', "startFirstExpense"));
}
// 轉帳／預收清單，同上。
function renderDepositList(){
  document.getElementById('depositFilterMemberChips').innerHTML = renderFilterMemberChips(depositFilterMemberIds, 'toggleDepositFilterMember');
  const all = trip.deposits.slice().sort((a,b)=>b.createdAt-a.createdAt);
  const shown = filterDeposits(all);
  renderLedgerHead('deposits', all, shown);
  document.getElementById('depositList').innerHTML = shown.length
    ? renderDateGroupedList(shown, renderDepositRow)
    : (all.length
        ? emptyState(icon('search'), '無符合項目', '清除', "clearDepositFilter")
        : emptyState(icon('transfer'), '尚無轉帳', '記第一筆轉帳', "startFirstDeposit"));
}

function renderAll(){
  renderHistoryIfVisible(); // 「設定 → 紀錄」開著時，行程有更新就重新載入（js/history.js）
  renderArchivedState();
  // cover
  const titleEl = document.getElementById('tripName');
  titleEl.textContent = trip.name || '未開啟行程';
  titleEl.classList.toggle('is-empty', !trip.name);
  document.getElementById('baseLabel').textContent = trip.baseCurrency;

  // members tab
  if (currentSettingsSub === 'people' && document.body.dataset.tab === 'settings') loadMemberAvatars();
  document.getElementById('memberCount').textContent = `(${trip.members.length})`;
  document.getElementById('memberList').innerHTML = trip.members.map(m=>`
    <div class="member-tag">
      ${memberAvatarHtml(m)}
      <input type="text" value="${escapeHtml(m.name)}" ${act('change','renameMember',m.id,'$value')}>
      <span class="member-actions">
        ${memberLinkBadgeHtml(m)}
        <button class="btn btn-danger btn-sm member-btn" ${act('click','removeMember',m.id)} title="刪除這位成員" aria-label="刪除">${ICON_TRASH}<span class="btn-label">刪除</span></button>
      </span>
    </div>`).join('') || emptyState(icon('users'), '還沒有任何成員。', '新增成員', "focusNewMemberInput");

  // rates tab
  document.getElementById('rateTableBody').innerHTML = Object.entries(trip.rates).sort().map(([code,rate])=>`
    <tr>
      <td data-label="幣別"><span><b>${code}</b>${CURRENCY_BY_CODE[code]?` <span class="rate-cur-name">${escapeHtml(CURRENCY_BY_CODE[code].name)}</span>`:''}</span></td>
      <td data-label="匯率"><input type="number" inputmode="decimal" step="0.0001" value="${rate}" ${code===trip.baseCurrency?'disabled':''} ${act('change','updateRate',code,'$value')}></td>
      <td data-label="">${code===trip.baseCurrency?'':`<button class="btn btn-danger btn-sm" ${act('click','removeRate',code)}>刪除</button>`}</td>
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
  // 編輯中的轉帳只在 editDeposit 載入一次存檔值；這裡沿用畫面上目前的選擇，
  // 不再每次重繪都蓋回存檔值（否則使用者改到一半的付款人／幣別會被還原）
  renderDepositSelects();
  renderDepositList();

  // overview
  document.getElementById('kvExpenses').textContent = trip.expenses.length;
  document.getElementById('kvDeposits').textContent = trip.deposits.length;
  const totalBase = round2(trip.expenses.reduce((s,e)=>s+e.amountInBase,0));
  document.getElementById('kvTotal').textContent = fmtMoney(totalBase, trip.baseCurrency);
  document.querySelectorAll('.base-cur-name').forEach(el => { el.textContent = trip.baseCurrency; });
  document.getElementById('kvAvg').textContent = trip.members.length ? fmtMoney(round2(totalBase / trip.members.length), trip.baseCurrency) : '-';

  const net = calcNetBalances(trip);

  // --- 建議轉帳／彼此累計欠款總額（合併卡片，共用同一個換算幣別；
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

