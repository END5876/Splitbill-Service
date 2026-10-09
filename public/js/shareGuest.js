'use strict';
// 🆕 [分享連結] 訪客端偵測與載入分享模式；另含「複製一鍵連線書籤網址」等擁有者端小工具，沿用原始檔案的相鄰順序。
/* ===================== 🆕 [分享連結] 訪客端：偵測與載入分享模式 ===================== */

// 用來把分享連結的 token 暫存在這個分頁的 sessionStorage 裡，讓「重新整理
// 頁面」後可以繼續留在同一個行程，不用回頭跟建立連結的人再要一次網址。
// 特意用 sessionStorage（分頁/瀏覽器關閉就清除）而不是 localStorage
// （會一直留著直到手動清除）：分享連結是要交給別人用的憑證，關掉分頁後
// 不留痕跡比較保守安全；重新整理頁面（同一個分頁）則完全不受影響。
const SHARE_TOKEN_STORAGE_KEY = 'splitbill-share-token';

// 從網址的 hash 讀出 #share=<token>，讀到後立刻清掉網址列（見函式內註解），
// 並存進 sessionStorage 供重新整理頁面時取用。用 hash 而不是 query string
// 的理由跟 buildShareUrl() 一致：hash 從來不會被送到伺服器，對外洩露面最小。
function detectShareTokenFromUrl(){
  const hash = location.hash || '';
  const match = hash.match(/^#share=(.+)$/);
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  // 讀到就立刻清掉網址列的 hash：避免這組憑證繼續留在網址列／瀏覽器歷史
  // 紀錄／之後使用者複製網址分享出去時被夾帶。用 replaceState 而不是
  // location.hash='' 是因為後者會留下一個多餘的瀏覽器歷史紀錄項目。
  history.replaceState(null, '', location.pathname + location.search);
  try{ sessionStorage.setItem(SHARE_TOKEN_STORAGE_KEY, token); }catch(e){}
  return token;
}
// 重新整理頁面後，網址列的 hash 已經在上次載入時被清掉了，改從
// sessionStorage 撈回上一次還在用的 token。
function getPersistedShareToken(){
  try{ return sessionStorage.getItem(SHARE_TOKEN_STORAGE_KEY); }catch(e){ return null; }
}
function clearPersistedShareToken(){
  try{ sessionStorage.removeItem(SHARE_TOKEN_STORAGE_KEY); }catch(e){}
}

function applyShareModeUI(){
  document.body.classList.add('share-mode');
  if (shareMode.permission !== 'write') document.body.classList.add('share-readonly');



  // 唯讀模式下，行程名稱／幣別這兩個「看似可編輯」的欄位改成唯讀展示，
  // 避免朋友以為改了會生效（實際上就算改了，儲存也會被伺服器擋下來，
  // 這裡純粹是不要讓介面看起來「可以改」造成誤會）。
  if (shareMode.permission !== 'write'){
    document.getElementById('tripName').readOnly = true;
  }
}

function showShareError(message){
  // 連結本身已經失效／被撤銷／網址有誤，繼續留著 sessionStorage 裡的 token
  // 只會讓下次重新整理頁面時又跑一次一樣的失敗流程，直接清掉。
  clearPersistedShareToken();
  document.getElementById('appHeader').style.display = 'none';
  document.getElementById('topNav').style.display = 'none';
  document.getElementById('bottomNav').style.display = 'none';
  document.querySelector('main.wrap').style.display = 'none';
  const el = document.getElementById('shareErrorScreen');
  el.innerHTML = `
    <div class="ic">😕</div>
    <h1>這個連結打不開</h1>
    <p>${escapeHtml(message)}</p>
    <p style="margin-top:14px;">可以請建立這個連結的人再傳一組新的給你。</p>
  `;
  el.style.display = 'block';
}

// 🆕 [Discord 登入] 沒有登入、也不是分享連結時顯示的全頁畫面。
// 有開啟 Discord 登入時提供登入按鈕；沒有的話維持原本「請索取分享連結」的說明。
function showNoAccessScreen(){
  const el = document.getElementById('noAccessScreen');
  el.innerHTML = oauthEnabled ? `
    <div class="no-access-card">
      <div class="no-access-brand">拆帳本</div>
      <h1>跟朋友一起記帳、結算</h1>
      <div class="no-access-divider"></div>
      <p>用 Discord 帳號登入，就能建立自己的行程、邀請朋友一起記帳；<br>之後也可以綁定到 Discord 伺服器，用 Mousebot 的面板操作。</p>
      <button class="btn btn-brass no-access-login" type="button" onclick="loginWithDiscord()">用 Discord 登入</button>
      <p class="no-access-note">只會讀取你的 Discord 名稱與頭像。<br>朋友傳給你的是分享連結的話，直接點開那個連結即可，不需要登入。</p>
      <button class="btn btn-ghost btn-sm" type="button" onclick="hideNoAccessScreen(); showMainTab('settings'); showSettingsSub('io');">不登入，先用本機檔案記帳</button>
    </div>
  ` : `
    <div class="no-access-card">
      <svg class="no-access-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      <h1>無權限存取</h1>
      <div class="no-access-divider"></div>
      <p>請向行程主人索取分享連結，<br>才能檢視此頁面。</p>
    </div>
  `;
  el.classList.add('visible');
  setMainUiVisible(false);
}
function hideNoAccessScreen(){
  const el = document.getElementById('noAccessScreen');
  el.classList.remove('visible');
  el.innerHTML = '';
  setMainUiVisible(true);
}
function setMainUiVisible(visible){
  const display = visible ? '' : 'none';
  document.getElementById('appHeader').style.display = display;
  const topNav = document.getElementById('topNav');
  if (topNav) topNav.style.display = display;
  const bottomNav = document.getElementById('bottomNav');
  if (bottomNav) bottomNav.style.display = display;
  const mainEl = document.querySelector('main.wrap');
  if (mainEl) mainEl.style.display = display;
}

async function initShareMode(token){
  try{
    const res = await fetch(`${apiBaseUrl()}/api/shared-trip/${encodeURIComponent(token)}`);
    if (!res.ok){
      const body = await res.json().catch(()=>({}));
      const msg = res.status === 403
        ? (body.error || '這個連結已經過期或被撤銷了。')
        : '找不到這個分享連結，網址可能有誤。';
      showShareError(msg);
      return;
    }
    const data = await res.json();
    trip = repairTrip(data.trip);
    lastSyncedTripJSON = JSON.stringify(trip);
    shareMode = { token, permission: data.permission === 'write' ? 'write' : 'read' };
    applyShareModeUI();
    editingExpenseId = null; editingDepositId = null;
    expandedExpenseIds.clear(); expandedDepositIds.clear();
    resetListFilters();
    renderAll();
    connectTripEventStream();
    if (shareMode.permission === 'write') checkReceiptSessionAvailability(); // 🆕 [多人協作] 唯讀訪客不需要看到「加入認領」的提示
    // 🆕 帳單辨識是寫入功能，唯讀分享連結本來就看不到那個區塊，沒必要問
    if (!receiptState && shareMode.permission === 'write') maybeOfferReceiptDraftRestore();
  }catch(err){
    showShareError('連線時發生問題，請確認網路連線後重新整理頁面看看。');
  }
}

// 把「管理員金鑰＋目前行程」組成一個網址，存成瀏覽器書籤後點一下就能自動
// 帶入金鑰並載入該行程。只給管理員金鑰模式用——用 Discord 登入的話，直接
// 開網站就會自動接回上次的行程，不需要書籤。
// 🔒 金鑰放在 URL 的 hash（# 之後）而不是 query string：hash 不會被送到伺服器、
// 不會留在存取紀錄、也不會被 Referrer 帶到第三方（跟 buildShareUrl() 一致）。
function buildBookmarkUrl(){
  const apiKey = document.getElementById('apiKey').value.trim();
  const apiBaseVal = document.getElementById('apiBase').value.trim();
  const url = new URL(apiBaseVal || location.href);
  url.search = '';
  const hashParams = new URLSearchParams();
  if (apiKey) hashParams.set('apiKey', apiKey);
  if (apiBaseVal) hashParams.set('apiBase', apiBaseVal);
  if (currentTripId) hashParams.set('trip', currentTripId);
  url.hash = hashParams.toString();
  return url.toString();
}
function copyBookmarkUrl(){
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey){ toast('這個書籤只給管理員金鑰用：請先填 API Key 並開啟一個行程，再產生書籤網址', 'error'); return; }
  const url = buildBookmarkUrl();
  navigator.clipboard.writeText(url)
    .then(()=>toast('已複製書籤網址！存成瀏覽器書籤，之後點它就會自動連線並載入行程。（網址裡含金鑰，請只存在自己的書籤，不要公開分享）', 'success'))
    .catch(()=>toast('複製失敗，這是網址（請手動複製）：' + url, 'error'));
}
// 頁面載入時，若網址帶有 #apiKey=...，自動帶入金鑰並（若也帶 trip）直接載入該行程。
// 讀到後立刻清掉網址列的 hash，避免金鑰留在網址列／瀏覽器歷史紀錄裡。
// 舊版書籤裡的 guild 參數直接忽略（行程已經不需要伺服器 ID 了）。
async function applyUrlParams(){
  const hashParams = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const key = hashParams.get('apiKey');
  const base = hashParams.get('apiBase');
  const tripId = hashParams.get('trip');
  if (!key) return false;
  history.replaceState(null, '', location.pathname + location.search);
  document.getElementById('apiKey').value = key;
  if (base) document.getElementById('apiBase').value = base;
  try{ await refreshTripList(); }catch(e){ return true; }
  if (tripId && myTrips.some(t => t.id === tripId)){
    document.getElementById('tripSelect').value = tripId;
    await loadTripFromApi();
  } else {
    showMainTab('settings'); showSettingsSub('connect');
  }
  return true;
}
