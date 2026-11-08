'use strict';
// 🆕 [PWA] 註冊 Service Worker（見 /sw.js），讓手機可以把裊器分帳「加到主畫面」當 App 開。
// 不支援或註冊失敗都不影響網頁本身的功能。
if ('serviceWorker' in navigator && window.isSecureContext){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}
