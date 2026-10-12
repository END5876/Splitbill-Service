'use strict';
// 🆕 [分享連結] 訪客端偵測與載入分享模式、未登入時的全頁畫面、清除舊版管理員金鑰書籤。
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
    <div class="btn-row" style="justify-content:center; margin-top:20px;">
      <button class="btn btn-ghost" type="button" onclick="location.href = location.pathname">回到首頁</button>
    </div>
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
      <p>旅行、聚餐、合租的花費，記下來就自動算好誰該付誰多少。</p>
      <ul class="landing-features">
        <li><svg class="ic" aria-hidden="true"><use href="#i-camera"/></svg><div><b>拍照辨識帳單</b><span>上傳收據，自動列出品項，大家點選自己吃了什麼</span></div></li>
        <li><svg class="ic" aria-hidden="true"><use href="#i-globe"/></svg><div><b>多幣別自動換算</b><span>出國刷卡、付現都能記，依即時匯率換算</span></div></li>
        <li><svg class="ic" aria-hidden="true"><use href="#i-check"/></svg><div><b>最少轉帳次數結清</b><span>算出誰該付誰多少，付完一鍵標記</span></div></li>
        <li><svg class="ic" aria-hidden="true"><use href="#i-chat"/></svg><div><b>Discord 即時同步</b><span>綁定伺服器後，用 Mousebot 的 /splitbill 面板也能記帳</span></div></li>
      </ul>
      <button class="btn btn-brass no-access-login" type="button" onclick="loginWithDiscord()">用 Discord 登入</button>
      <p class="no-access-note">只會讀取你的 Discord 名稱與頭像。<br>朋友傳給你的是分享連結的話，直接點開那個連結即可，不需要登入。</p>    </div>
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
    const res = await fetch(`/api/shared-trip/${encodeURIComponent(token)}`);
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

// 舊版「管理員金鑰書籤」（#apiKey=...）已經停用：網頁不再接受金鑰，Bot 擁有者
// 改用 Discord 登入。讀到時立刻清掉網址列的 hash，避免金鑰留在網址列／瀏覽器
// 歷史紀錄裡，並提示改用 Discord 登入。
function discardLegacyApiKeyHash(){
  const hashParams = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  if (!hashParams.has('apiKey')) return;
  history.replaceState(null, '', location.pathname + location.search);
  toast('管理員金鑰書籤已停用，請改用 Discord 登入（Bot 擁有者登入後可以列出所有行程）', 'error', { duration: 8000 });
}
