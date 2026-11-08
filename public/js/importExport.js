'use strict';
// 進階分頁：下載 JSON 備份、把 JSON 匯入成新的雲端行程。
// 匯入一律建立「新的」行程（POST /api/trips），不會覆蓋目前開著的行程。
/* ===================== import / export ===================== */
// 找出 JSON 裡的行程：單一 trip 物件，或舊版整份資料 { trips: {...} }／{ guildId: { trips: {...} } }。
// 有多個行程時用站內清單 modal 讓使用者用點的。
async function resolveTripFromRaw(parsed){
  if (parsed && parsed.members && parsed.expenses !== undefined) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    let tripsBag = parsed.trips ? parsed : null;
    if (!tripsBag) {
      for (const key of Object.keys(parsed)) {
        if (parsed[key] && parsed[key].trips) { tripsBag = parsed[key]; break; }
      }
    }
    if (tripsBag && tripsBag.trips) {
      const ids = Object.keys(tripsBag.trips);
      if (ids.length === 1) return tripsBag.trips[ids[0]];
      if (ids.length > 1) {
        const items = ids.map(id=>{
          const t = tripsBag.trips[id];
          return { value: id, title: t.name || '未命名行程', sub: `${(t.members||[]).length} 位成員・${(t.expenses||[]).length} 筆支出` };
        });
        const pick = await pickModal('檔案裡有多個行程，要匯入哪一個？', items);
        return pick ? tripsBag.trips[pick] : null;
      }
    }
  }
  return null;
}
function tripJsonText(){
  return JSON.stringify(trip, null, 2);
}
function downloadJson(){
  if (!isConnected()){ toast('請先開啟一個行程', 'error'); return; }
  const blob = new Blob([tripJsonText()], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `splitbill-${trip.name || trip.id}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function copyJson(){
  if (!isConnected()){ toast('請先開啟一個行程', 'error'); return; }
  navigator.clipboard.writeText(tripJsonText())
    .then(()=>toast('已複製到剪貼簿', 'success'))
    .catch(()=>toast('複製失敗，請改用「下載」', 'error'));
}
/* ===================== CSV 匯出（給 Excel／Google 試算表） ===================== */
// 一份檔案兩段：
//   1. 帳目明細：每筆支出／轉帳一列；最後幾欄是「這筆對每位成員的影響」（基準幣別，正＝多付了、該收回，
//      負＝該付），最底下的合計列就是每個人最後的淨額，跟總覽頁算出來的一樣。
//   2. 建議轉帳：照總覽頁「建議轉帳」的算法，誰要給誰多少。
// 文字欄位開頭是 = + - @ 時前面加 '，避免試算表把它當公式執行（CSV 公式注入）。
function csvText(v){
  const s = String(v ?? '');
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}
function csvCell(v){
  const s = typeof v === 'number' ? String(v) : csvText(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvDate(ts){
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function buildTripCsv(t){
  const base = t.baseCurrency;
  const nameOf = (id) => { const m = t.members.find(x=>x.id===id); return m ? m.name : '（已刪除成員）'; };
  const who = (list) => list.map(p => `${nameOf(p.userId)} ${round2(p.amount)}`).join('、');
  const memberIds = t.members.map(m => m.id);
  const rows = [];

  rows.push(['行程', t.name]);
  rows.push(['基準幣別', base]);
  rows.push(['匯出時間', csvDate(Date.now())]);
  rows.push([]);
  rows.push(['類型', '日期', '項目／備註', '金額', '幣別', `換算（${base}）`, '付款人', '分攤／收款人',
    ...t.members.map(m => `${m.name}（${base}）`)]);

  const entries = [
    ...t.expenses.map(e => ({ kind: 'exp', at: e.createdAt, e })),
    ...t.deposits.map(d => ({ kind: 'dep', at: d.createdAt, d })),
  ].sort((a, b) => a.at - b.at);
  const totals = Object.fromEntries(memberIds.map(id => [id, 0]));

  for (const it of entries){
    const effect = Object.fromEntries(memberIds.map(id => [id, 0]));
    const add = (id, v) => { if (id in effect) effect[id] = round2(effect[id] + v); };
    if (it.kind === 'exp'){
      const e = it.e;
      for (const p of allocateExpenseBaseAmounts(e.payers, e)) add(p.userId, p.amountInBase);
      for (const s of allocateExpenseBaseAmounts(e.participants, e)) add(s.userId, -s.amountInBase);
      rows.push(['支出', csvDate(e.createdAt), e.description, round2(e.amount), e.currency, round2(e.amountInBase),
        who(e.payers), who(e.participants), ...memberIds.map(id => effect[id])]);
    } else {
      const d = it.d;
      // 與 calcNetBalances 一致：轉帳的付款人＋、收款人－
      add(d.payerId, d.amountInBase);
      add(d.collectorId, -d.amountInBase);
      rows.push(['轉帳', csvDate(d.createdAt), d.note, round2(d.amount), d.currency, round2(d.amountInBase),
        nameOf(d.payerId), nameOf(d.collectorId), ...memberIds.map(id => effect[id])]);
    }
    for (const id of memberIds) totals[id] = round2(totals[id] + effect[id]);
  }
  rows.push(['合計（正數＝應收，負數＝應付）', '', '', '', '', '', '', '', ...memberIds.map(id => totals[id])]);

  rows.push([]);
  rows.push(['建議轉帳']);
  const tx = simplifyDebts(calcNetBalances(t));
  if (tx.length){
    rows.push(['付款人', '收款人', `金額（${base}）`]);
    for (const x of tx) rows.push([nameOf(x.from), nameOf(x.to), x.amount]);
  } else {
    rows.push(['目前沒有需要轉帳的款項']);
  }
  // Excel 要有 BOM 才會用 UTF-8 讀中文；換行用 CRLF
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function downloadCsv(){
  if (!isConnected()){ toast('請先開啟一個行程', 'error'); return; }
  const blob = new Blob([buildTripCsv(trip)], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `splitbill-${trip.name || trip.id}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function handleFileImport(evt){
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{ document.getElementById('jsonInput').value = reader.result; };
  reader.readAsText(file);
}
async function importJsonAsNewTrip(){
  const raw = document.getElementById('jsonInput').value.trim();
  if (!raw){ toast('請選擇 JSON 檔案，或把內容貼上', 'error'); return; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch(err){ toast('讀不懂這份內容，請確認是從裊器分帳下載的 JSON 檔', 'error'); return; }

  const candidate = await resolveTripFromRaw(parsed);
  if (!candidate){ toast('這份檔案裡沒有行程資料，請確認是從裊器分帳下載的 JSON 檔', 'error'); return; }
  const created = await createCloudTripFrom(repairTrip(candidate));
  if (created){
    document.getElementById('jsonInput').value = '';
    document.getElementById('fileInput').value = '';
  }
}
