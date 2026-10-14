'use strict';
// 設定 →「紀錄」：操作紀錄（誰、什麼時候、改了什麼）、單筆還原、整份回到某個版本。
/* =====================================================================
   資料來源：伺服器每次寫入行程時自動產生的操作紀錄（routes/history.js、lib/activity.js）。
   - 刪掉的支出／轉帳：「還原這筆」→ 用紀錄裡存的內容走單筆 API 寫回去
   - 改過的支出／轉帳：「復原這次修改」→ 寫回修改前的內容
   - 新增的支出／轉帳：「撤銷新增」→ 刪掉那一筆
   - 整個版本：「回到這個版本」→ 伺服器把行程內容整份換成當時的快照
   每一次還原本身也是一次修改，會出現在紀錄最上面，還原錯了可以再還原回來。
===================================================================== */
const HISTORY_PAGE_SIZE = 30;
let historyItems = [];          // 目前載入的紀錄（新的在前）
let historyHasMore = false;
let historyKey = null;          // 哪個行程的紀錄（換行程時重新載入）
let historyLoadedVersion = null; // 載入時行程的版本；行程又有更新時自動重新載入
let historyLoading = false;
let historyError = null;
let historyReloadTimer = null;

function historyApiUrl(suffix){
  return shareMode
    ? `/api/shared-trip/${encodeURIComponent(shareMode.token)}${suffix}`
    : tripApiUrl(suffix);
}
function historyTripKey(){
  if (shareMode) return 'share:' + shareMode.token;
  return currentTripId ? 'trip:' + currentTripId : null;
}
function canWriteHistory(){
  return !!historyTripKey() && !(shareMode && shareMode.permission !== 'write');
}

// renderAll()／切到「設定 → 紀錄」時呼叫：只有這個子分頁開著時才做事；行程換了或版本變了就重新載入
function renderHistoryIfVisible(){
  const panel = document.getElementById('panel-history');
  const settings = document.getElementById('panel-settings');
  if (!panel || !panel.classList.contains('active') || !settings || !settings.classList.contains('active')) return;
  const key = historyTripKey();
  if (key !== historyKey){
    historyKey = key;
    historyItems = []; historyHasMore = false; historyLoadedVersion = null; historyError = null;
    if (key) loadHistory(); else renderHistoryPanel();
    return;
  }
  if (key && !historyLoading && historyLoadedVersion !== (trip.updatedAt || null)){
    clearTimeout(historyReloadTimer);
    historyReloadTimer = setTimeout(()=>loadHistory(), 400); // 連續好幾次更新只重抓一次
  }
}

async function loadHistory(more){
  if (!historyKey) return;
  const key = historyKey;
  historyLoading = true;
  historyError = null;
  if (!more) renderHistoryPanel();
  try{
    const before = more && historyItems.length ? historyItems[historyItems.length - 1].updatedAt : '';
    const res = await fetch(historyApiUrl(`/activity?limit=${HISTORY_PAGE_SIZE}${before ? `&before=${before}` : ''}`), { headers: apiHeaders() });
    const body = await apiJson(res);
    if (key !== historyKey) return; // 載入途中換了行程
    historyItems = more ? historyItems.concat(body.items) : body.items;
    historyHasMore = !!body.hasMore;
    if (!more) historyLoadedVersion = body.currentUpdatedAt;
  }catch(err){
    if (key === historyKey) historyError = err.message;
  }finally{
    if (key === historyKey){ historyLoading = false; renderHistoryPanel(); }
  }
}
function loadMoreHistory(){ return loadHistory(true); }

/* ---------------- 畫面 ---------------- */
const HISTORY_ACTOR_ICON = { user: '👤', bot: '🤖', guest: '🔗', admin: '🛠', system: '⚙️' };

function historyTimeLabel(ts){
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function historyDayLabel(ts){
  const d = new Date(ts);
  const week = '日一二三四五六'[d.getDay()];
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} · 週${week}`;
}
function historyFieldValue(field, v){
  if (v === undefined || v === null || v === '') return '（空白）';
  if (field === 'createdAt') return toDateInputValue(v).replace(/-/g, '/');
  if (typeof v === 'number') return fmtMoneyCompact(v);
  return String(v);
}

// 一項變動 → { text（HTML）, action }；action 是這一項可以做的還原動作（沒有就是 null）
function describeChange(c){
  const t = (s) => escapeHtml(s);
  const b = (s) => `<b>${escapeHtml(s)}</b>`;
  switch (c.type){
    case 'trip.create': return { text: `建立了行程 ${b(c.label)}` };
    case 'trip.rename': return { text: `把行程名稱從 ${b(c.from)} 改成 ${b(c.to)}` };
    case 'trip.baseCurrency': return { text: `把基準幣別從 ${t(c.from)} 改成 ${t(c.to)}` };
    case 'trip.archive': return { text: c.to ? '封存了行程' : '取消封存行程' };
    case 'trip.bind': return { text: '把行程綁定到 Discord 伺服器' };
    case 'trip.unbind': return { text: '解除了 Discord 伺服器綁定' };
    case 'rate.add': return { text: `新增匯率 ${b(c.code)} ＝ ${t(c.to)}` };
    case 'rate.change': return { text: `把 ${b(c.code)} 的匯率從 ${t(c.from)} 改成 ${t(c.to)}` };
    case 'rate.remove': return { text: `刪除了 ${b(c.code)} 的匯率` };
    case 'member.add': return { text: `新增成員 ${b(c.label)}` };
    case 'member.remove': return { text: `刪除了成員 ${b(c.label)}` };
    case 'member.rename': return { text: `把成員 ${b(c.from)} 改名為 ${b(c.to)}` };
    case 'member.link': return { text: `${b(c.label)} 連結了 Discord 帳號` };
    case 'member.unlink': return { text: `${b(c.label)} 解除了 Discord 連結` };
    case 'more': return { text: `…以及另外 ${c.count} 項變動` };
  }
  const m = /^(expense|deposit)\.(add|edit|remove)$/.exec(c.type);
  if (!m) return { text: t(c.type) };
  const [, kind, op] = m;
  const noun = kind === 'expense' ? '支出' : '轉帳';
  const list = kind === 'expense' ? trip.expenses : trip.deposits;
  const current = list.find(x => x.id === c.id);
  if (op === 'add'){
    return { text: `新增${noun} ${b(c.label)}`, action: current ? { op: 'undo-add', label: '撤銷新增' } : null };
  }
  if (op === 'remove'){
    return { text: `刪除了${noun} ${b(c.label)}`, action: current ? null : { op: 'restore', label: '還原這筆' } };
  }
  // 日期欄位存的是時間戳；同一天內的時間變動在畫面上看不出差別，不列出來
  const sameDay = (f) => f.field === 'createdAt' && historyFieldValue(f.field, f.from) === historyFieldValue(f.field, f.to);
  const fields = (c.fields || []).filter(f => !sameDay(f)).map(f => f.from === undefined
    ? `${t(f.label)}有變動`
    : `${t(f.label)}：${t(historyFieldValue(f.field, f.from))} → ${t(historyFieldValue(f.field, f.to))}`);
  return {
    text: `修改了${noun} ${b(c.label)}${fields.length ? `<span class="hist-fields">${fields.join('<br>')}</span>` : ''}`,
    action: current ? { op: 'revert-edit', label: '復原這次修改' } : null,
  };
}

function historyReasonHtml(item){
  const r = item.reason;
  if (!r) return '';
  if (r.type === 'restore-entry') return '<span class="hist-badge">還原</span>';
  if (r.type === 'restore-revision') return `<span class="hist-badge">回到 ${escapeHtml(historyDayLabel(r.from).split(' ')[0])} ${escapeHtml(historyTimeLabel(r.from))} 的版本</span>`;
  return '';
}

function historyItemHtml(item){
  const writable = canWriteHistory();
  const actor = item.actor || {};
  const changes = (item.changes || []).map((c, idx) => {
    const d = describeChange(c);
    const btn = writable && d.action
      ? `<button type="button" class="link-btn hist-action" ${act('click','historyRestoreChange', item.updatedAt, idx)}>${escapeHtml(d.action.label)}</button>`
      : '';
    return `<li><span class="hist-change">${d.text}</span>${btn}</li>`;
  }).join('');
  const revisionBtn = writable && item.restorable
    ? `<button type="button" class="link-btn hist-revert" ${act('click','historyRestoreRevision', item.updatedAt)} title="把整個行程回到這筆修改之後的狀態">回到此版本</button>`
    : '';
  return `
    <div class="hist-item">
      <div class="hist-head">
        <span class="hist-actor"><span aria-hidden="true">${HISTORY_ACTOR_ICON[actor.kind] || '•'}</span>${escapeHtml(actor.name || '未知')}${actor.isMe ? '<span class="hist-me">（你）</span>' : ''}${actor.kind === 'bot' ? '<span class="hist-via">在 Discord</span>' : ''}</span>
        <span class="hist-meta">${revisionBtn}<span class="hist-time">${historyTimeLabel(item.at)}</span></span>
      </div>
      ${historyReasonHtml(item)}
      <ul class="hist-changes">${changes}</ul>
    </div>`;
}

function renderHistoryPanel(){
  const el = document.getElementById('historyList');
  if (!el) return;
  if (!historyKey){
    el.innerHTML = '<p class="empty-state" style="padding:16px;">開啟雲端行程之後，這裡會列出每一次修改：誰、什麼時候、改了什麼，刪錯的帳目也可以從這裡還原。</p>';
    return;
  }
  if (historyError && !historyItems.length){
    el.innerHTML = `<p class="empty-state" style="padding:16px;">讀取紀錄失敗：${escapeHtml(historyError)}</p>
      <div class="btn-row" style="justify-content:center;"><button class="btn btn-ghost btn-sm" type="button" data-click="loadHistory">重試</button></div>`;
    return;
  }
  if (!historyItems.length){
    el.innerHTML = `<p class="empty-state" style="padding:16px;">${historyLoading ? '讀取中…' : '還沒有任何紀錄。之後每一次修改都會出現在這裡。'}</p>`;
    return;
  }
  // 依日期分組，沿用帳目清單的分組樣式
  const days = [];
  for (const item of historyItems){
    const label = historyDayLabel(item.at);
    if (!days.length || days[days.length - 1].label !== label) days.push({ label, items: [] });
    days[days.length - 1].items.push(item);
  }
  el.innerHTML = days.map(d => `
    <div class="ledger-day">
      <div class="ledger-day-head"><span class="ledger-day-date">${escapeHtml(d.label)}</span></div>
      <div class="ledger-day-box">${d.items.map(historyItemHtml).join('')}</div>
    </div>`).join('') + (historyHasMore
      ? `<div class="btn-row" style="justify-content:center; margin-top:14px;"><button class="btn btn-ghost btn-sm" type="button" data-click="loadMoreHistory" data-loading="讀取中…">載入更早的紀錄</button></div>`
      : '');
}

/* ---------------- 還原 ---------------- */
// 單筆：還原刪掉的、復原修改、撤銷新增。走單筆 API（帶 restore: true），成功後才算數。
async function historyRestoreChange(updatedAt, idx){
  const item = historyItems.find(x => x.updatedAt === updatedAt);
  const c = item && item.changes[idx];
  const m = c && /^(expense|deposit)\.(add|edit|remove)$/.exec(c.type);
  if (!m) return;
  const kind = m[1] === 'expense' ? 'expenses' : 'deposits';
  const noun = m[1] === 'expense' ? '支出' : '轉帳';
  const list = trip[kind];
  const current = list.find(x => x.id === c.id);
  // 寫回去的內容：刪掉的／改過的 → 當時的 before；新增的 → 刪掉（null）
  const target = m[2] === 'add' ? null : c.before;

  if (target){
    const refs = kind === 'expenses'
      ? [...target.payers, ...target.participants].map(p => p.userId)
      : [target.payerId, target.collectorId];
    const missing = [...new Set(refs)].filter(id => !trip.members.some(mem => mem.id === id));
    if (missing.length){
      toast(`這筆${noun}用到的成員已經被刪除了，請先把成員加回來（或改用「回到這個版本」）`, 'error', { duration: 7000 });
      return;
    }
  }
  const message = m[2] === 'remove' ? `要還原${noun}「${c.label}」嗎？`
    : m[2] === 'add' ? `要刪除這筆${noun}「${c.label}」嗎？`
    : (current && JSON.stringify(current) !== JSON.stringify(c.after))
      ? `這筆${noun}在這次修改之後又被改過。確定要回到這次修改「之前」的內容嗎？之後的修改也會一起被蓋掉。`
      : `要把${noun}「${c.label}」改回這次修改之前的內容嗎？`;
  const ok = await confirmModal(message, { title: '還原', confirmText: m[2] === 'add' ? '刪除' : '還原', danger: m[2] === 'add' });
  if (!ok) return;

  // 先套用到本地再同步；失敗的話把本地改回來，不留下一筆伺服器不接受的資料
  const backup = list.slice();
  const idxNow = list.findIndex(x => x.id === c.id);
  if (target){
    const entry = JSON.parse(JSON.stringify(target));
    if (idxNow === -1) list.push(entry); else list[idxNow] = entry;
  } else if (idxNow !== -1){
    list.splice(idxNow, 1);
  }
  renderAll();
  const saved = await syncEntry(kind, c.id, target ? list.find(x => x.id === c.id) : null, { restore: true });
  if (!saved){
    trip[kind] = backup;
    syncFailed = false;
    renderSyncStatus();
    renderAll();
  }
}

// 整份：把行程內容（帳目、成員、匯率、名稱）換成那個版本
async function historyRestoreRevision(updatedAt){
  let snap;
  try{
    const res = await fetch(historyApiUrl(`/revisions/${updatedAt}`), { headers: apiHeaders() });
    snap = (await apiJson(res)).trip;
  }catch(err){
    toast('讀取這個版本失敗：' + err.message, 'error');
    return;
  }
  const when = `${historyDayLabel(updatedAt)} ${historyTimeLabel(updatedAt)}`;
  const ok = await confirmModal(
    `要把整個行程回到 ${when} 的狀態嗎？\n\n` +
    `那時候：支出 ${snap.expenses.length} 筆、轉帳 ${snap.deposits.length} 筆、成員 ${snap.members.length} 人\n` +
    `現在：支出 ${trip.expenses.length} 筆、轉帳 ${trip.deposits.length} 筆、成員 ${trip.members.length} 人\n\n` +
    `之後所有人做的修改都會被蓋掉（已連結 Discord 的成員會保留）。還原本身也會留下紀錄，需要的話可以再還原回來。`,
    { title: '回到這個版本', confirmText: '回到這個版本', danger: true }
  );
  if (!ok) return;
  await flushCloudSave(); // 還在等待中的設定修改先存掉，避免還原後又被它蓋回去
  try{
    const res = await fetch(historyApiUrl(`/revisions/${updatedAt}/restore`), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
      body: JSON.stringify({ writerId: CLIENT_INSTANCE_ID }),
    });
    const body = await apiJson(res);
    trip = repairTrip(body.trip);
    lastSyncedTripJSON = JSON.stringify(trip);
    syncFailed = false;
    renderSyncStatus();
    renderAll();
    toast(`已回到 ${when} 的版本`, 'success');
  }catch(err){
    toast('還原失敗：' + err.message, 'error');
  }
}
