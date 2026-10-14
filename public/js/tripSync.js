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
    lastSyncedTripJSON = JSON.stringify(trip);
    syncFailed = false;
    editingExpenseId = null; editingDepositId = null;
    expandedExpenseIds.clear(); expandedDepositIds.clear();
    resetListFilters();
    resetOverviewSectionCurrencyState();
    if (!opts.quiet) toast(`已載入「${trip.name}」（成員 ${trip.members.length} 人、支出 ${trip.expenses.length} 筆）`, 'success');
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
function scheduleCloudSave(delay){
  if (!currentTripId && !shareMode) return;
  if (shareMode && shareMode.permission !== 'write') return;
  clearTimeout(cloudSaveTimer);
  cloudSavePending = true;
  cloudSaveTimer = setTimeout(runCloudSave, delay == null ? 300 : delay);
  renderSyncStatus();
}
// 切換行程前呼叫：還在防抖等待中的自動儲存立刻送出，避免換掉 trip 之後改動遺失。
async function flushCloudSave(){
  if (!cloudSavePending) return;
  clearTimeout(cloudSaveTimer);
  await runCloudSave();
}
async function runCloudSave(){
  cloudSavePending = false;
  if (cloudSaveRunning){ cloudSaveQueued = true; return; }
  cloudSaveRunning = true;
  try{ await saveTripToApi(); }
  finally{
    cloudSaveRunning = false;
    if (cloudSaveQueued){ cloudSaveQueued = false; scheduleCloudSave(0); }
  }
}
/* ===================== 頁首同步狀態 ===================== */
// 讓使用者隨時知道資料存了沒：已同步／儲存中／未儲存（點擊重試）／未開啟行程／唯讀。
let syncSaving = 0;       // 進行中的儲存請求數
let syncFailed = false;   // 最近一次儲存沒有成功（失敗、衝突或使用者取消覆蓋）
function renderSyncStatus(){
  const el = document.getElementById('syncStatus');
  if (!el) return;
  let state, label, hint;
  if (shareMode && shareMode.permission !== 'write'){
    state = 'readonly'; label = '唯讀'; hint = '這是唯讀的分享連結，只能看、不能修改';
  } else if (!currentTripId && !shareMode){
    state = 'offline'; label = '未開啟行程'; hint = '還沒開啟任何行程，變更不會被儲存。點此開啟或建立行程';
  } else if (syncSaving > 0 || cloudSavePending){
    state = 'saving'; label = '儲存中…'; hint = '正在把變更存到雲端';
  } else if (syncFailed){
    state = 'error'; label = '未儲存'; hint = '最近一次儲存沒有成功，點此重試';
  } else {
    state = 'saved'; label = '已同步'; hint = '所有變更都已存到雲端';
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
  else if (state === 'error') saveTripToApi();
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
    showMainTab('settings'); showSettingsSub('connect');
    toast(currentUser
      ? '還沒開啟任何行程：請先在「設定 → 帳號」開啟或建立一個行程。'
      : '尚未登入：請先到「設定 → 帳號」用 Discord 登入並開啟行程。', 'error', { duration: 7000 });
    return;
  }

  // 🆕 [併發保護] 最多重試幾次：多人幾乎同時存檔時，即使每次都被伺服器的
  // 原子化版本檢查擋下（409），本地合併後重試一次通常就會成功；重試上限
  // 只是避免理論上的無限迴圈（例如短時間內一直有新的人持續搶著存檔）。
  const MAX_SAVE_RETRY = 3;

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
        if (!lastSyncedTripJSON) {
          // 首次儲存（從未載入過），直接確認
          const proceed = await confirmModal(`確定要用目前畫面上的內容覆蓋雲端行程「${serverTrip.name}」嗎？`, { confirmText:'儲存' });
          if (!proceed) return;
        } else if (serverTrip.updatedAt && trip.updatedAt && serverTrip.updatedAt !== trip.updatedAt) {
          // 伺服器版本比本地版本新，嘗試智慧合併
          const merged = mergeWithServer(serverTrip);
          if (merged) {
            // 合併成功：靜默套用合併結果，不打擾使用者
            trip = merged;
            renderAll();
            toast('已自動合併其他人的更新', 'info');
          } else {
            // 合併失敗（有衝突）：詢問使用者
            const proceed = await confirmModal('這個行程已經被其他人更新過，而且跟你目前的內容有衝突，無法自動合併。確定要用你目前這份覆蓋掉嗎？', { danger:true, confirmText:'仍要覆蓋', title:'偵測到資料衝突' });
            if (!proceed) return;
          }
        } else if (lastSyncedTripJSON && JSON.stringify(serverTrip) !== lastSyncedTripJSON && !serverTrip.updatedAt) {
          // 舊版伺服器（沒有 updatedAt），退回原本的整包比對
          const merged = mergeWithServer(serverTrip);
          if (merged) {
            trip = merged;
            renderAll();
            toast('已自動合併其他人的更新', 'info');
          } else {
            const proceed = await confirmModal('這份行程資料似乎已經被更新過（可能是別人剛存過，或你在別的分頁存過），確定要用你目前這份覆蓋掉嗎？', { danger:true, confirmText:'仍要覆蓋', title:'偵測到資料衝突' });
            if (!proceed) return;
          }
        }
      }
    }catch(e){ /* 檢查失敗就略過，不要因為這個擋住存檔 */ }

    try{
      // 🆕 [併發保護] 把本地目前認定的版本號一併送給伺服器；伺服器會在真正
      // 寫入前原子化比對這個版本號是否仍然等於它「當下」的版本，不一致就
      // 回傳 409，讓下面的重試邏輯接手，而不是悶不吭聲地整包覆蓋。
      const payload = Object.assign({}, trip, { expectedUpdatedAt: trip.updatedAt || null, writerId: CLIENT_INSTANCE_ID });
      const res = await fetch(tripApiUrl(), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
        body: JSON.stringify(payload)
      });

      if (res.status === 409){
        // 真的被別人搶先一步存檔了（上面的預先檢查沒能攔到這個極短的競爭
        // 視窗）：拿伺服器回傳的「當下最新版本」合併，合併成功就重試一次；
        // 合併不了（真衝突）就不再重試，請使用者重新整理頁面。
        const body = await res.json().catch(()=>({}));
        const serverTrip = body.currentTrip;
        const merged = serverTrip ? mergeWithServer(serverTrip) : null;

        if (!merged){
          toast('儲存失敗：資料版本衝突且無法自動合併，請重新整理頁面後再試一次。', 'error');
          return;
        }

        trip = merged;
        renderAll();
        if (attempt < MAX_SAVE_RETRY - 1){
          toast('儲存時發現有人剛好搶先一步更新，已自動合併並重新儲存…', 'info');
          continue; // 用合併後的版本再跑一次迴圈重新存一次
        }
        toast('已自動合併其他人的更新，但重試次數已用完，請再按一次「儲存」把合併後的結果存回去。', 'error');
        return;
      }

      if (!res.ok){
        const body = await res.json().catch(()=>({}));
        throw new Error(body.error || ('HTTP ' + res.status));
      }
      const savedData = await res.json();
      trip = repairTrip(savedData); // 用伺服器回傳的版本（含最新 updatedAt）更新本地
      lastSyncedTripJSON = JSON.stringify(trip);
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
async function syncEntry(kind, id, entry, opts){
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
    toast('已儲存', 'success');
    renderAll();
    // 這次只送了一筆；同時還有別的本地修改（例如記帳時順手更新的匯率）就補一次整包儲存
    if (lastSyncedTripJSON && JSON.stringify(trip) !== lastSyncedTripJSON) scheduleCloudSave(0);
  }catch(err){
    toast('儲存失敗：' + err.message + '（點頁首的「未儲存」可以重試）', 'error');
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
  const res = await fetch(url, { headers: apiHeaders() });
  const body = await apiJson(res);
  const merged = mergeWithServer(shareMode ? body.trip : body);
  if (merged) trip = merged;
}

// 🆕 [分享連結] 分享連結模式下的儲存：直接 PUT /api/shared-trip/:token，
// 伺服器會依這個 token 反查對應的行程並驗證權限（唯讀連結送到這裡一樣會被
// 伺服器擋下來，這裡先在前端擋一次純粹是為了不必要地打一次注定失敗的請求、
// 給使用者更直接的提示）。
async function saveSharedTripToApi(){
  if (shareMode.permission !== 'write'){
    toast('這個分享連結是唯讀的，無法儲存變更。', 'error');
    return;
  }

  // 🆕 [併發保護] 跟擁有者版本 saveTripToApi() 用同一套機制：帶上
  // expectedUpdatedAt 讓伺服器原子化比對，衝突時合併＋重試，見那邊的
  // 完整說明。分享連結版本先前完全沒有任何併發保護，兩位朋友同時透過
  // 同一個分享連結編輯時特別容易中獎，這裡優先度其實更高。
  const MAX_SAVE_RETRY = 3;

  for (let attempt = 0; attempt < MAX_SAVE_RETRY; attempt++){
    try{
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
          toast('儲存失敗：資料版本衝突且無法自動合併，請重新整理頁面後再試一次。', 'error');
          return;
        }

        trip = merged;
        renderAll();
        if (attempt < MAX_SAVE_RETRY - 1){
          toast('儲存時發現有人剛好搶先一步更新，已自動合併並重新儲存…', 'info');
          continue;
        }
        toast('已自動合併其他人的更新，但重試次數已用完，請再按一次「儲存」把合併後的結果存回去。', 'error');
        return;
      }

      if (!res.ok){
        const body = await res.json().catch(()=>({}));
        throw new Error(body.error || ('HTTP ' + res.status));
      }
      const data = await res.json();
      trip = repairTrip(data.trip);
      lastSyncedTripJSON = JSON.stringify(trip);
      toast('已儲存', 'success');
      renderAll();
      return true;
    }catch(err){
      toast('儲存失敗：' + err.message, 'error');
      return;
    }
  }
}

