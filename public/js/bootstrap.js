'use strict';
// 頁面載入時的啟動流程：分享連結 → 邀請連結 → 一般（Discord 登入／管理員金鑰／本機）。
/* init */
window.addEventListener('beforeunload', disconnectTripEventStream); // 🆕 [即時同步] 離開頁面時主動關閉 SSE 連線，讓伺服器能立即釋放資源
initFsApiUi();
renderAll();

// 🆕 [行程獨立化] 一般模式的啟動流程：
//   1. 網址帶 #apiKey=...（管理員書籤）→ 直接用金鑰連線
//   2. 記得上次開的行程 → 安靜地接回去
//   3. 已登入 → 開啟最近更新的行程；一個都沒有就帶到「建立行程」
//   4. 沒登入 → 顯示登入畫面（沒開 Discord 登入時顯示原本的「無權限」說明）
async function bootstrapNormal(){
  const usedUrlParams = await applyUrlParams();
  if (usedUrlParams) return;
  const restored = await restoreOwnerConnectionState();
  if (restored) return;
  if (currentUser){
    try{
      await refreshTripList({ silent: true });
    }catch(e){ /* 清單讀不到就停在空白狀態，不擋住使用 */ }
    if (myTrips.length){
      document.getElementById('tripSelect').value = myTrips[0].id;
      await loadTripFromApi({ quiet: true });
    } else {
      showMainTab('settings'); showSettingsSub('connect');
      toast('歡迎！先建立你的第一個行程吧', 'info');
    }
    updateBotStatusPill(isConnected(), isConnected() ? trip.name : null);
    return;
  }
  showNoAccessScreen();
}

(async function init(){
  // 🆕 [分享連結] 分享連結模式優先：一個分頁只會是「擁有者」或「分享連結訪客」其中
  // 一種身分。網址 hash 裡的 token（剛點連結進來）優先；沒有的話看這個分頁的
  // sessionStorage 裡有沒有「重新整理前」還在用的 token。
  const shareToken = detectShareTokenFromUrl() || getPersistedShareToken();
  if (shareToken){
    initShareMode(shareToken);
    return;
  }
  await fetchMe();
  // 🆕 [成員邀請] 邀請連結：顯示「你是哪一位」，認領後直接開啟該行程
  const inviteToken = detectInviteTokenFromUrl();
  if (inviteToken){
    initInviteFlow(inviteToken);
    return;
  }
  await bootstrapNormal();
})();
