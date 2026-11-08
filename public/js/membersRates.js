'use strict';
// 成員與匯率設定分頁：新增/改名/刪除成員、新增/修改/刪除匯率。
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
  const used = trip.expenses.some(e=>e.payers.some(p=>p.userId===id)||e.participants.some(s=>s.userId===id))
            || trip.deposits.some(d=>d.payerId===id||d.collectorId===id);
  const [removed] = trip.members.splice(idx,1);
  renderAll();
  scheduleCloudSave();
  toastUndo(
    used ? `已刪除成員「${removed.name}」（他仍出現在部分支出／轉帳紀錄中）` : `已刪除成員「${removed.name}」`,
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
  if (!codeInput.value.trim()){ toast('請先選擇幣別', 'error'); codeInput.focus(); return; }
  // 跟伺服器的格式一致（lib/validate.js），不合格的代碼存檔時會被伺服器丟掉
  if (!code){ toast('找不到這個幣別，請從清單選一個，或輸入貨幣代碼（例如 JPY）', 'error'); codeInput.focus(); return; }
  if (code === trip.baseCurrency){ toast(`${code} 是這個行程的基準幣別，不用另外設定匯率`, 'error'); return; }
  if (!(val>0)){ toast('匯率要大於 0', 'error'); valInput.focus(); return; }
  trip.rates[code] = val;
  valInput.value='';
  resetCurrencyPicker();
  toast(`已設定 ${currencyLabel(code)}：1 ${code} ＝ ${val} ${trip.baseCurrency}`, 'success');
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
  if (code === trip.baseCurrency){ toast('這是行程的基準幣別，不能刪除', 'error'); return; }
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

