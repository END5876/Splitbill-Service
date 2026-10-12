'use strict';
// 🆕 [行程連結] 從連結進來的各種畫面：讀取網址上的連結 token、訪客模式、
// 加入行程畫面（登入／認領成員）、連結失效畫面，以及未登入時的全頁畫面。
// 要進哪一個畫面由 bootstrap.js 的 resolveEntry() 決定，這裡只負責畫出來。

/* ===================== 連結 token ===================== */
// token 暫存在這個分頁的 sessionStorage：重新整理、或「先去 Discord 登入再回來」
// 之後還接得上。特意不用 localStorage：連結是別人給的憑證，關掉分頁就不留痕跡。
const LINK_TOKEN_STORAGE_KEY = 'splitbill-link-token';
// 連結同時開放訪客與加入時，記住這個分頁選了「以訪客身分開啟」，重新整理不用再選一次
const LINK_GUEST_CHOICE_STORAGE_KEY = 'splitbill-link-guest';
// 舊版分別存在這兩個 key（例如登入到一半時剛好更新版本），讀一次後就清掉
const LEGACY_LINK_TOKEN_KEYS = ['splitbill-share-token', 'splitbill-invite-token'];

// 從網址 hash 讀出連結 token：#link=<token>，以及舊版的 #share= / #invite=
// （token 本身相同，舊網址照樣能用）。讀到就立刻用 replaceState 清掉網址列，
// 避免憑證留在網址列／瀏覽器歷史紀錄，或之後複製網址時被夾帶出去。
function takeLinkTokenFromUrl(){
  const match = (location.hash || '').match(/^#(?:link|share|invite)=([A-Za-z0-9]+)$/);
  if (!match) return null;
  history.replaceState(null, '', location.pathname + location.search);
  try{
    // 換了一條新連結，之前「以訪客身分開啟」的選擇不再適用
    if (sessionStorage.getItem(LINK_TOKEN_STORAGE_KEY) !== match[1]) sessionStorage.removeItem(LINK_GUEST_CHOICE_STORAGE_KEY);
    sessionStorage.setItem(LINK_TOKEN_STORAGE_KEY, match[1]);
  }catch(e){}
  return match[1];
}
function getPersistedLinkToken(){
  try{
    const token = sessionStorage.getItem(LINK_TOKEN_STORAGE_KEY);
    if (token) return token;
    for (const key of LEGACY_LINK_TOKEN_KEYS){
      const legacy = sessionStorage.getItem(key);
      sessionStorage.removeItem(key);
      if (legacy){ sessionStorage.setItem(LINK_TOKEN_STORAGE_KEY, legacy); return legacy; }
    }
  }catch(e){}
  return null;
}
function clearLinkToken(){
  try{
    sessionStorage.removeItem(LINK_TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(LINK_GUEST_CHOICE_STORAGE_KEY);
  }catch(e){}
}
function hasChosenGuest(){
  try{ return sessionStorage.getItem(LINK_GUEST_CHOICE_STORAGE_KEY) === '1'; }catch(e){ return false; }
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

/* ===================== 全頁畫面的共用工具 ===================== */
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

function showLinkError(message){
  // 連結本身已經失效／被撤銷／網址有誤，留著 token 只會讓下次重新整理又失敗一次
  clearLinkToken();
  hideJoinScreen();
  setMainUiVisible(false);
  const el = document.getElementById('shareErrorScreen');
  el.innerHTML = `
    <div class="ic">😕</div>
    <h1>這個連結打不開</h1>
    <p>${escapeHtml(message)}</p>
    <p style="margin-top:14px;">可以請給你連結的人再傳一組新的給你。</p>
    <div class="btn-row" style="justify-content:center; margin-top:20px;">
      <button class="btn btn-ghost" type="button" onclick="location.href = location.pathname">回到首頁</button>
    </div>
  `;
  el.style.display = 'block';
}

// 🆕 [Discord 登入] 沒有登入、也不是從連結進來時顯示的全頁畫面。
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
      <p class="no-access-note">只會讀取你的 Discord 名稱與頭像。<br>朋友傳了連結給你的話，直接點開那個連結即可。</p>    </div>
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

/* ===================== 訪客模式 ===================== */
function applyGuestModeUI(){
  document.body.classList.add('share-mode');
  if (shareMode.permission !== 'write'){
    document.body.classList.add('share-readonly');
    // 唯讀時行程名稱改成唯讀展示，避免朋友以為改了會生效（伺服器本來就會擋）
    document.getElementById('tripName').readOnly = true;
  }
}

// 以訪客身分開啟：一個分頁只會是「成員」或「訪客」其中一種身分，進來之後不會再切換。
async function initGuestMode(token){
  try{
    const res = await fetch(`/api/shared-trip/${encodeURIComponent(token)}`);
    if (!res.ok){
      const body = await res.json().catch(()=>({}));
      showLinkError(body.error || '找不到這個連結，網址可能有誤。');
      return;
    }
    const data = await res.json();
    trip = repairTrip(data.trip);
    lastSyncedTripJSON = JSON.stringify(trip);
    shareMode = { token, permission: data.permission === 'write' ? 'write' : 'read' };
    applyGuestModeUI();
    editingExpenseId = null; editingDepositId = null;
    expandedExpenseIds.clear(); expandedDepositIds.clear();
    resetListFilters();
    renderAll();
    connectTripEventStream();
    if (shareMode.permission === 'write') checkReceiptSessionAvailability(); // 🆕 [多人協作] 唯讀訪客不需要看到「加入認領」的提示
    // 🆕 帳單辨識是寫入功能，唯讀訪客本來就看不到那個區塊，沒必要問
    if (!receiptState && shareMode.permission === 'write') maybeOfferReceiptDraftRestore();
  }catch(err){
    showLinkError('連線時發生問題，請確認網路連線後重新整理頁面看看。');
  }
}
function chooseGuestMode(token){
  try{ sessionStorage.setItem(LINK_GUEST_CHOICE_STORAGE_KEY, '1'); }catch(e){}
  hideJoinScreen();
  initGuestMode(token);
}

/* ===================== 加入行程畫面 ===================== */
// info 是 GET /api/link/:token 的結果：{ tripName, guest, join, members, viewer, tripId }
function hideJoinScreen(){
  const el = document.getElementById('inviteScreen');
  el.style.display = 'none';
  el.innerHTML = '';
  setMainUiVisible(true);
}
function leaveJoinScreen(){
  clearLinkToken();
  hideJoinScreen();
  bootstrapHome();
}
function showJoinScreen(token, info){
  setMainUiVisible(false);
  const el = document.getElementById('inviteScreen');
  el.style.display = 'block';
  const t = escapeHtml(token);
  const head = `<div class="ic">🧳</div><h1>${escapeHtml(info.tripName)}</h1>`;
  const guestLabel = info.guest === 'write' ? '不登入，直接開啟（可編輯）' : '不登入，直接檢視';
  // 連結同時開放訪客時，「先不要」改成「以訪客身分開啟」
  const secondary = info.guest !== 'none'
    ? `<button class="btn btn-ghost btn-sm" type="button" onclick="chooseGuestMode('${t}')">${guestLabel}</button>`
    : `<button class="btn btn-ghost btn-sm" type="button" onclick="leaveJoinScreen()">先不要</button>`;

  if (!currentUser){
    el.innerHTML = `
      <div class="invite-card">
        ${head}
        <p>有人邀請你一起記這個行程的帳。<br>用 Discord 登入後，選擇你是哪一位就能加入。</p>
        <div class="btn-row" style="justify-content:center;">
          ${oauthEnabled
            ? `<button class="btn btn-brass" type="button" onclick="loginWithDiscord('/#link=${encodeURIComponent(token)}')">用 Discord 登入並加入</button>`
            : '<p class="hint">這個網站尚未開啟 Discord 登入，請聯絡網站管理者。</p>'}
        </div>
        <div class="btn-row" style="justify-content:center; margin-top:14px;">${secondary}</div>
      </div>`;
    return;
  }

  const unlinked = info.members.filter(m => !m.linked);
  const linked = info.members.filter(m => m.linked);
  joinMemberNames = new Map(info.members.map(m => [m.id, m.name]));
  // 主要動作是「認領既有成員」；「以新成員加入」收在「都不是？」後面，
  // 避免本來就在名單上的人沒看清楚，又多加了一個重複的自己。
  el.innerHTML = `
    <div class="invite-card">
      ${head}
      ${unlinked.length ? `
      <p>你是下面哪一位？選了之後，這位成員過去的代墊與分攤紀錄都會連結到你的 Discord 帳號（${escapeHtml(currentUser.name)}）。</p>
      <div class="invite-members">
        ${unlinked.map(m => `<button class="modal-list-item" type="button" onclick="confirmJoinClaim('${t}', '${escapeHtml(m.id)}', this)"><div class="mli-title">我是「${escapeHtml(m.name)}」</div></button>`).join('')}
      </div>` : '<p>名單上的成員都已經被認領了，你可以用新成員的身分加入。</p>'}
      ${linked.length ? `<div class="hint" style="margin-top:8px;">已經有人認領：${linked.map(m => escapeHtml(m.name)).join('、')}</div>` : ''}
      ${unlinked.length ? `<button type="button" class="link-btn invite-new-toggle" onclick="this.hidden=true; document.getElementById('inviteNewBlock').hidden=false; document.getElementById('inviteNewName').focus();">都不是？以新成員身分加入</button>` : ''}
      <div class="invite-new" id="inviteNewBlock" ${unlinked.length ? 'hidden' : ''}>
        <div class="hint" style="margin:14px 0 6px;">以新成員身分加入：</div>
        <div class="btn-row" style="justify-content:center;">
          <input type="text" id="inviteNewName" maxlength="60" placeholder="你的名字" aria-label="你的名字" value="${escapeHtml(currentUser.name || '')}" style="max-width:180px;">
          <button class="btn btn-primary" type="button" onclick="claimJoin('${t}', { newMemberName: document.getElementById('inviteNewName').value }, this)">加入</button>
        </div>
      </div>
      <div class="btn-row" style="justify-content:center; margin-top:14px;">${secondary}</div>
    </div>`;
}
// 認領前再確認一次：認錯人之後要請建立者解除連結，比較麻煩。
let joinMemberNames = new Map();
async function confirmJoinClaim(token, memberId, btn){
  const name = joinMemberNames.get(memberId) || '這位成員';
  const ok = await confirmModal(
    `確定你就是「${name}」嗎？確認後，「${name}」過去的代墊與分攤紀錄都會連結到你的 Discord 帳號。`,
    { title: '認領成員', confirmText: '是我，認領' }
  );
  if (ok) await claimJoin(token, { memberId }, btn);
}
async function claimJoin(token, body, btn){
  if (body.newMemberName !== undefined && !String(body.newMemberName).trim()){
    toast('請輸入你的名字', 'error'); return;
  }
  const run = async ()=>{
    try{
      const res = await fetch(`/api/link/${encodeURIComponent(token)}/claim`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(()=>({}));
      if (res.ok || (res.status === 409 && data.memberId)){
        toast(res.ok ? '已加入行程！' : data.error, res.ok ? 'success' : 'info');
        clearLinkToken();
        hideJoinScreen();
        await openTripAsMember(data.tripId);
        return;
      }
      toast(data.error || ('HTTP ' + res.status), 'error');
      if (res.status === 409) applyEntry(await resolveEntry()); // 有人搶先認領了，重新整理名單
    }catch(err){
      toast('加入失敗：' + err.message, 'error');
    }
  };
  if (btn) await withLoading(btn, '處理中…', run); else await run();
}
