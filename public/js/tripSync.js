'use strict';
// 行程讀寫核心：loadTripFromApi/saveTripToApi（含版本衝突重試與合併）、分享連結版 saveSharedTripToApi、tryMergeTrips。
// 🆕 [行程獨立化] 雲端行程一律用 /api/trip/:tripId（tripApiUrl()），不再需要伺服器 ID。
async function loadTripFromApi(opts){
  opts = opts || {};
  const tripId = opts.tripId || document.getElementById('tripSelect').value;
  if (!tripId){ if (!opts.quiet) toast('請先選擇一個行程', 'error'); return; }
  await flushCloudSave(); // 目前行程還有等待中的自動儲存，先存完再換掉 trip，避免改動遺失
  try{
    const res = await fetch(`/api/trip/${encodeURIComponent(tripId)}`, { headers: apiHeaders() });
    const data = await apiJson(res);
    currentTripId = tripId;
    trip = repairTrip(data);
    if (typeof resetCurrencyPicker === 'function') resetCurrencyPicker(); // 上一個行程選到一半的幣別不要帶過來
    lastSyncedTripJSON = JSON.stringify(trip);
    syncFailed = false;
    editingExpenseId = null; editingDepositId = null;
    expandedExpenseIds.clear(); expandedDepositIds.clear();
    resetListFilters();
    resetOverviewSectionCurrencyState();
    if (!opts.quiet) toast(`已載入「${trip.name}」（成員 ${trip.members.length} 人、支出 ${trip.expenses.length} 筆）`, 'success');
    restorePendingEntries(); // 上次沒存到的帳目放回畫面，接著自動補存
    if (currentSettingsSub === 'people') renderTripLinksPanel();
    if (currentSettingsSub === 'trip') renderDiscordPanel();
    saveOwnerConnectionState();
    renderAll();
    connectTripEventStream();
    checkReceiptSessionAvailability(); // 🆕 [多人協作] 看看有沒有人正在進行帳單辨識協作
    if (!receiptState) maybeOfferReceiptDraftRestore(); // 🆕 目前沒有進行中的認領才詢問，避免打斷正在做的事
  }catch(err){
    if (!opts.quiet) toast('載入失敗：' + err.message, 'error');
  }
}
// 🆕 [即時寫入] 設定頁（成員、匯率、行程名稱）改動後自動寫入雲端，畫面上是什麼 JSON 就是什麼。
// 防抖＋序列化：連續操作只存一次；存檔進行中又有新改動，等這次結束後再補存一次。
// 還沒開啟雲端行程（沒有 currentTripId 且非分享連結）時不處理。
let cloudSaveTimer = null;
let cloudSavePending = false; // 已排程、但防抖計時還沒到（頁首同步狀態也算「儲存中」）
let cloudSaveRunning = false;
let cloudSaveQueued = false;
let cloudSaveRunPromise = null; // 正在跑的那次自動儲存，換行程前要等它結束
function scheduleCloudSave(delay){
  if (!currentTripId && !shareMode) return;
  if (shareMode && shareMode.permission !== 'write') return;
  clearTimeout(cloudSaveTimer);
  cloudSavePending = true;
  cloudSaveTimer = setTimeout(runCloudSave, delay == null ? 300 : delay);
  renderSyncStatus();
}
// 切換行程前呼叫：還在防抖等待中的自動儲存立刻送出，避免換掉 trip 之後改動遺失。
// 已經送出、還在等回應的那次也要等完（含它結束後補存的那次），不然回應回來時 trip 已經換人了。
async function flushCloudSave(){
  while (cloudSavePending || cloudSaveRunning){
    if (cloudSaveRunning){ await cloudSaveRunPromise; continue; }
    clearTimeout(cloudSaveTimer);
    await runCloudSave();
  }
}
async function runCloudSave(){
  cloudSavePending = false;
  if (cloudSaveRunning){ cloudSaveQueued = true; return; }
  cloudSaveRunning = true;
  try{ await (cloudSaveRunPromise = saveTripToApi()); }
  finally{
    cloudSaveRunPromise = null;
    cloudSaveRunning = false;
    if (cloudSaveQueued){ cloudSaveQueued = false; scheduleCloudSave(0); }
  }
}
/* ===================== 頁首同步狀態 ===================== */
// 讓使用者隨時知道資料存了沒：已同步／儲存中／未儲存（點擊重試）／未開啟行程／唯讀。
let syncSaving = 0;       // 進行中的儲存請求數
let syncFailed = false;   // 最近一次儲存沒有成功（失敗、衝突或使用者取消覆蓋）
// 還有東西沒存到：存檔失敗、正在送出、表單填到一半（關閉頁面、重新載入前提醒）
function hasUnsavedWork(){
  return syncFailed || syncSaving > 0 || isExpenseFormDirty() || isDepositFormDirty();
}
function renderSyncStatus(){
  const el = document.getElementById('syncStatus');
  if (!el) return;
  let state, label, hint;
  if (shareMode && shareMode.permission !== 'write'){
    state = 'readonly'; label = '唯讀'; hint = '這是看帳用的免登入連結，只能看、不能修改';
  } else if (!currentTripId && !shareMode){
    state = 'offline'; label = '未開啟行程'; hint = '點一下開啟或建立行程';
  } else if (syncSaving > 0 || cloudSavePending){
    state = 'saving'; label = '儲存中…'; hint = '正在儲存';
  } else if (syncFailed){
    state = 'error'; label = '未儲存'; hint = '沒有存到，點一下再試一次';
  } else {
    state = 'saved'; label = '已同步'; hint = '已全部儲存';
  }
  el.dataset.state = state;
  el.querySelector('.sync-label').textContent = label;
  el.title = hint;
  el.setAttribute('aria-label', `同步狀態：${label}。${hint}`);
  const switchBtn = document.getElementById('tripSwitchBtn');
  if (switchBtn) switchBtn.style.display = (!shareMode && currentUser) ? '' : 'none';
}
function onSyncStatusClick(){
  const state = document.getElementById('syncStatus').dataset.state;
  if (state === 'offline'){ showMainTab('settings'); showSettingsSub('account'); }
  else if (state === 'error'){ saveTripToApi(); flushPendingEntries(true); }
  else toast(document.getElementById('syncStatus').title, 'info');
}

// 所有雲端儲存的單一入口：包住實際的儲存流程，順便維護頁首同步狀態。
async function saveTripToApi(){
  syncSaving++;
  renderSyncStatus();
  let ok = false;
  try{
    ok = (await saveTripToApiImpl()) === true;
  } finally {
    syncSaving--;
    syncFailed = !ok && !!(currentTripId || shareMode);
    renderSyncStatus();
  }
}
async function saveTripToApiImpl(){
  // 🆕 [分享連結] 分享連結模式下走完全不同的儲存路徑（見 saveSharedTripToApi()）：
  // 不需要登入，純粹用網址
  // 路徑上的 token 當憑證，對分享連結的持有者來說完全不用碰到任何技術設定。
  if (shareMode) return saveSharedTripToApi();

  if (!currentTripId){
    showMainTab('settings'); showSettingsSub(currentUser ? 'trips' : 'connect');
    toast(currentUser
      ? '還沒開啟任何行程：請先在「設定 → 行程」開啟或建立一個行程。'
      : '尚未登入：請先到「設定 → 帳號」登入，再到「行程」開啟行程。', 'error');
    return;
  }

  // 🆕 [併發保護] 最多重試幾次：多人幾乎同時存檔時，即使每次都被伺服器的
  // 原子化版本檢查擋下（409），本地合併後重試一次通常就會成功；重試上限
  // 只是避免理論上的無限迴圈（例如短時間內一直有新的人持續搶著存檔）。
  const MAX_SAVE_RETRY = 3;
  // 等回應的期間使用者可能已經換到別的行程：之後拿到的回應都屬於舊行程，不能套到現在的 trip 上
  const tripIdAtStart = currentTripId;
  const tripSwitched = () => currentTripId !== tripIdAtStart;

  for (let attempt = 0; attempt < MAX_SAVE_RETRY; attempt++){
    // 版本比對：儲存前先看看伺服器上的版本跟我們最後一次同步的是否一致，
    // 偵測到衝突時嘗試自動合併（把伺服器有但本地沒有的筆數加進來），
    // 只有在無法自動合併時才詢問使用者。
    // ⚠️ 這一步只是「儘量減少」不必要的衝突、給使用者更即時的合併體驗，
    // 不是真正的併發保護——它跟下面的 PUT 是兩個分開的請求，兩者之間仍有
    // 極短的競爭視窗。真正的保護在於 PUT 請求本身帶了 expectedUpdatedAt，
    // 由伺服器端原子化比對＋拒絕（見下方 409 處理）。
    // 🆕 [效能] 本地已經有伺服器給的版本號（updatedAt）時跳過這次預先檢查：PUT 帶的
    // expectedUpdatedAt 會由伺服器原子化比對，版本不同就回 409 並附上最新內容，
    // 下面的 409 處理一樣會自動合併後重試，不必每次存檔都多打一次 GET。
    // 第一次儲存、或舊資料還沒有版本號時才需要這一步。
    if (!lastSyncedTripJSON || typeof trip.updatedAt !== 'number') try{
      const checkRes = await fetch(tripApiUrl(), { headers: apiHeaders() });
      if (checkRes.ok){
        const serverTrip = await checkRes.json();
        if (tripSwitched()) return true;
        if (!lastSyncedTripJSON) {
          // 首次儲存（從未載入過），直接確認
          const proceed = await confirmModal(`雲端上「${serverTrip.name}」的內容會被目前畫面上的內容取代。`, { title:'用目前的內容覆蓋行程？', confirmText:'覆蓋並儲存', cancelText:'取消' });
          if (!proceed) return;
        } else if (serverTrip.updatedAt && trip.updatedAt && serverTrip.updatedAt !== trip.updatedAt) {
          // 伺服器版本比本地版本新，嘗試智慧合併
          const merged = mergeWithServer(serverTrip);
          if (merged) {
            // 合併成功：靜默套用合併結果，不打擾使用者
            trip = merged;
            renderAll();
            toast('已更新成最新內容，你的修改也保留著', 'info');
          } else {
            // 合併失敗（有衝突）：詢問使用者
            const proceed = await confirmModal('其他人剛改過這個行程，跟你的修改衝突了。覆蓋的話，其他人剛才的修改會不見（可以在「紀錄」找回）。', { danger:true, confirmText:'用我的版本覆蓋', cancelText:'取消', title:'要覆蓋其他人的修改嗎？' });
            if (!proceed) return;
          }
        } else if (lastSyncedTripJSON && JSON.stringify(serverTrip) !== lastSyncedTripJSON && !serverTrip.updatedAt) {
          // 舊版伺服器（沒有 updatedAt），退回原本的整包比對
          const merged = mergeWithServer(serverTrip);
          if (merged) {
            trip = merged;
            renderAll();
            toast('已更新成最新內容，你的修改也保留著', 'info');
          } else {
            const proceed = await confirmModal('這個行程好像剛被更新過（可能是別人，或你在別的分頁存過）。覆蓋的話，那些更新會不見。', { danger:true, confirmText:'用我的版本覆蓋', cancelText:'取消', title:'要覆蓋最新的修改嗎？' });
            if (!proceed) return;
          }
        }
      }
    }catch(e){ /* 檢查失敗就略過，不要因為這個擋住存檔 */ }

    try{
      // 🆕 [併發保護] 把本地目前認定的版本號一併送給伺服器；伺服器會在真正
      // 寫入前原子化比對這個版本號是否仍然等於它「當下」的版本，不一致就
      // 回傳 409，讓下面的重試邏輯接手，而不是悶不吭聲地整包覆蓋。
      if (tripSwitched()) return true;
      const sentJSON = JSON.stringify(trip); // 送出的那份，回應回來時拿來判斷這段期間本地又改了什麼
      const payload = Object.assign({}, trip, { expectedUpdatedAt: trip.updatedAt || null, writerId: CLIENT_INSTANCE_ID });
      const res = await fetch(tripApiUrl(), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
        body: JSON.stringify(payload)
      });
      if (tripSwitched()) return true;

      if (res.status === 409){
        // 真的被別人搶先一步存檔了（上面的預先檢查沒能攔到這個極短的競爭
        // 視窗）：拿伺服器回傳的「當下最新版本」合併，合併成功就重試一次；
        // 合併不了（真衝突）就不再重試，請使用者重新整理頁面。
        const body = await res.json().catch(()=>({}));
        if (tripSwitched()) return true;
        const serverTrip = body.currentTrip;
        const merged = serverTrip ? mergeWithServer(serverTrip) : null;

        if (!merged){
          toast('其他人剛改過同一筆資料，請重新載入頁面後再改一次。', 'error');
          return;
        }

        trip = merged;
        renderAll();
        if (attempt < MAX_SAVE_RETRY - 1){
          toast('有人剛好也在修改，正在重新儲存…', 'info');
          continue; // 用合併後的版本再跑一次迴圈重新存一次
        }
        toast('還沒存好，請再按一次「儲存」。', 'error');
        return;
      }

      if (!res.ok){
        const body = await res.json().catch(()=>({}));
        throw new Error(body.error || ('HTTP ' + res.status));
      }
      const savedData = await res.json();
      if (tripSwitched()) return true;
      applySavedTrip(savedData, sentJSON); // 用伺服器回傳的版本（含最新 updatedAt）更新本地
      toast('已儲存', 'success');
      saveOwnerConnectionState();
      renderAll();
      return true; // 成功，結束整個函式
    }catch(err){
      toast('儲存失敗：' + err.message, 'error');
      return;
    }
  }
}

// 🆕 [多人協作] 三方合併：local（畫面上的版本）、server（伺服器最新版本）、
// base（雙方最後一次一致的版本＝lastSyncedTripJSON）。以 id 為鍵逐筆比較：
//   只有一邊改過 → 用改過的那邊（包含「刪除」也算改過）
//   兩邊都改、而且改得不一樣 → 以本地為準（使用者正在操作的優先），計入 lastMergeConflicts
// 以前只做兩方合併，看不出「本地沒有」是被刪掉還是根本沒拿到，結果別人刪掉的帳目
// 會在自己存檔時復活、自己刪掉的帳目也會被別人的版本補回來。
// 沒有 base（第一次儲存、或舊資料）時退回原本的作法：聯集、同 id 以本地為準。
let lastMergeConflicts = 0;
function syncBase(){
  try{ return lastSyncedTripJSON ? JSON.parse(lastSyncedTripJSON) : null; }catch(e){ return null; }
}
function sameJson(a, b){ return JSON.stringify(a) === JSON.stringify(b); }
function mergeById(localList, serverList, baseList){
  const L = new Map(localList.map(x=>[x.id, x]));
  const S = new Map(serverList.map(x=>[x.id, x]));
  const B = baseList ? new Map(baseList.map(x=>[x.id, x])) : null;
  const out = [];
  let conflicts = 0;
  for (const [id, s] of S){
    const l = L.get(id), b = B && B.get(id);
    if (!l){
      if (!b){ out.push(s); continue; }              // 別人新增的
      if (!sameJson(b, s)){ conflicts++; out.push(s); } // 我刪掉、別人改過：保留別人的修改
      continue;                                        // 我刪掉、別人沒動：刪除
    }
    if (sameJson(l, s) || (b && sameJson(b, l))){ out.push(s); continue; } // 一樣，或只有別人改過
    if (b && !sameJson(b, s)){ conflicts++; }          // 兩邊都改過
    else if (!b){ conflicts++; }
    out.push(l);
  }
  for (const [id, l] of L){
    if (S.has(id)) continue;
    const b = B && B.get(id);
    if (!b){ out.push(l); continue; }                  // 我新增的
    if (!sameJson(b, l)){ conflicts++; out.push(l); }  // 別人刪掉、我改過：保留我的修改
    // 別人刪掉、我沒動：刪除
  }
  return { list: out, conflicts };
}
function mergeRates(local, server, base){
  const out = {};
  for (const code of new Set([...Object.keys(local), ...Object.keys(server)])){
    const l = local[code], s = server[code], b = base ? base[code] : undefined;
    const v = (base && l === b) ? s : (l !== undefined ? l : (base && b !== undefined ? undefined : s));
    if (v !== undefined) out[code] = v;
  }
  return out;
}
function tryMergeTrips(localTrip, serverTrip, baseTrip){
  try{
    const base = baseTrip || null;
    const byTime = (a,b)=>(a.createdAt||0)-(b.createdAt||0);
    const exp = mergeById(localTrip.expenses, serverTrip.expenses, base && base.expenses);
    const dep = mergeById(localTrip.deposits, serverTrip.deposits, base && base.deposits);
    const mem = mergeById(localTrip.members, serverTrip.members, base && base.members);
    lastMergeConflicts = exp.conflicts + dep.conflicts + mem.conflicts;
    // 行程名稱、基準幣別、封存狀態：本地沒改過就用伺服器的
    const scalar = (key) => (base && sameJson(localTrip[key], base[key])) ? serverTrip[key] : localTrip[key];
    const merged = Object.assign({}, serverTrip, {
      name: scalar('name'),
      baseCurrency: scalar('baseCurrency'),
      archived: scalar('archived'),
      rates: base ? mergeRates(localTrip.rates, serverTrip.rates, base.rates) : Object.assign({}, serverTrip.rates, localTrip.rates),
      expenses: exp.list.sort(byTime),
      deposits: dep.list.sort(byTime),
      members: mem.list,
      // 版本號用伺服器的（合併後儲存時伺服器會再更新）
      updatedAt: serverTrip.updatedAt,
    });
    return repairTrip(merged);
  }catch(e){
    return null; // 合併過程出錯，回傳 null 讓呼叫端改走衝突提示
  }
}
// 整包存檔成功後套用伺服器回應。PUT 進行中本地又有新改動（名稱繼續打字、又記了一筆…）時，
// 以「送出的那份」當 base 三方合併把新改動留下來；直接整包蓋掉會讓這些改動消失，
// 之後的存檔甚至會把伺服器上剛存好的那筆刪掉。
function applySavedTrip(savedRaw, sentJSON){
  const server = repairTrip(savedRaw);
  let merged = null;
  if (JSON.stringify(trip) !== sentJSON){
    try{ merged = tryMergeTrips(trip, server, JSON.parse(sentJSON)); }catch(e){ merged = null; }
  }
  trip = merged || server;
  lastSyncedTripJSON = JSON.stringify(server);
}
// 跟伺服器版本做三方合併；成功時 base 換成伺服器版本，之後的比較都以它為準。
function mergeWithServer(serverTrip){
  const server = repairTrip(serverTrip);
  const merged = tryMergeTrips(trip, server, syncBase());
  if (merged) lastSyncedTripJSON = JSON.stringify(server);
  return merged;
}

/* =====================================================================
   🆕 單筆支出／轉帳同步（伺服器端見 routes/entries.js）
   ---------------------------------------------------------------------
   新增、編輯、刪除一筆支出或轉帳時，只送那一筆，不再整包 PUT 行程：
   多人同時記帳時，改的是不同筆就完全不會衝突，傳輸量也不會隨行程變大。
   伺服器回傳 prevUpdatedAt（寫入前的版本）：等於本地版本代表中間沒有漏掉
   別人的更新，直接把版本往前推；不相等就重新抓一次完整行程合併。
   失敗時本地的修改還在，頁首會顯示「未儲存」，點一下改用整包儲存重試。
===================================================================== */
function entryApiUrl(kind, id){
  const base = shareMode
    ? `/api/shared-trip/${encodeURIComponent(shareMode.token)}`
    : tripApiUrl();
  return `${base}/${kind}/${encodeURIComponent(id)}`;
}
// 把這次寫入套用到 base，base 才會繼續等於「伺服器上的內容」
function applyEntryToBase(kind, id, entry, updatedAt){
  const base = syncBase();
  if (!base) return;
  const list = base[kind] || (base[kind] = []);
  const idx = list.findIndex(x => x.id === id);
  if (entry){ if (idx === -1) list.push(entry); else list[idx] = entry; }
  else if (idx !== -1) list.splice(idx, 1);
  base.updatedAt = updatedAt;
  lastSyncedTripJSON = JSON.stringify(repairTrip(base));
}
// entry 為 null 代表刪除；opts.restore：這是從「紀錄」還原的（只影響操作紀錄上的說明）
/* ===================== 還沒存到的帳目 ===================== */
// 新增支出／轉帳時剛好沒網路：這筆先存在這台手機上（localStorage），頁首常駐提示，
// 連上網路、重新打開行程或按「再試一次」時自動補送。帳目 id 是前端產生的，伺服器用 PUT 依 id 寫入，
// 重送也不會變成兩筆。只處理「新增」：修改、刪除舊帳目要連上網路才能做。
const PENDING_KEY = 'splitbill-pending-entries';
let pendingFlushing = false;
function readPendingEntries(){
  try{ const v = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); return Array.isArray(v) ? v : []; }catch(e){ return []; }
}
function writePendingEntries(list){
  try{ localStorage.setItem(PENDING_KEY, JSON.stringify(list)); return true; }catch(e){ return false; }
}
function pendingScope(){ return shareMode ? `share:${shareMode.token}` : currentTripId; }
function pendingForCurrentTrip(){
  const scope = pendingScope();
  return scope ? readPendingEntries().filter(p => p.scope === scope) : [];
}
function addPendingEntry(kind, id, entry){
  const scope = pendingScope();
  if (!scope) return false;
  const list = readPendingEntries().filter(p => !(p.scope === scope && p.kind === kind && p.id === id));
  list.push({ scope, kind, id, entry, at: Date.now() });
  const ok = writePendingEntries(list);
  renderPendingBanner();
  return ok;
}
function removePendingEntry(kind, id){
  const scope = pendingScope();
  const list = readPendingEntries();
  const next = list.filter(p => !(p.scope === scope && p.kind === kind && p.id === id));
  if (next.length !== list.length) writePendingEntries(next);
  renderPendingBanner();
}
function renderPendingBanner(){
  const el = document.getElementById('pendingBanner');
  if (!el) return;
  const n = pendingForCurrentTrip().length;
  el.hidden = !n;
  if (n) document.getElementById('pendingText').textContent = navigator.onLine === false
    ? `有 ${n} 筆還沒存到，先存在這台裝置上。連上網路後會自動補存。`
    : `有 ${n} 筆還沒存到，先存在這台裝置上。正在等伺服器回應，也可以按「再試一次」。`;
}
// 開啟行程後：還沒存到的帳目放回畫面（伺服器那份還沒有），再試著補存
function restorePendingEntries(){
  const pending = pendingForCurrentTrip();
  for (const p of pending){
    if (!Array.isArray(trip[p.kind])) continue;
    if (!trip[p.kind].some(x => x.id === p.id)) trip[p.kind].push(p.entry);
  }
  renderPendingBanner();
  if (pending.length){ renderAll(); flushPendingEntries(false); }
}
async function flushPendingEntries(manual){
  if (pendingFlushing) return;
  const pending = pendingForCurrentTrip();
  if (!pending.length) return;
  if (navigator.onLine === false){ if (manual) toast('目前沒有網路，連上後會自動補存', 'info'); return; }
  pendingFlushing = true;
  try{
    for (const p of pending){
      const entry = trip[p.kind] && trip[p.kind].find(x => x.id === p.id) || p.entry;
      const ok = await syncEntry(p.kind, p.id, entry, { fromQueue: true });
      // 還是連不上：剩下的等下次（被伺服器拒絕的那筆 syncEntry 已經移除，繼續送下一筆）
      if (!ok && pendingForCurrentTrip().some(x => x.kind === p.kind && x.id === p.id)) break;
    }
  } finally {
    pendingFlushing = false;
    renderPendingBanner();
  }
  if (!pendingForCurrentTrip().length && pending.length) toast(`已補存 ${pending.length} 筆帳目`, 'success');
}

async function syncEntry(kind, id, entry, opts){
  opts = opts || {};
  if ((!currentTripId && !shareMode) || (shareMode && shareMode.permission !== 'write')){
    return saveTripToApi(); // 沒開雲端行程／唯讀：沿用整包儲存的提示訊息
  }
  syncSaving++;
  renderSyncStatus();
  let ok = false;
  try{
    const res = await fetch(entryApiUrl(kind, id), {
      method: entry ? 'PUT' : 'DELETE',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
      body: JSON.stringify(Object.assign(entry ? { entry } : {}, { writerId: CLIENT_INSTANCE_ID }, opts && opts.restore ? { restore: true } : {})),
    });
    const body = await apiJson(res);
    const saved = entry ? repairTrip({ [kind]: [body.entry] })[kind][0] : null;
    if (saved){
      const idx = trip[kind].findIndex(x => x.id === id);
      if (idx !== -1) trip[kind][idx] = saved; // 用伺服器整理過的版本
    }
    const inSync = typeof trip.updatedAt === 'number' && body.prevUpdatedAt === trip.updatedAt;
    if (inSync){
      trip.updatedAt = body.updatedAt;
      applyEntryToBase(kind, id, saved, body.updatedAt);
    } else {
      await refreshTripFromServer();
    }
    ok = true;
    removePendingEntry(kind, id);
    if (!opts.fromQueue) toast('已儲存', 'success');
    renderAll();
    // 這次只送了一筆；同時還有別的本地修改（例如記帳時順手更新的匯率）就補一次整包儲存
    if (lastSyncedTripJSON && JSON.stringify(trip) !== lastSyncedTripJSON) scheduleCloudSave(0);
  }catch(err){
    // 沒有網路或伺服器沒回應：新增的帳目先存在這台手機上，之後自動補存
    const unreachable = !err.status || err.status >= 500;
    // 伺服器明確拒絕（4xx：權限、行程不存在、格式不對）：重送也不會成功，從待補存清單拿掉並說明
    if (!unreachable && opts.fromQueue){
      removePendingEntry(kind, id);
      toast(`有 1 筆存在這台裝置上的帳目沒辦法補存：${err.message}`, 'error');
    }
    if (unreachable && entry && opts.isNew && addPendingEntry(kind, id, entry)){
      toast(navigator.onLine === false
        ? '目前沒有網路。這筆先存在這台裝置上，連上網路後會自動補存。'
        : '伺服器沒有回應。這筆先存在這台裝置上，稍後會自動補存。', 'info', { duration: 6000 });
    } else if (!opts.fromQueue){
      toast(unreachable
        ? '沒有存到：連不上伺服器。連上網路後，點頁首的「未儲存」再試一次。'
        : `沒有存到：${err.message}`, 'error');
    }
  }finally{
    syncSaving--;
    syncFailed = !ok;
    renderSyncStatus();
  }
  return ok;
}
// 重新抓一次完整行程，跟本地合併（本地還沒存的修改不會被蓋掉）
async function refreshTripFromServer(){
  const url = shareMode ? `/api/shared-trip/${encodeURIComponent(shareMode.token)}` : tripApiUrl();
  const tripIdAtStart = currentTripId, shareAtStart = shareMode;
  const res = await fetch(url, { headers: apiHeaders() });
  const body = await apiJson(res);
  if (currentTripId !== tripIdAtStart || shareMode !== shareAtStart) return; // 等回應時已經換到別的行程，這份不能合併進來
  const merged = mergeWithServer(shareMode ? body.trip : body);
  if (merged) trip = merged;
}

// 🆕 [分享連結] 分享連結模式下的儲存：直接 PUT /api/shared-trip/:token，
// 伺服器會依這個 token 反查對應的行程並驗證權限（唯讀連結送到這裡一樣會被
// 伺服器擋下來，這裡先在前端擋一次純粹是為了不必要地打一次注定失敗的請求、
// 給使用者更直接的提示）。
async function saveSharedTripToApi(){
  if (shareMode.permission !== 'write'){
    toast('這個連結只能看帳，不能修改', 'error');
    return;
  }

  // 🆕 [併發保護] 跟擁有者版本 saveTripToApi() 用同一套機制：帶上
  // expectedUpdatedAt 讓伺服器原子化比對，衝突時合併＋重試，見那邊的
  // 完整說明。分享連結版本先前完全沒有任何併發保護，兩位朋友同時透過
  // 同一個分享連結編輯時特別容易中獎，這裡優先度其實更高。
  const MAX_SAVE_RETRY = 3;

  for (let attempt = 0; attempt < MAX_SAVE_RETRY; attempt++){
    try{
      const sentJSON = JSON.stringify(trip); // 送出的那份，回應回來時拿來判斷這段期間本地又改了什麼
      const payload = Object.assign({}, trip, { expectedUpdatedAt: trip.updatedAt || null, writerId: CLIENT_INSTANCE_ID });
      const res = await fetch(`/api/shared-trip/${encodeURIComponent(shareMode.token)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.status === 409){
        const body = await res.json().catch(()=>({}));
        const serverTrip = body.currentTrip;
        const merged = serverTrip ? mergeWithServer(serverTrip) : null;

        if (!merged){
          toast('其他人剛改過同一筆資料，請重新載入頁面後再改一次。', 'error');
          return;
        }

        trip = merged;
        renderAll();
        if (attempt < MAX_SAVE_RETRY - 1){
          toast('有人剛好也在修改，正在重新儲存…', 'info');
          continue;
        }
        toast('還沒存好，請再按一次「儲存」。', 'error');
        return;
      }

      if (!res.ok){
        const body = await res.json().catch(()=>({}));
        throw new Error(body.error || ('HTTP ' + res.status));
      }
      const data = await res.json();
      applySavedTrip(data.trip, sentJSON);
      toast('已儲存', 'success');
      renderAll();
      return true;
    }catch(err){
      toast('儲存失敗：' + err.message, 'error');
      return;
    }
  }
}

