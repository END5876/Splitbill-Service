'use strict';
// 返回鍵（瀏覽器／Android 返回）：一層一層關，不要一按就離開 App、讓填到一半的表單消失。
// 從裊器音樂的 playerUi.js 搬過來的同一套做法：
//   每打開一層（對話框、總覽以外的分頁、填到一半的表單）就 pushState 一筆；
//   按返回 → popstate 關掉最上面那層。從畫面上關閉時（按取消、切回總覽）呼叫 dropLayer，
//   稍後用 history.go(-n) 把那幾筆消耗掉，讓歷史筆數與開著的層數保持一致。
//   關掉一層後馬上又打開另一層（對話框 → 對話框）時，新的一層直接沿用剛關掉那筆（replaceState），
//   不在 go() 還沒完成前又 pushState —— 那樣瀏覽器的處理順序不可靠。
// 對外：pushLayer(name, close)、dropLayer(name)、hasLayer(name)
const backLayers = [];        // [{ name, close }]
let backLayerPopping = false; // popstate 正在關閉某一層：這時 dropLayer 不要再動歷史
let backSkipPops = 0;         // 自己呼叫 go(-n) 觸發的 popstate 要忽略
let backPendingDrops = 0;     // 已從畫面關閉、還沒從歷史消耗掉的筆數

function pushLayer(name, close){
  if (backLayers.some(l => l.name === name)) return;
  backLayers.push({ name, close });
  // 保留網址（含 #link= 之類的 hash），只多一筆歷史
  try{
    if (backPendingDrops > 0){ backPendingDrops--; history.replaceState({ sbLayer: backLayers.length }, ''); }
    else history.pushState({ sbLayer: backLayers.length }, '');
  }catch(e){ /* 某些內嵌瀏覽器不允許改歷史：返回鍵維持原本行為 */ }
}
function dropLayer(name){
  const i = backLayers.map(l => l.name).lastIndexOf(name);
  if (i < 0) return;
  backLayers.splice(i, 1);
  if (backLayerPopping) return;
  backPendingDrops++;
  setTimeout(flushBackDrops, 0);
}
function hasLayer(name){ return backLayers.some(l => l.name === name); }
function flushBackDrops(){
  if (!backPendingDrops) return;
  const n = backPendingDrops; backPendingDrops = 0;
  backSkipPops++;
  history.go(-n);
}
// 表單填到一半時多一層：按返回先問要不要放棄，選「繼續填寫」就留在原地
function guardFormOnBack({ formId, layer, isDirty, reset, title, message }){
  const form = document.getElementById(formId);
  if (!form) return;
  const onBack = async () => {
    const discard = await confirmModal(message, { title, confirmText: '放棄內容', cancelText: '繼續填寫', danger: true });
    if (discard) reset();
    else if (isDirty()) pushLayer(layer, onBack);
  };
  form.addEventListener('input', () => { if (isDirty()) pushLayer(layer, onBack); });
}
window.addEventListener('popstate', () => {
  if (backSkipPops){ backSkipPops--; return; }
  const top = backLayers[backLayers.length - 1];
  if (!top) return;
  backLayerPopping = true;
  try{ top.close(); } finally { backLayerPopping = false; }
  // 保險：close 沒有自己 dropLayer 時移除這一層。close 可能又開了新的一層（例如確認框），所以要找 top 本身
  const i = backLayers.indexOf(top);
  if (i >= 0) backLayers.splice(i, 1);
});
