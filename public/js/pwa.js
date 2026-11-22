'use strict';
// 🆕 [PWA] 註冊 Service Worker（見 /sw.js），讓手機可以把裊器分帳「加到主畫面」當 App 開。
// 不支援或註冊失敗都不影響網頁本身的功能。
if ('serviceWorker' in navigator && window.isSecureContext){
  // 打開頁面時已經有舊版在控制，之後換成新版（新的 sw.js 會 skipWaiting＋claim）＝有新版本
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // 第一次安裝，不是更新
    showUpdateBannerIfBehind();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}
// 新的 Service Worker 接手不代表這頁過期：頁面是網路優先載入的，多半已經是新版。
// 伺服器把同一個版本號放在頁面的 meta 和 /sw.js 的回應標頭（/sw.js 不經過 Service Worker），不一樣才顯示「有新版本」
async function showUpdateBannerIfBehind(){
  const mine = (document.querySelector('meta[name="app-version"]') || {}).content || '';
  try{
    const latest = (await fetch('/sw.js', { method: 'HEAD', cache: 'no-store' })).headers.get('X-App-Version');
    if (latest && mine && latest === mine) return;
  }catch(e){ /* 查不到就照舊提示 */ }
  const el = document.getElementById('updateBanner');
  if (el) el.hidden = false;
}
// 「重新載入」：還有東西沒存到（存檔失敗、正在送出、表單填到一半）時先問
async function reloadForUpdate(){
  if (hasUnsavedWork() && !await confirmModal('有內容還沒存到，重新載入後就不見了。可以先儲存或等存好再重新載入。',
    { title:'現在重新載入？', confirmText:'仍要重新載入', cancelText:'先不要', danger:true })) return;
  location.reload();
}
