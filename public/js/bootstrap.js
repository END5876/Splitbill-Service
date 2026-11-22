'use strict';
// 頁面載入時的啟動流程：resolveEntry() 判斷這個分頁該進入哪一種狀態，applyEntry() 畫出來。
/* init */
// 頁首（sticky）的實際高度：行程名稱換行、字放大時會變高。給 CSS 的 --header-h 用，
// 讓設定子分頁、桌機的表單欄固定在頁首正下方，不會被蓋住
(() => {
  const header = document.getElementById('appHeader');
  if (!header || !('ResizeObserver' in window)) return;
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
  }).observe(header);
})();
window.addEventListener('beforeunload', disconnectTripEventStream); // 🆕 [即時同步] 離開頁面時主動關閉 SSE 連線，讓伺服器能立即釋放資源
document.getElementById('expDate').value = toDateInputValue(Date.now());
document.getElementById('depDate').value = toDateInputValue(Date.now());
renderAll();

/**
 * 🆕 [行程連結] 唯一的入口判斷。網址只有兩種：帶連結 token（#link=，舊版 #share=／#invite=
 * 也算）或什麼都不帶；身分只有兩種：Discord 登入或沒登入。組合起來的結果：
 *   { kind: 'member', tripId }       我已經是這個行程的成員 → 用自己的身分開啟
 *   { kind: 'join', token, info }    連結允許加入 → 顯示登入／「我是哪一位」畫面
 *   { kind: 'guest', token }         以訪客身分開啟（連結的訪客權限）
 *   { kind: 'error', message }       連結失效或連不上
 *   { kind: 'home' }                 沒帶連結 → 已登入開我的行程，沒登入顯示登入畫面
 */
async function resolveEntry(){
  const token = takeLinkTokenFromUrl() || getPersistedLinkToken();
  await fetchMe();
  if (meUnreachable) return { kind: 'offline' };
  if (!token) return { kind: 'home' };

  let info;
  try{
    info = await apiJson(await fetch(`/api/link/${encodeURIComponent(token)}`));
  }catch(err){
    return { kind: 'error', message: err.status ? err.message : '連線時發生問題，請確認網路連線後重新整理頁面看看。' };
  }
  if (info.tripId) return { kind: 'member', tripId: info.tripId };
  const canGuest = info.guest !== 'none';
  // 連結允許加入、而且還有機會加入（有開登入、這個分頁沒選過「以訪客開啟」）時，先問要不要加入
  const offerJoin = info.join && (oauthEnabled || currentUser) && !(canGuest && hasChosenGuest());
  if (offerJoin) return { kind: 'join', token, info };
  if (canGuest) return { kind: 'guest', token };
  return { kind: 'join', token, info }; // 只能加入但網站沒開登入：加入畫面會說明原因
}

async function applyEntry(entry){
  switch (entry.kind){
    case 'member':
      clearLinkToken();
      await openTripAsMember(entry.tripId);
      return;
    case 'join':
      showJoinScreen(entry.token, entry.info);
      return;
    case 'guest':
      await initGuestMode(entry.token);
      return;
    case 'error':
      showLinkError(entry.message);
      return;
    case 'offline':
      showOfflineScreen();
      return;
    default:
      await bootstrapHome();
  }
}

// 一般首頁：
//   1. 記得上次開的行程 → 安靜地接回去
//   2. 已登入 → 開啟最近更新的行程；一個都沒有就帶到「建立行程」
//   3. 沒登入 → 顯示登入畫面（沒開 Discord 登入時顯示原本的「無權限」說明）
async function bootstrapHome(){
  discardLegacyApiKeyHash();
  const restored = await restoreOwnerConnectionState();
  if (restored) return;
  if (currentUser){
    try{
      await refreshTripList({ silent: true });
    }catch(e){ /* 清單讀不到就停在空白狀態，不擋住使用 */ }
    if (myTrips.length){
      await loadTripFromApi({ quiet: true, tripId: myTrips[0].id });
    } else {
      showMainTab('settings'); showSettingsSub('trips');
      toast('歡迎！先建立你的第一個行程吧', 'info');
    }
    renderSyncStatus();
    return;
  }
  showNoAccessScreen();
}

// 以成員身分開啟指定的行程（從連結進來、或剛認領完成員）
async function openTripAsMember(tripId){
  try{ await refreshTripList({ silent: true }); }catch(e){ /* 清單讀不到不影響直接開啟 */ }
  await loadTripFromApi({ tripId });
  if (isConnected()) showMainTab('overview');
  else { showMainTab('settings'); showSettingsSub('connect'); }
}

// 返回鍵：填到一半的支出／轉帳表單，按返回先問要不要放棄（js/backStack.js）
guardFormOnBack({
  formId: 'expenseFormCard', layer: 'expenseForm', isDirty: isExpenseFormDirty, reset: resetExpenseForm,
  title: '放棄這筆支出？', message: '剛剛填的內容還沒儲存，離開後就不見了。',
});
guardFormOnBack({
  formId: 'depositFormCard', layer: 'depositForm', isDirty: isDepositFormDirty, reset: resetDepositForm,
  title: '放棄這筆轉帳？', message: '剛剛填的內容還沒儲存，離開後就不見了。',
});
// 還有東西沒存到（存檔失敗、正在送出、表單填到一半）時，關掉或重新整理前先提醒
window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedWork()){ e.preventDefault(); e.returnValue = ''; }
});
// 連上網路後自動補存還沒存到的帳目
window.addEventListener('online', () => flushPendingEntries(false));

(async function init(){
  const bindConfirm = showLoginResultFromUrl();
  await applyEntry(await resolveEntry());
  if (bindConfirm && currentUser) await showAccountLinkConfirm();
})();
