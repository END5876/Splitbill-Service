'use strict';
// 成員與匯率設定分頁：新增/改名/刪除成員、新增/修改/刪除匯率。
/* ===================== avatars ===================== */
// 成員頭像：已連結而且登入過的成員用 LINE／Discord 的頭貼，其他人用名字第一個字
let memberAvatars = {};       // 成員 id → 網址（GET /api/trip/:tripId/avatars）
let memberAvatarsKey = '';    // 上次載入的是哪個行程、哪些連結
let memberAvatarsAt = 0;
const brokenAvatars = new Set(); // 載入失敗的網址（例如換過頭貼、舊網址失效）：退回字首
function memberAvatarHtml(m){
  if (!m) return '';
  const url = memberAvatars[m.id];
  if (url && !brokenAvatars.has(url)){
    return `<img class="mav" data-member="${escapeHtml(m.id)}" src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer">`;
  }
  const ch = (String(m.name || '').trim().match(/[\p{L}\p{N}]/u) || [''])[0].toUpperCase();
  return `<span class="mav" data-member="${escapeHtml(m.id)}" aria-hidden="true">${escapeHtml(ch)}</span>`;
}
// 只換頭像，不重畫整份名單（使用者可能正在改名字）
function refreshMemberAvatars(){
  document.querySelectorAll('#memberList .mav').forEach(el => {
    const m = trip.members.find(x => x.id === el.dataset.member);
    if (m) el.outerHTML = memberAvatarHtml(m);
  });
}
async function loadMemberAvatars(){
  if (!currentTripId || shareMode || !currentUser) return;
  const key = currentTripId + '|' + trip.members.map(m => `${m.id}:${memberAccountId(m) || ''}`).join(',');
  // 同一份名單五分鐘內不重複問（別人剛登入換了頭貼，過一會就會更新）
  if (key === memberAvatarsKey && Date.now() - memberAvatarsAt < 5 * 60 * 1000) return;
  // 換行程或有人換了連結：先清掉，不要讓舊頭像留在別人名字旁邊
  if (key !== memberAvatarsKey) memberAvatars = {};
  memberAvatarsKey = key; memberAvatarsAt = Date.now();
  try{
    const body = await apiJson(await fetch(tripApiUrl('/avatars'), { credentials: 'same-origin' }));
    if (memberAvatarsKey !== key) return; // 等待期間又換了行程
    memberAvatars = body.avatars || {};
    refreshMemberAvatars();
  }catch(e){ if (memberAvatarsKey === key) memberAvatarsAt = 0; /* 拿不到就先用字首，下次重畫再試 */ }
}
// 圖片的 error 事件不會往上傳，用 capture 接（CSP 不允許 inline onerror）
document.addEventListener('error', ev => {
  const el = ev.target;
  if (!(el instanceof HTMLImageElement) || !el.classList.contains('mav')) return;
  brokenAvatars.add(el.getAttribute('src'));
  refreshMemberAvatars();
}, true);

/* ===================== members ===================== */
function addMember(){
  const input = document.getElementById('newMemberName');
  const name = input.value.trim();
  if (!name){ toast('請輸入成員名稱', 'error'); return; }
  trip.members.push({ id: genId('mem'), name });
  input.value = '';
  toast(`已新增成員「${name}」`, 'success');
  renderAll();
  scheduleCloudSave();
}
function renameMember(id, value){
  const m = trip.members.find(x=>x.id===id);
  if (m){ m.name = value; scheduleCloudSave(); }
}
async function removeMember(id){
  let idx = trip.members.findIndex(x=>x.id===id);
  if (idx === -1) return;
  // 🔒 已連結 Discord 的成員只有建立者能移除（本人可以移除自己）；伺服器也會擋，
  // 這裡先擋下來，免得畫面上刪掉、存檔後又被伺服器補回來
  const target = trip.members[idx];
  if (isMemberLinked(target) && (currentTripId || shareMode)){
    const isSelf = isMyMember(target);
    if (shareMode || (!isSelf && !canManageTrip())){
      toast(`「${target.name}」已經連結帳號，只有行程建立者可以移除`, 'error');
      return;
    }
  }
  // 🆕 已連結 Discord 的成員被刪除後，他就失去這個行程的存取權；先確認一次
  if (memberAccountId(trip.members[idx]) && currentTripId){
    const isMe = isMyMember(trip.members[idx]);
    const ok = await confirmModal(
      isMe
        ? '這是你自己。刪除後，你就看不到這個行程了（除非你是建立者）。'
        : '他已經連結帳號，刪除後他就看不到這個行程了。',
      { title: `刪除成員「${trip.members[idx].name}」？`, confirmText:'刪除成員', cancelText:'取消', danger:true }
    );
    if (!ok) return;
    // 確認視窗開著時 trip 可能被 SSE／存檔換掉，要用 id 重新找位置
    idx = trip.members.findIndex(x=>x.id===id);
    if (idx === -1) return;
  }
  // 有帳目的成員：刪掉後他的金額不會算進結算，其他人的要付／可拿回會跟著變，先講清楚再刪
  const nExp = trip.expenses.filter(e=>e.payers.some(p=>p.userId===id)||e.participants.some(s=>s.userId===id)).length;
  const nDep = trip.deposits.filter(d=>d.payerId===id||d.collectorId===id).length;
  if (nExp || nDep){
    const name = trip.members[idx].name;
    const where = [nExp ? `${nExp} 筆支出` : '', nDep ? `${nDep} 筆轉帳` : ''].filter(Boolean).join('、');
    const ok = await confirmModal(
      `${name}在 ${where}裡。刪除後這些金額不會算進結算，其他人的應付、應收金額會跟著改變。`,
      { title: `刪除成員「${name}」？`, confirmText:'仍要刪除', cancelText:'先查看他的帳目', danger:true }
    );
    if (!ok){
      // 「先查看他的帳目」：有支出就到支出頁，只有轉帳就到轉帳頁，只列出有他的那些
      const tab = nExp ? 'expenses' : 'deposits';
      const input = document.getElementById(nExp ? 'expenseFilterText' : 'depositFilterText');
      if (input) input.value = '';
      if (nExp){ expenseFilterText = ''; expenseFilterMemberIds = new Set([id]); }
      else { depositFilterText = ''; depositFilterMemberIds = new Set([id]); }
      showMainTab(tab);
      return;
    }
    idx = trip.members.findIndex(x=>x.id===id);
    if (idx === -1) return;
  }
  const [removed] = trip.members.splice(idx,1);
  renderAll();
  scheduleCloudSave();
  toastUndo(
    `已刪除成員「${removed.name}」`,
    ()=>{ trip.members.splice(idx,0,removed); renderAll(); scheduleCloudSave(); }
  );
}

/* ===================== rates ===================== */
function addRate(){
  const codeInput = document.getElementById('newRateCurrency');
  const valInput = document.getElementById('newRateValue');
  // 幣別從搜尋選單選取（js/currencyPicker.js）；也接受直接打代碼或完整的貨幣名稱
  const code = resolveTypedCurrency(codeInput);
  const val = parseFloat(valInput.value);
  if (!codeInput.value.trim()){ toast('請先選擇幣別。', 'error'); codeInput.focus(); return; }
  // 跟伺服器的格式一致（lib/validate.js），不合格的代碼存檔時會被伺服器丟掉
  if (!code){
    const n = codeInput.value.trim() ? searchCurrencies(codeInput.value.trim()).length : 0;
    toast(n > 1 ? `有 ${n} 種貨幣符合「${codeInput.value.trim()}」，請從清單選一個。`
      : `找不到「${codeInput.value.trim()}」這個幣別。請從清單選一個，或輸入貨幣代碼（例如 JPY）。`, 'error');
    codeInput.focus(); return;
  }
  if (code === trip.baseCurrency){ toast(`${code} 是這個行程結算用的幣別，不用另外設定匯率。`, 'error'); return; }
  if (!(val>0)){ toast('匯率要大於 0。', 'error'); valInput.focus(); return; }
  const existed = trip.rates[code] != null;
  trip.rates[code] = val;
  valInput.value='';
  resetCurrencyPicker();
  toast(`${existed ? '已更新' : '已新增'} ${currencyLabel(code)} 的匯率：1 ${code} ＝ ${val} ${trip.baseCurrency}`, 'success');
  renderAll();
  scheduleCloudSave();
}
function updateRate(code, value){
  const v = parseFloat(value);
  if (v>0) trip.rates[code] = v;
  renderAll();
  if (v>0) scheduleCloudSave();
}
function removeRate(code){
  if (code === trip.baseCurrency){ toast('這是行程結算用的幣別，不能刪除。', 'error'); return; }
  const usedValue = trip.rates[code];
  const used = trip.expenses.some(e=>e.currency===code) || trip.deposits.some(d=>d.currency===code);
  delete trip.rates[code];
  renderAll();
  scheduleCloudSave();
  toastUndo(
    used ? `已刪除 ${code} 匯率（有支出／轉帳正在使用這個幣別）` : `已刪除 ${code} 匯率`,
    ()=>{ trip.rates[code] = usedValue; renderAll(); scheduleCloudSave(); }
  );
}

