'use strict';
// 🆕 [PWA] Service Worker：讓拆帳本可以「加到主畫面」當 App 開，並在網路不穩時先顯示畫面。
//
// 快取原則（帳務資料一律以伺服器為準，不做離線記帳）：
//   - /api/、/auth/、/healthz、SSE：完全不經過這裡，直接走網路（不快取、不攔截）
//   - 頁面本身（/）：先走網路，拿到就更新快取；連不上才用上次的版本
//   - 帶 ?v=<雜湊> 的 css／js：內容永遠不變，有快取就直接用
//   - 其他同站靜態檔（icon、manifest）：先回快取，背景再更新
//
// SW_VERSION 由伺服器在送出這個檔案時填入（index.html＋css／js 的內容雜湊），
// 每次部署有改到前端檔案，這個檔案內容就會變，瀏覽器會安裝新版並清掉舊快取。
const SW_VERSION = '__SW_VERSION__';
const CACHE_NAME = `splitbill-${SW_VERSION}`;
const SHELL_URL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.add(new Request(SHELL_URL, { cache: 'reload' })))
      .catch(() => {}) // 預先快取失敗（例如剛好斷線）不影響安裝，之後開頁面時會補上
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('splitbill-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isBypassed(url){
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')
    || url.pathname === '/healthz' || url.pathname === '/sw.js';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isBypassed(url)) return;
  if (req.headers.get('accept') === 'text/event-stream') return;

  // 頁面：先走網路；網址的 #link= 不會送到這裡，所有頁面請求都對應同一份 index.html
  if (req.mode === 'navigate'){
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && (url.pathname === '/' || url.pathname === '/index.html')){
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(SHELL_URL, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(SHELL_URL).then((cached) => cached || Response.error()))
    );
    return;
  }

  // 帶版本雜湊的資源：內容不會變，快取優先
  if (url.searchParams.has('v')){
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        if (res.ok){
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // 其他靜態檔：先回快取，背景更新
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res.ok){
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      });
      if (cached){
        network.catch(() => {});
        return cached;
      }
      return network;
    })
  );
});
