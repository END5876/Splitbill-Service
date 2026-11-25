'use strict';
// 總覽頁：建議轉帳／彼此累計欠款的幣別換算與渲染、淨額長條圖、成員逐筆明細。
/* =====================================================================
   🆕 Overview: 「建議轉帳」與「彼此累計欠款總額」合併成同一張卡片
   ---------------------------------------------------------------------
   兩種檢視共用一張卡片、一個幣別換算下拉選單：
   - debtViewMode 決定目前顯示哪一份清單，預設 'transfer'（建議轉帳），
     由卡片標題列的分段按鈕（.seg-tab）切換，不再各自佔一張卡。
   - debtDisplayCurrency 是兩種檢視共用的顯示幣別，切換檢視模式不會重置
     使用者選好的幣別；换算邏輯（resolveDisplayRate）跟換算前一致。
   - 清單本身（simplifyDebts / calcPairwiseDebts 的計算結果）永遠是用
     「基準幣別」算出來的金額，換算只發生在顯示這一層，不影響背後的
     淨額計算邏輯。
===================================================================== */
let debtViewMode = 'transfer';        // 'transfer'＝建議轉帳（預設）｜'pairwise'＝彼此累計欠款總額
let debtDisplayCurrency = null;       // 目前選擇的顯示幣別；預設為 trip.baseCurrency
let lastTransferTx = [];              // 每次 renderAll() 都會依基準幣別重新計算一次
let lastPairwiseDebts = [];

// 🔒 換了一整個行程（匯入 JSON／從 Bot 載入／清空重開）時，上一個行程選過的
// 顯示幣別與檢視模式對新行程來說可能沒有意義，這裡重置回「跟著新行程的
// 基準幣別」，並且一律從「建議轉帳」開始看，避免畫面停在上一個行程切過去
// 的「彼此累計欠款」造成混淆。
function resetOverviewSectionCurrencyState(){
  debtViewMode = 'transfer';
  debtDisplayCurrency = null;
}

function onDebtViewChange(value){
  debtViewMode = value === 'pairwise' ? 'pairwise' : 'transfer';
  renderDebtSectionUI();
}
function onDebtCurrencyChange(value){
  debtDisplayCurrency = value;
  renderDebtSectionUI();
}

/**
 * 把「基準幣別」的金額換算成目標幣別的匯率倍數：
 *   converted = baseAmount * rate
 * 優先用即時匯率（fetchLiveRate 內部本身有短時間快取），抓不到才退回
 * 行程裡手動設定的匯率；兩者都沒有就回傳 null，由呼叫端自行決定怎麼顯示。
 */
async function resolveDisplayRate(targetCurrency){
  if (targetCurrency === trip.baseCurrency) return 1;
  const live = await fetchLiveRate(trip.baseCurrency, targetCurrency);
  if (live && typeof live.rate === 'number' && live.rate > 0) return live.rate;
  const fallbackRate = trip.rates[targetCurrency]; // 1 target = fallbackRate 基準幣
  if (fallbackRate > 0) return 1 / fallbackRate;
  return null;
}

async function renderDebtSectionUI(){
  const listEl = document.getElementById('debtSettleList');
  const selectEl = document.getElementById('debtCurrencySelect');
  const noteEl = document.getElementById('debtRateNote');
  const subtitleEl = document.getElementById('debtViewSubtitle');
  if (!listEl) return;

  document.querySelectorAll('.seg-tab[data-view]').forEach(b=>b.setAttribute('aria-selected', b.dataset.view === debtViewMode ? 'true' : 'false'));

  const isTransfer = debtViewMode !== 'pairwise';
  const sourceList = isTransfer ? lastTransferTx : lastPairwiseDebts;
  const emptyMsg = isTransfer ? '無需轉帳' : '無欠款';
  if (subtitleEl){
    subtitleEl.textContent = isTransfer
      ? '最少轉帳次數'
      : '兩人之間互欠';
  }

  const wantedCurrency = debtDisplayCurrency || trip.baseCurrency;
  if (selectEl) selectEl.innerHTML = currencyOptions(wantedCurrency);

  // effectiveCurrency 代表 displayList 裡的金額「實際上」是用哪個幣別算出來的，
  // 換算失敗時 displayList 會維持基準幣別金額，這裡也要跟著退回基準幣別，
  // 否則畫面會出現「金額還是基準幣別的數字，卻標成使用者選的那個幣別代碼」的錯誤標示。
  let displayList = sourceList;
  let effectiveCurrency = trip.baseCurrency;
  let rateNote = '';
  if (wantedCurrency !== trip.baseCurrency){
    const rate = await resolveDisplayRate(wantedCurrency);
    if (rate){
      displayList = sourceList.map(t => ({ ...t, amount: round2(t.amount * rate) }));
      effectiveCurrency = wantedCurrency;
      rateNote = `依匯率 1 ${trip.baseCurrency} ≈ ${round2(rate)} ${wantedCurrency} 換算，僅供參考。`;
    } else {
      rateNote = `無法取得 ${wantedCurrency} 匯率，暫時仍以 ${trip.baseCurrency} 顯示。`;
    }
  }
  if (noteEl) noteEl.textContent = rateNote;

  listEl.innerHTML = sourceList.length
    ? settleGroupsHtml(displayList, effectiveCurrency, isTransfer)
    : `<p class="empty-state" style="padding:16px;">${emptyMsg}</p>${archiveOfferHtml(isTransfer)}`;
  swipeRowPeek();
}

/* =====================================================================
   「標記已付款」：建議轉帳的每一列都可以一鍵記成一筆轉帳紀錄，
   讓「看結算 → 實際轉錢 → 回來記帳」在同一個地方完成。
   金額一律用基準幣別（清單計算本來就是基準幣別），不受換算幣別影響。
===================================================================== */
// 依付款人分組：付款人寫一次（兩筆以上加合計），下面每列「付給誰｜金額」。
function settleGroupsHtml(list, currency, canMark){
  const groups = new Map();
  for (const t of list){
    if (!groups.has(t.from)) groups.set(t.from, []);
    groups.get(t.from).push(t);
  }
  return [...groups].map(([from, rows]) => `<div class="settle-box">
      <div class="settle-group-head">
        <span class="settle-party">${settleNameHtml(from)}</span>
        ${rows.length > 1 ? `<span class="settle-sum">應付 <span class="num">${fmtMoneyCompact(round2(rows.reduce((s, t) => s + t.amount, 0)))}</span> ${currency}</span>` : ''}
      </div>
      ${rows.map(t => settleRowHtml(t, `<span class="settle-verb lead">應付</span>${settleNameHtml(t.to)}`, t.amount, currency, canMark)).join('')}
    </div>`).join('');
}
// 名字太長時只截名字本身；自己只寫「你」
function settleNameHtml(memberId){
  const me = typeof myTripMember === 'function' ? myTripMember() : null;
  return me && me.id === memberId ? '<span class="you-tag">你</span>'
    : `<span class="settle-name">${escapeHtml(memberName(memberId))}</span>`;
}
// 建議轉帳：左滑（或點一下）露出「標記已付」，見 swipeRows.js；唯讀時只能看
function settleRowHtml(t, whoHtml, amount, currency, canMark){
  const inner = `<span class="settle-party">${whoHtml}</span><span class="settle-amt">${fmtMoneyCompact(amount)}<span class="settle-amt-cur">${currency}</span></span>`;
  if (!canMark) return `<div class="settle-item">${inner}</div>`;
  return `<div class="swipe-box"><div class="swipe-in">
      <button type="button" class="swipe-act" data-write-only tabindex="-1" aria-hidden="true" ${act('click','markTransferPaid',t.from,t.to,'$el')}><span>標記已付</span></button>
      <div class="settle-item swipe-row" role="button" tabindex="0" aria-expanded="false">${inner}</div>
    </div></div>`;
}
let markingPaid = false;
async function markTransferPaid(fromId, toId, el){
  if (markingPaid || document.body.matches('.share-readonly, .trip-archived')) return; // 只能看
  const t = lastTransferTx.find(x => x.from === fromId && x.to === toId);
  if (!t) return;
  const amount = round2(t.amount);
  const base = trip.baseCurrency;
  const tripId = trip.id;
  markingPaid = true;
  try{
    const ok = await confirmModal('會新增一筆轉帳，結算結果也會更新。', {
      title: `標記 ${memberName(fromId)} 已付給 ${memberName(toId)} ${fmtMoney(amount, base)} ${base}？`,
      confirmText: '標記已付', cancelText: '取消',
    });
    if (!ok){ closeSwipeRow(); return; }
    await swipeRowOut(el);
  } finally { markingPaid = false; }
  // 確認、動畫期間換了行程，或別人剛好改了帳：不要記錯
  const now = trip.id === tripId && lastTransferTx.find(x => x.from === fromId && x.to === toId);
  if (!now || round2(now.amount) !== amount){
    renderAll();
    toast('帳目剛剛有更新，請確認金額後再標記。', 'error');
    return;
  }
  const dep = {
    id: genId('dep'), payerId: fromId, collectorId: toId,
    amount, currency: base, amountInBase: amount, note: '結算轉帳', createdAt: Date.now()
  };
  trip.deposits.push(dep);
  renderAll();
  const saved = (currentTripId || shareMode) ? syncEntry('deposits', dep.id, dep) : Promise.resolve();
  toastUndo(`已標記：${memberName(fromId)} → ${memberName(toId)} ${fmtMoney(amount, base)} ${base}`, async () => {
    await saved; // 等新增存完再刪，順序不會顛倒
    if (trip.id !== tripId) return;
    const i = trip.deposits.findIndex(d => d.id === dep.id);
    if (i === -1) return;
    trip.deposits.splice(i, 1);
    renderAll();
    if (currentTripId || shareMode) await syncEntry('deposits', dep.id, null);
  });
  await saved;
}

/* =====================================================================
   「你的狀態」：登入且是這個行程的成員時，總覽最上方直接告訴你
   「你要付誰多少／誰要付你多少」，不用自己在長條圖跟清單裡找自己。
===================================================================== */
// 大家都結清了：建立者可以封存這個行程（Discord 的行程選單就不會再列出來）
function archiveOfferHtml(isTransfer){
  if (!isTransfer || trip.archived || !trip.expenses.length || !canManageCurrentTrip()) return '';
  return `<div class="archive-offer" data-write-only>
    <span>已全部結清，可封存行程。</span>
    <button type="button" class="btn btn-ghost btn-sm" data-click="archiveCurrentTrip">封存這個行程</button>
  </div>`;
}

function renderMyStatusCard(net){
  const el = document.getElementById('myStatusCard');
  if (!el) return;
  const me = typeof myTripMember === 'function' ? myTripMember() : null;
  if (!me || !trip.expenses.length){ el.style.display = 'none'; el.innerHTML = ''; return; }
  const base = trip.baseCurrency;
  const v = round2(net[me.id] || 0);
  const mine = lastTransferTx.filter(t => t.from === me.id || t.to === me.id);
  // 右上角蓋一個狀態章（待付款／待收款／已結清）
  const state = v < -0.01 ? 'neg' : v > 0.01 ? 'pos' : 'zero';
  const stamp = { neg: '待付款', pos: '待收款', zero: '已結清' }[state];
  const headline = state === 'neg' ? `應付 <b>${fmtMoneyCompact(-v)}</b> ${base}`
    : state === 'pos' ? `應收 <b>${fmtMoneyCompact(v)}</b> ${base}`
    : '已結清';
  const rows = mine.map(t => {
    const paying = t.from === me.id;
    const name = `<span class="settle-name">${escapeHtml(memberName(paying ? t.to : t.from))}</span>`;
    const who = paying ? `${settleNameHtml(me.id)}<span class="settle-verb">應付</span>${name}` : `${name}<span class="settle-verb">應付</span>${settleNameHtml(me.id)}`;
    return settleRowHtml(t, who, t.amount, base, true);
  }).join('');
  el.innerHTML = `
    <div class="receipt-head my-status-head">
      <div class="my-status-main">
        <div class="my-status-who">${escapeHtml(me.name)}</div>
        <div class="t1 my-status-headline ${state === 'zero' ? '' : state}">${headline}</div>
      </div>
      <div class="stamp my-status-stamp ${state}">${stamp}</div>
    </div>
    ${rows ? `<div class="settle-list"><div class="settle-box">${rows}</div></div>` : ''}`;
  el.style.display = '';
}

/* =====================================================================
   Overview: 每位成員多幣別逐筆明細
   修正紀錄：
   1. transferIn / transferOut 的 amtSign 原本與 summaryRows 矛盾，
      導致「已轉帳結清」的人淨額不減反增，形同債務加倍計算。
      現已對調為：transferIn = -1（減少淨額），transferOut = +1（增加淨額）。
      對應的 .detail-tag.transfer-in / .transfer-out 顏色（style.css）
      原本也跟這個方向相反，一併對調修正。
   2. 明細文字「收自／付給」原本會在 tagLabel 標籤上顯示一次、又在
      desc 裡重複組一次（例如「〔收自〕收自 小明」），且 desc 還被
      雙重 escapeHtml() 導致名字含特殊字元時顯示亂碼。現改成 desc
      只放名字本身（item.counterpart），方向完全交給 tagLabel 顯示，
      不再需要額外的 isIncoming 參數。
   3. 移除未被呼叫的死代碼 fmtOrigAndBase()。
===================================================================== */
function renderMemberDetails(net) {
  const el = document.getElementById('memberDetailList');
  if (!el) return;
  if (!trip.members.length) {
    el.innerHTML = '<p class="hint" style="padding:14px 0 6px;">尚無成員</p>';
    return;
  }

  // 計算每位成員的多幣別收支明細
  // 結構：{ memberId: { paid:[{exp,amount,amountInBase}], share:[...], transferIn:[...], transferOut:[...] } }
  function buildMemberLedger() {
    const ledger = {};
    for (const m of trip.members) {
      ledger[m.id] = { paid: [], share: [], transferIn: [], transferOut: [] };
    }
    for (const exp of trip.expenses) {
      // 代墊／分攤本位幣值均使用與淨額計算相同的尾差分配結果。
      for (const p of allocateExpenseBaseAmounts(exp.payers, exp)) {
        if (ledger[p.userId]) {
          ledger[p.userId].paid.push({
            description: exp.description,
            amount: p.amount,
            currency: exp.currency,
            amountInBase: p.amountInBase,
            createdAt: exp.createdAt,
          });
        }
      }
      for (const s of allocateExpenseBaseAmounts(exp.participants, exp)) {
        if (ledger[s.userId]) {
          ledger[s.userId].share.push({
            description: exp.description,
            amount: s.amount,
            currency: exp.currency,
            amountInBase: s.amountInBase,
            createdAt: exp.createdAt,
          });
        }
      }
    }
    for (const d of trip.deposits) {
      // 付款人：付出去（轉帳給收款人）→ 應記錄為轉帳支出 (transferOut)
      if (ledger[d.payerId]) {
        ledger[d.payerId].transferOut.push({
          counterpart: memberName(d.collectorId),
          amount: d.amount,
          currency: d.currency,
          amountInBase: d.amountInBase,
          note: d.note,
          createdAt: d.createdAt,
        });
      }
      // 收款人：收到預付款 → 應記錄為轉帳收入 (transferIn)
      if (ledger[d.collectorId]) {
        ledger[d.collectorId].transferIn.push({
          counterpart: memberName(d.payerId),
          amount: d.amount,
          currency: d.currency,
          amountInBase: d.amountInBase,
          note: d.note,
          createdAt: d.createdAt,
        });
      }
    }
    return ledger;
  }

  // amtSign：僅代表「對淨額的影響方向」（+1 增加淨額 / -1 減少淨額）
  // isIncoming：僅代表「文字顯示為收自 / 付給」，兩者互相獨立，不再耦合
  function renderSection(title, items, tagClass, tagLabel, amtSign) {
    if (!items.length) return '';
    const rows = items.map(item => {
      const desc = item.description || item.counterpart || '';
      const timeLabel = `<span class="ledger-time">${fmtDateTime(item.createdAt)}</span>`;
      const noteLabel = item.note ? `備註：${escapeHtml(item.note)}` : '';
      const sub = noteLabel ? `${timeLabel}<br>${noteLabel}` : timeLabel;
      return `<div class="detail-row">
        <div class="detail-row-left">
          <div class="detail-row-desc">
            <span class="detail-tag ${tagClass}">${tagLabel}</span>${escapeHtml(desc)}
          </div>
          <div class="detail-row-sub">${sub}</div>
        </div>
        <div class="detail-row-amt">
          <div class="orig">${amtSign > 0 ? '+' : '−'}${fmtMoney(item.amount, item.currency)} ${item.currency}</div>
          ${item.currency !== trip.baseCurrency
            ? `<div class="base">≈ ${amtSign > 0 ? '+' : '−'}${fmtMoney(item.amountInBase, trip.baseCurrency)} ${trip.baseCurrency}</div>`
            : ''}
        </div>
      </div>`;
    }).join('');
    return `<div class="detail-section-title">${title}</div>${rows}`;
  }

  const ledger = buildMemberLedger();

  el.innerHTML = trip.members.map(m => {
    const v = round2(net[m.id] || 0);
    const netCls = v > 0.01 ? 'pos' : (v < -0.01 ? 'neg' : 'zero');
    const netLabel = Math.abs(v) <= 0.01 ? '已結清' : `${netWords(v)} ${fmtMoney(Math.abs(v), trip.baseCurrency)} ${trip.baseCurrency}`;
    const ld = ledger[m.id];
    const hasData = ld.paid.length || ld.share.length || ld.transferIn.length || ld.transferOut.length;

    // ↓↓↓ 修正處：transferIn 改為 -1（收到預付款＝減少淨額，因為原本墊款義務已被抵銷）
    //             transferOut 改為 +1（付出預付款＝增加淨額，等同預先幫忙代墊）
    // 分類標題用白話描述「這筆錢是怎麼來的」；＋／－ 對淨額的影響已經直接標在每筆金額上
    const paidSection   = renderSection('代墊', ld.paid, 'paid', '代墊', 1);
    const shareSection  = renderSection('分攤', ld.share, 'share', '分攤', -1);
    const tInSection    = renderSection('收款', ld.transferIn, 'transfer-in', '收自', -1);
    const tOutSection   = renderSection('付款', ld.transferOut, 'transfer-out', '付給', 1);

    const totalPaid  = round2(ld.paid.reduce((s,x)=>s+x.amountInBase,0));
    const totalShare = round2(ld.share.reduce((s,x)=>s+x.amountInBase,0));
    const totalTIn   = round2(ld.transferIn.reduce((s,x)=>s+x.amountInBase,0));
    const totalTOut  = round2(ld.transferOut.reduce((s,x)=>s+x.amountInBase,0));

    const summaryRows = [
      totalPaid  ? `<div class="detail-summary-row"><span class="label">代墊合計</span><span class="val pos">+${fmtMoney(totalPaid, trip.baseCurrency)} ${trip.baseCurrency}</span></div>` : '',
      totalShare ? `<div class="detail-summary-row"><span class="label">分攤合計</span><span class="val neg">−${fmtMoney(totalShare, trip.baseCurrency)} ${trip.baseCurrency}</span></div>` : '',
      totalTIn   ? `<div class="detail-summary-row"><span class="label">收款合計</span><span class="val neg">−${fmtMoney(totalTIn, trip.baseCurrency)} ${trip.baseCurrency}</span></div>` : '',
      totalTOut  ? `<div class="detail-summary-row"><span class="label">付款合計</span><span class="val pos">+${fmtMoney(totalTOut, trip.baseCurrency)} ${trip.baseCurrency}</span></div>` : '',
    ].filter(Boolean).join('');

    const bodyHtml = hasData
      ? `${paidSection}${shareSection}${tInSection}${tOutSection}
         <div style="border-top:1.5px solid var(--card-line);margin-top:8px;padding-top:4px;">
           ${summaryRows}
           <div class="detail-summary-row" style="border-top:1px dashed var(--card-line);margin-top:4px;padding-top:8px;">
             <span class="label" style="font-weight:700;">${Math.abs(v) <= 0.01 ? '已結清' : netWords(v)}</span>
             <span class="val ${netCls}" style="font-size:14px;">${Math.abs(v) > 0.01 ? `${fmtMoney(Math.abs(v), trip.baseCurrency)} ${trip.baseCurrency}` : ''}</span>
           </div>
         </div>`
      : '<p class="hint" style="padding:8px 0 4px;">尚無帳目</p>';

    const isOpen = openMemberDetailIds.has(m.id);
    return `<div class="member-detail-card ${isOpen ? 'open' : ''}" id="mdc-${m.id}">
      <button type="button" class="member-detail-head" aria-expanded="${isOpen}" aria-controls="mdb-${m.id}" ${act('click','toggleMemberDetail',m.id)}>
        <div class="member-detail-name">
          <span class="member-detail-name-text">${escapeHtml(m.name)}</span>
        </div>
        <div class="member-detail-right">
          <span class="member-detail-net ${netCls}">${netLabel}</span>
          <span class="member-detail-chevron" aria-hidden="true">▼</span>
        </div>
      </button>
      <div class="member-detail-body" id="mdb-${m.id}">${bodyHtml}</div>
    </div>`;
  }).join('');
}

// 記住哪些成員明細是展開的：renderAll() 會整個重畫這一區（例如別人同步了新資料），
// 不記住的話，使用者正在看的明細會突然收起來。
const openMemberDetailIds = new Set();
function toggleMemberDetail(memberId) {
  const card = document.getElementById('mdc-' + memberId);
  if (!card) return;
  const open = card.classList.toggle('open');
  if (open) openMemberDetailIds.add(memberId); else openMemberDetailIds.delete(memberId);
  card.querySelector('.member-detail-head').setAttribute('aria-expanded', open ? 'true' : 'false');
}

