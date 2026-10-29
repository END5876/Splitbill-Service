'use strict';
// 多人協作即時同步：SSE 連線建立/斷線/重連，以及收到推播時的合併或提示邏輯。
/* =====================================================================
   🆕 [即時同步] 多人協作：SSE（Server-Sent Events）即時推播
   ---------------------------------------------------------------------
   任何人（webui 存檔、或 Discord 面板操作）異動這個行程時，伺服器都會
   把最新的行程資料推播到這裡。設計原則：
   - Discord 登入：直接開 SSE，瀏覽器會自動帶上登入 cookie。
   - 連線中斷時一律自己重新連線，不依賴瀏覽器內建的自動重連。
   - 分享連結模式：沿用既有設計，token 本身就是路徑上的憑證，不需換票。
   - 收到推播時：若使用者目前沒有正在編輯中的表單/認領流程，直接套用
     並重繪；若有，先嘗試用既有的 tryMergeTrips() 自動合併，合併不了
     （極少發生）才用 toast 提醒使用者手動處理，不會無聲蓋掉正在輸入的
     內容。
===================================================================== */
let tripEventSource = null;
let tripEventReconnectTimer = null;
// 斷線期間伺服器推播的更新不會補送，重新連上後要自己抓一次最新版本
let tripEventNeedsResync = false;
// 連續連不上的次數：用來拉長重連間隔，並在連不上時查一下行程是不是已經刪除／沒權限了
let tripEventFailures = 0;

// 🆕 [即時同步] 這個分頁自己的識別碼，存檔時會附帶送給伺服器，SSE 推播回來
// 時原封不動夾帶在裡面。用這個「明確標記」而不是比較 updatedAt 時間先後，
// 是因為存檔的 PUT 回應跟 SSE 推播走的是兩條獨立連線，SSE 那筆事件常常會
// 比自己 PUT 的 fetch() Promise 更早被處理完——那時候本地 trip.updatedAt
// 都還沒更新成新版本，用時間戳記比較會誤判成「別人更新的」，導致操作者
// 本人也會看到「偵測到其他人更新」的提示。每次重新整理頁面就會換一組新的
// （不需要跨分頁/跨次重新整理持久化，純粹只是「這次連線是不是我發出去的」）。
const CLIENT_INSTANCE_ID = genId('client');

function disconnectTripEventStream(){
  clearTimeout(tripEventReconnectTimer);
  tripEventReconnectTimer = null;
  if (tripEventSource){
    tripEventSource.close();
    tripEventSource = null;
  }
}

async function connectTripEventStream(opts){
  disconnectTripEventStream();
  if (!opts || !opts.retry) tripEventFailures = 0; // 換行程／重新開啟時從頭計算，不沿用上一個行程的退避
  try{
    let url;
    if (shareMode){
      url = `/api/shared-trip/${encodeURIComponent(shareMode.token)}/events`;
    } else {
      if (!currentTripId) return; // 尚未開啟任何雲端行程，之後 loadTripFromApi() 成功時會再呼叫一次
      // Discord 登入：EventSource 對同源網址會自動帶 cookie，不需要換票
      url = tripApiUrl('/events');
    }

    const es = new EventSource(url);
    tripEventSource = es;

    // 伺服器每次建立新連線都會先送 connected；是斷線重連的話補抓一次斷線期間漏掉的更新
    es.addEventListener('connected', () => {
      tripEventFailures = 0;
      if (!tripEventNeedsResync) return;
      tripEventNeedsResync = false;
      resyncTripAfterReconnect();
    });

    es.addEventListener('trip-updated', (evt) => {
      try{
        const envelope = JSON.parse(evt.data);
        // 🆕 [即時同步] 這筆推播就是「我自己剛存的」：writerId 完全比對，
        // 不看時間戳記，避免 SSE 推播先於自己 PUT 回應抵達造成的誤判
        // （見上面 CLIENT_INSTANCE_ID 宣告處的說明）。
        if (envelope && envelope.writerId && envelope.writerId === CLIENT_INSTANCE_ID) return;
        handleIncomingTripUpdate(envelope && envelope.trip ? envelope.trip : envelope);
      }catch(e){ /* 忽略解析失敗的單一事件 */ }
    });

    // 🆕 [即時同步] 行程被刪除（例如在 Discord 面板按了「刪除此行程」）：
    // 伺服器送完這個事件後會直接關閉連線，這裡主動斷線＋提醒使用者，
    // 不要再嘗試自動重連（trip 已經不存在，重連只會一直拿到 404）。
    es.addEventListener('trip-deleted', () => {
      handleIncomingTripDeleted();
    });

    // 🔒 已經沒有讀取權限了（連結被撤銷／過期、被移出行程、已登出）：伺服器送完這個
    // 事件就關閉連線，這裡同樣不要自動重連。
    es.addEventListener('access-revoked', () => {
      handleTripAccessRevoked();
    });

    // 🆕 [多人協作] 帳單辨識認領進度：有人更新了認領狀態（勾選/取消勾選、
    // 修改品項等）就會收到這個事件；如果自己也正在同一份協作裡，直接套用
    // 最新狀態；如果自己還沒加入，只更新「有人正在辨識中」的提示。
    es.addEventListener('receipt-session-updated', (evt) => {
      try{
        const payload = JSON.parse(evt.data);
        if (payload && payload.writerId && payload.writerId === CLIENT_INSTANCE_ID) return; // 自己剛推播的回音
        if (typeof receiptSessionJoined !== 'undefined' && receiptSessionJoined){
          // 照片沒變時伺服器不會夾帶（省流量），沿用手上這張
          const prevImage = receiptState && receiptState.imageDataUrl;
          // 說明／付款人／幣別只存在本地表單（receiptSetField 不會推播），
          // 套用別人的狀態時要保留自己填的，否則會被對方的空值蓋回預設
          const prevLocal = receiptState;
          receiptState = payload.state;
          if (receiptState && receiptState.imageDataUrl === undefined && prevImage) receiptState.imageDataUrl = prevImage;
          if (receiptState && prevLocal){
            for (const field of ['description', 'payerId', 'currency']) receiptState[field] = prevLocal[field];
          }
          receiptSessionImageOnServer = (receiptState && receiptState.imageDataUrl) || null;
          renderReceiptWorkArea();
        } else if (typeof receiptSessionAnnounceUpdate === 'function') {
          receiptSessionAnnounceUpdate(payload.updatedAt);
        }
      }catch(e){ /* 忽略解析失敗的單一事件 */ }
    });

    // 🆕 [Bug fix] 這次的帳單辨識協作已經結束（帳單已建立成支出，或被取消）。
    // 過去這裡只把 receiptSessionJoined 這個旗標設回 false，畫面上的認領
    // 表單、品項清單、「建立這筆支出」按鈕卻完全沒有跟著關閉——導致還沒
    // 收到通知前就已經打開這頁的人，即使協作其實已經結束，依然可以照樣
    // 按下「建立這筆支出」，用自己手上那份（其實已經失效）的資料再送出
    // 一次，變成同一張帳單被重複記帳兩筆。現在改成直接呼叫
    // receiptResetUpload()：只對「真的還在這場協作裡」的分頁生效（本人
    // 剛送出的那個分頁已經在 finalizeReceiptExpense() 裡自行 reset 過，
    // receiptSessionJoined 這時已經是 false，不會重複顯示提示或誤觸）。
    es.addEventListener('receipt-session-cleared', (evt) => {
      let reason = null;
      try{ reason = (JSON.parse(evt.data) || {}).reason; }catch(e){ /* 忽略解析失敗，退回通用訊息 */ }
      if (typeof receiptSessionJoined !== 'undefined' && receiptSessionJoined){
        if (typeof receiptResetUpload === 'function') receiptResetUpload();
        // 🆕 依實際結束原因給出對應的訊息，而不是一句語意含糊的「可能已經…」
        const msg = reason === 'finalized'
          ? '這次帳單辨識協作已經結束了：已經有人建立成支出，畫面已自動關閉'
          : reason === 'abandoned'
          ? '這次帳單辨識協作已經被結束（放棄），沒有建立任何支出'
          : '這次帳單辨識協作已經結束了（可能已經建立成支出，或發起人已取消），請重新掃描或確認結果';
        toast(msg, 'info');
      }
      if (typeof receiptSessionAnnounceCleared === 'function') receiptSessionAnnounceCleared();
    });

    es.onerror = () => {
      // 連線中斷：關閉舊連線，稍等一下用「新換的票券」重新連線，
      // 不讓瀏覽器用同一個（已失效的一次性票券）網址自動重試。
      es.close();
      if (tripEventSource === es) tripEventSource = null;
      tripEventNeedsResync = true;
      clearTimeout(tripEventReconnectTimer);
      tripEventReconnectTimer = null;
      // 連不上時（404／403／429 等）EventSource 看不到狀態碼，固定 3 秒重試會永遠打下去：
      // 改成指數退避（3 秒起跳、最長 60 秒），連續失敗時另外查一次行程本身的狀態
      tripEventFailures++;
      const delay = Math.min(3000 * 2 ** (tripEventFailures - 1), 60000);
      const scheduleRetry = () => {
        tripEventReconnectTimer = setTimeout(() => connectTripEventStream({ retry: true }), delay);
      };
      // 第一次失敗多半只是網路閃斷或伺服器重啟，直接重連；連續失敗才查狀態
      if (tripEventFailures < 2){ scheduleRetry(); return; }
      probeTripAfterStreamFailure().then(stop => { if (!stop) scheduleRetry(); });
    };
  }catch(e){
    // 即時同步屬於錦上添花的功能，換票或建立連線失敗都不應該擋住其他既有功能運作
  }
}

// SSE 連續連不上時查一次行程本身：已刪除或沒有權限了就交給對應的處理函式，不再重連。
// 回傳 true 代表不要再排重連（已經處理掉，或等回應時已經換行程／重新連線了）。
async function probeTripAfterStreamFailure(){
  if (!shareMode && !currentTripId) return true;
  const url = shareMode ? `/api/shared-trip/${encodeURIComponent(shareMode.token)}` : tripApiUrl();
  const tripIdAtStart = currentTripId, shareAtStart = shareMode;
  let status;
  try{
    status = (await fetch(url, { headers: apiHeaders() })).status;
  }catch(e){ return false; } // 網路本身不通：照常退避重連
  if (currentTripId !== tripIdAtStart || shareMode !== shareAtStart || tripEventSource || tripEventReconnectTimer) return true;
  if (shareMode){
    // 分享連結：404＝連結被撤銷或行程已刪除，403＝連結過期或不再開放訪客
    if (status === 404 || status === 403){ handleTripAccessRevoked(); return true; }
    return false;
  }
  if (status === 404){ handleIncomingTripDeleted(); return true; }
  if (status === 403){ handleTripAccessRevoked(); return true; }
  return false; // 401（登入過期）、429、5xx 等：繼續退避重連
}

// 重連後補同步：refreshTripFromServer 走三方合併，本地還沒存的修改不會被蓋掉
async function resyncTripAfterReconnect(){
  try{
    await refreshTripFromServer();
    renderAll();
  }catch(e){ /* 補抓失敗就算了，下一次推播或自己存檔時還會再合併 */ }
  if (typeof checkReceiptSessionAvailability === 'function') checkReceiptSessionAvailability();
}

function handleIncomingTripUpdate(rawPushedTrip){
  const pushedTrip = repairTrip(rawPushedTrip);

  // Echo 抑制：如果推播來的版本並沒有比我們現在手上的新，代表這通常是
  // 我們自己剛存檔造成的那次廣播，或是一則過期的訊息，直接忽略即可。
  if (trip.updatedAt && pushedTrip.updatedAt && pushedTrip.updatedAt <= trip.updatedAt) return;

  // 一律做三方合併（見 js/tripSync.js 的 tryMergeTrips）：本地沒有未儲存的修改時，
  // 結果就等於伺服器的版本；有的話（表單填到一半、設定還在防抖等待中…）會保留下來，
  // 不會被無聲蓋掉，之後照常存回去。
  const hadLocalChanges = !!lastSyncedTripJSON && JSON.stringify(trip) !== lastSyncedTripJSON;
  const merged = mergeWithServer(pushedTrip);
  if (!merged){
    toast('其他人剛更新了這個行程，但無法自動合併，請儘快儲存或重新整理頁面取得最新版本', 'error');
    return;
  }
  trip = merged;
  renderAll();
  if (lastMergeConflicts) toast(`其他人剛更新了這個行程，其中 ${lastMergeConflicts} 筆跟你還沒儲存的修改衝突，暫時以你的版本為準`, 'error', { duration: 7000 });
  else toast(hadLocalChanges ? '已自動合併其他人剛剛的更新' : '偵測到其他人更新了這個行程，畫面已同步', 'info');
}

// 🆕 [即時同步] 行程被刪除時的處理：訪客模式下這個 token 本身也已經
// 跟著行程一起消失了（連結是存在 trip 物件裡的），直接沿用既有的
// 「連結失效」全頁提示；一般模式下用醒目、不會自動消失太快的 toast 提醒，
// 並刷新「我的行程」清單。
function handleIncomingTripDeleted(){
  disconnectTripEventStream();
  if (shareMode){
    showLinkError('這個行程已經被刪除了，連結也跟著失效。');
    return;
  }
  // 刪除後畫面清空，帶回「我的行程」讓使用者換一個行程開
  const deletedName = trip.name;
  currentTripId = null;
  clearOwnerConnectionState();
  trip = defaultTrip();
  lastSyncedTripJSON = null;
  renderAll();
  showMainTab('settings'); showSettingsSub('account');
  toast(`「${deletedName}」已經在別處被刪除了。請從「我的行程」開啟其他行程，或建立新的。`, 'error', { duration: 10000 });
  refreshTripList({ silent: true }).catch(()=>{});
}

function handleTripAccessRevoked(){
  disconnectTripEventStream();
  if (shareMode){
    showLinkError('這個連結已經被撤銷、過期，或不再開放訪客使用，請跟建立連結的人索取新的連結。');
    return;
  }
  const name = trip.name;
  currentTripId = null;
  clearOwnerConnectionState();
  trip = defaultTrip();
  lastSyncedTripJSON = null;
  renderAll();
  showMainTab('settings'); showSettingsSub('account');
  toast(`你已經沒有「${name}」的存取權（可能被移出行程或解除了 Discord 連結）。`, 'error', { duration: 10000 });
  refreshTripList({ silent: true }).catch(()=>{});
}

