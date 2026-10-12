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
        const pick = await pickModal('偵測到多個行程，選一個要匯入的：', items);
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
  try { parsed = JSON.parse(raw); } catch(err){ toast('JSON 格式錯誤：'+err.message, 'error'); return; }

  const candidate = await resolveTripFromRaw(parsed);
  if (!candidate){ toast('找不到可辨識的行程資料', 'error'); return; }
  const created = await createCloudTripFrom(repairTrip(candidate));
  if (created){
    document.getElementById('jsonInput').value = '';
    document.getElementById('fileInput').value = '';
  }
}
