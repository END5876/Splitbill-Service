'use strict';
// 連線 splitbill-service 的基礎設施：身分（Discord 登入）、目前行程、
// 即時匯率查詢、「我的行程」清單、記住上次開的行程。
/* ===================== connection ===================== */
// 🆕 [行程獨立化] 行程以 tripId 為主鍵（/api/trip/:tripId），不再需要先選伺服器。
// 網頁的身分只有兩種：
//   - 登入（Discord 或 LINE）：cookie 自動帶上，寫入請求另外帶 x-requested-with 標頭
//     （service 端的 CSRF 檢查，見 lib/auth.js）。Bot 擁有者（OWNER_USER_ID）
//     登入後可以切換「列出所有行程」，不需要另外輸入金鑰。
//   - 分享連結訪客：token 只放在網址路徑 /api/shared-trip/:token/...（見 shareGuest.js）
// SPLITBILL_API_KEY 只給 Bot／維運腳本用，網頁不再接受。
let currentUser = null;      // { id, name, avatar, admin, provider, accounts } | null
let oauthEnabled = false;    // 至少有一種登入方式
let loginProviders = { discord: false, line: false }; // 🆕 [LINE 登入] 哪些登入方式已經設定好
const PROVIDER_LABELS = { discord: 'Discord', line: 'LINE' };

// 🆕 [LINE 登入] 成員連結的帳號：discordId（Discord）或 lineId（只用 LINE 的人，line:U…）。
// currentUser.id 是主身分（LINE 綁定到 Discord 後就是 Discord ID），直接跟這個比對。
function memberAccountId(m){ return (m && (m.discordId || m.lineId)) || null; }
function isMemberLinked(m){ return !!(m && (m.discordId || m.lineId || m.linked)); }
function isMyMember(m){ return !!(currentUser && m && memberAccountId(m) === currentUser.id); }
let myTrips = [];            // GET /api/my/trips 的結果（含 role）
let currentTripId = null;    // 目前開啟的雲端行程；null＝還沒開啟任何行程
let lastSyncedTripJSON = null; // 用來做簡單的樂觀鎖：跟伺服器目前的版本比對，偵測是否被別人改過

function apiHeaders(){
  return { 'x-requested-with': 'splitbill' };
}
// 🆕 [分享連結] 「登入者／分享連結訪客都可能呼叫」的端點（即時匯率、帳單辨識、
// 帳單辨識協作）：分享連結模式下改走 /api/shared-trip/:token/<path>，token 本身就是憑證。
function utilityApiUrl(path){
  return shareMode ? `/api/shared-trip/${encodeURIComponent(shareMode.token)}/${path}` : `/api/${path}`;
}
function isConnected(){ return !!currentTripId; }
function tripApiUrl(suffix){
  return `/api/trip/${encodeURIComponent(currentTripId)}${suffix || ''}`;
}
// 目前行程裡「我」的身分：'admin'（Bot 擁有者看別人的行程）| 'owner' | 'member' | null
function currentTripRole(){
  if (!currentTripId) return null;
  const entry = myTrips.find(t => t.id === currentTripId);
  if (entry) return entry.role;
  if (currentUser && trip.ownerId === currentUser.id) return 'owner';
  if (currentUser && trip.members.some(isMyMember)) return 'member';
  return null;
}
function canManageTrip(){
  const r = currentTripRole();
  return r === 'owner' || r === 'admin';
}
async function apiJson(res){
  const body = await res.json().catch(()=>({}));
  if (!res.ok){
    // 伺服器沒有給說明時，依狀態碼給白話的主句；狀態碼只放句尾給查問題用
    const fallback = res.status >= 500 ? '伺服器處理時出錯，請再試一次。'
      : res.status === 429 ? '操作太頻繁了，請稍等一下再試。'
        : `沒有完成，請再試一次。（錯誤代碼 ${res.status}）`;
    const err = new Error(body.error || fallback);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

/* ===================== 即時匯率 ===================== */
// 非基準幣的支出/轉帳，存檔時要用「當下」的即時匯率換算 amountInBase（amount 仍存原始幣值）。
// 用短時間快取，避免同一張表單打字時每個 keystroke 都打一次外部匯率 API。
let liveRateCache = {}; // `${from}_${to}` -> { rate, asOf, fetchedAt }
const LIVE_RATE_CACHE_TTL = 10 * 60 * 1000; // 10 分鐘
async function fetchLiveRate(from, to){
  if (from === to) return { rate: 1, asOf: null };
  const key = `${from}_${to}`;
  const cached = liveRateCache[key];
  if (cached && (Date.now() - cached.fetchedAt) < LIVE_RATE_CACHE_TTL) return cached;
  try{
    const res = await fetch(utilityApiUrl(`fx-rate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
    const body = await apiJson(res);
    const entry = { rate: body.rate, asOf: body.asOf, stale: !!body.stale, fetchedAt: Date.now() };
    liveRateCache[key] = entry;
    fetchLiveRate.lastError = null;
    return entry;
  }catch(err){
    // 失敗原因給幣別選單說明用：offline 沒網路／busy 查太頻繁／notfound 查不到這個幣別／error 其他
    fetchLiveRate.lastError = navigator.onLine === false ? 'offline'
      : err.status === 429 ? 'busy' : err.status === 404 ? 'notfound' : 'error';
    return null; // 由呼叫端自行退回使用手動設定的匯率，不擋住記帳
  }
}

/* ===================== 身分 ===================== */
// 連不上伺服器（沒有網路、伺服器沒回應或 5xx）時不能當成「沒登入」：
// 不然會顯示登入畫面，看起來像被登出，點登入又因為沒網路失敗
let meUnreachable = false;
async function fetchMe(){
  meUnreachable = false;
  try{
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    const body = await apiJson(res);
    currentUser = body.user || null;
    oauthEnabled = !!body.oauth;
    loginProviders = body.providers || { discord: oauthEnabled, line: false };
  }catch(e){
    currentUser = null;
    meUnreachable = !e.status || e.status >= 500;
  }
  renderAccountArea();
  renderHeaderAccount();
  return currentUser;
}
// 主畫面 App：iOS 的主畫面 App 跟 Safari 不共用 Cookie，跳去登入後回不來，所以一律改用代碼登入；
// 其他平台的主畫面 App 照常登入，另外在按鈕下面提供代碼登入（萬一回不來）
const IOS_STANDALONE = navigator.standalone === true; // 只有 iOS 有 navigator.standalone
const STANDALONE = IOS_STANDALONE || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
function loginWith(provider, next){
  if (IOS_STANDALONE) return startLoginHandoff(provider, next);
  const target = next || (location.pathname + location.search + location.hash);
  location.href = `/auth/${encodeURIComponent(provider)}/login?next=${encodeURIComponent(target)}`;
}

/* ---------- 代碼登入（主畫面 App）：App 顯示代碼 → 在瀏覽器登入並確認代碼 → App 自動登入 ---------- */
let handoffTimer = null, handoffBusy = false, handoffStarting = false;
const HANDOFF_STATUS = {
  pending: '等待登入…',
  confirming: '請在瀏覽器按「登入 App」',
  cancelled: '已在瀏覽器取消登入，可以再試一次',
  failed: '登入失敗，可以在瀏覽器再試一次',
};
const handoffFetch = (path) => fetch(`/auth/handoff/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'splitbill' } });
function stopLoginHandoff(){
  clearInterval(handoffTimer); handoffTimer = null;
}
// provider：只顯示這個平台的按鈕；沒給就列出所有可用的登入方式。
// next：登入後要去的地方（例如邀請頁的 /#link=…，網址上的 #link= 已經被拿掉了，不記下來登入後就回不去）
const HANDOFF_NEXT_KEY = 'splitbill-handoff-next';
async function startLoginHandoff(provider, next){
  if (handoffStarting) return; // 連點兩下：只要一組代碼
  handoffStarting = true;
  try{
    if (typeof next === 'string' && next.startsWith('/')) sessionStorage.setItem(HANDOFF_NEXT_KEY, next);
    else sessionStorage.removeItem(HANDOFF_NEXT_KEY);
  }catch(e){ /* 私密瀏覽：登入後回到首頁 */ }
  stopLoginHandoff();
  let j;
  try{
    const r = await handoffFetch('start'); // 伺服器會順便作廢這個 App 之前要的代碼
    j = await r.json().catch(() => ({}));
    if (!r.ok){ toast(j.error || '拿不到登入代碼，請稍後再試一次', 'error'); return; }
  }catch(e){
    toast('連不上伺服器，請檢查網路後再試一次', 'error'); return;
  }finally{ handoffStarting = false; }
  const urls = j.loginUrls || {};
  const provs = ['line', 'discord'].filter(p => urls[p] && (!provider || p === provider || !urls[provider]));
  const btnCls = { line: 'btn-line', discord: 'btn-brass' };
  mountModal(`
    <div class="modal-title" id="modalTitle">用代碼登入</div>
    <div class="modal-body" id="modalBody">
      <p class="handoff-intro">在瀏覽器登入後，確認頁上的代碼要和這裡一樣：</p>
      <div class="handoff-code">${escapeHtml(j.code || '')}</div>
      <div class="handoff-links">${provs.map(p =>
        `<a class="btn ${btnCls[p]}" href="${escapeHtml(urls[p])}" target="_blank" rel="noopener">在瀏覽器用 ${PROVIDER_LABELS[p]} 登入</a>`).join('')}</div>
      <p class="handoff-status" id="handoffStatus" role="status">${HANDOFF_STATUS.pending}</p>
    </div>
    <div class="modal-actions"><button class="btn btn-ghost" id="handoffCancelBtn" type="button">取消</button></div>`,
    { hasTitle: true, hasBody: true, onDismiss: cancelLoginHandoff });
  document.getElementById('handoffCancelBtn').onclick = ()=>{ closeModal(); cancelLoginHandoff(); };
  handoffTimer = setInterval(pollLoginHandoff, 2000);
}
// 例如瀏覽器那邊沒按確認就關掉了：代碼在伺服器上作廢，不用等過期就能重來
function cancelLoginHandoff(){
  stopLoginHandoff();
  handoffFetch('cancel').catch(() => {});
}
async function pollLoginHandoff(){
  if (handoffBusy || !handoffTimer) return;
  handoffBusy = true;
  try{
    const r = await handoffFetch('poll');
    if (!handoffTimer) return; // 等回應的時候已經結束（取消或另一次輪詢已完成）
    if (r.status === 202){
      const j = await r.json().catch(() => ({}));
      const el = document.getElementById('handoffStatus');
      if (el) el.textContent = HANDOFF_STATUS[j.status] || HANDOFF_STATUS.pending;
      return;
    }
    stopLoginHandoff();
    closeModal();
    if (r.ok){ goAfterHandoffLogin(); return; }
    const j = await r.json().catch(() => ({}));
    toast(j.error || '登入代碼已過期，請重新開始', 'error');
  }catch(e){ /* 網路暫時斷線：下一輪再試 */ }
  finally{ handoffBusy = false; }
}
// 登入完成：回到開始登入時要去的地方（只有 hash 不同時要自己重新載入，不然頁面不會換）
function goAfterHandoffLogin(){
  let next = null;
  try{ next = sessionStorage.getItem(HANDOFF_NEXT_KEY); sessionStorage.removeItem(HANDOFF_NEXT_KEY); }catch(e){}
  if (!next) return location.reload();
  const u = new URL(next, location.href);
  if (u.origin !== location.origin) return location.reload();
  if (u.pathname === location.pathname && u.search === location.search){
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    location.reload();
  } else {
    location.href = u.href;
  }
}
// 從瀏覽器切回 App 時立刻檢查一次，不用等下一輪
document.addEventListener('visibilitychange', () => { if (!document.hidden && handoffTimer) pollLoginHandoff(); });
function loginWithDiscord(next){ loginWith('discord', next); }
function loginWithLine(next){ loginWith('line', next); }
// 已設定好的登入方式各一顆按鈕。next：登入後回到哪裡；verb：按鈕文字「用 X 登入」後面接的字（例如「並加入」）
function loginButtonsHtml(next, verb){
  const list = [];
  if (loginProviders.line) list.push(['line', 'loginWithLine', 'btn-line']);
  if (loginProviders.discord) list.push(['discord', 'loginWithDiscord', 'btn-brass']);
  const buttons = list.map(([p, fn, cls]) =>
    `<button class="btn ${cls}" type="button" ${next ? act('click', fn, next) : `data-click="${fn}"`}>用 ${PROVIDER_LABELS[p]} 登入${escapeHtml(verb || '')}</button>`
  ).join('');
  // 非 iOS 的主畫面 App：照常登入，萬一回不來可以改用代碼（iOS 的按鈕本身就是代碼登入）
  const fallback = list.length && STANDALONE && !IOS_STANDALONE
    ? '<button class="link-btn handoff-fallback" type="button" data-click="startLoginHandoff">登入後回不到這裡？改用代碼登入</button>' : '';
  return buttons + fallback;
}
// 「只會讀取你的…名稱與頭像」說明用：「Discord」「LINE」或「Discord／LINE」
function loginProviderNames(){
  return ['line', 'discord'].filter(p => loginProviders[p]).map(p => PROVIDER_LABELS[p]).join('／');
}
async function logout(){
  try{
    await fetch('/auth/logout', { method: 'POST', headers: { 'x-requested-with': 'splitbill' } });
  }catch(e){}
  clearOwnerConnectionState();
  location.reload();
}
// 換一個帳號：先登出，再帶 switch=1 回到同一個平台。登出不會登出 Discord／LINE 本身，
// 一般登入授權過就直接導回來；switch=1 一定顯示同意畫面（Discord 上面有「不是你？」可以換帳號，與音樂庫相同；
// LINE 會關掉自動登入，讓你輸入別的帳號）
async function switchAccount(){
  const provider = (currentUser && currentUser.provider) || 'discord';
  try{
    await fetch('/auth/logout', { method: 'POST', headers: { 'x-requested-with': 'splitbill' } });
  }catch(e){}
  clearOwnerConnectionState();
  location.href = `/auth/${encodeURIComponent(provider)}/login?switch=1&next=${encodeURIComponent('/')}`;
}
// 登入導回來的結果（?login=cancelled／failed）與帳號綁定的結果（?bind=…）：顯示提示，並從網址拿掉。
// ?bind=confirm 要等 fetchMe() 之後才能問使用者（回傳 true，由 bootstrap 接著呼叫 showAccountLinkConfirm）
function showLoginResultFromUrl(){
  let u;
  try{ u = new URL(location.href); }catch(e){ return false; }
  const result = u.searchParams.get('login');
  const bind = u.searchParams.get('bind');
  if (!result && !bind) return false;
  u.searchParams.delete('login');
  u.searchParams.delete('bind');
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  if (result === 'cancelled') toast('已取消登入', 'info');
  else if (result) toast('登入失敗，請稍後再試一次', 'error');
  if (bind === 'done') toast('完成了，現在用 Discord 或 LINE 登入都看得到你的行程', 'success', { duration: 6000 });
  else if (bind === 'already') toast('你的 Discord 和 LINE 已經能登入同一個帳號了', 'info');
  else if (bind === 'cancelled') toast('已取消，沒有變更', 'info');
  else if (bind === 'failed') toast('沒有完成，請稍後再試一次', 'error');
  return bind === 'confirm';
}

/* ===================== 🆕 帳號綁定（Discord ⇄ LINE） ===================== */
// 用另一個平台登入一次，證明兩個帳號都是你的（伺服器見 routes/oauth.js 的 ?link=1、routes/accountLink.js）
function linkAccount(provider){
  const next = location.pathname + location.search + location.hash;
  location.href = `/auth/${encodeURIComponent(provider)}/login?link=1&next=${encodeURIComponent(next)}`;
}
// LINE 帳號名下已經有行程：列出影響，讓使用者確認合併
async function showAccountLinkConfirm(){
  let pending;
  try{
    pending = (await apiJson(await fetch('/api/account-link/pending', { headers: apiHeaders() }))).pending;
  }catch(e){ pending = null; }
  if (!pending){ toast('這次設定已經逾時，請再試一次', 'error'); return; }
  const NL = String.fromCharCode(10);
  const lines = pending.trips.map(t => {
    if (t.willUnlink){
      return `・${t.name}（你的 Discord 帳號已經在這個行程裡，LINE 選的「${t.memberName}」會變成未連結的成員，帳目不變）`;
    }
    return `・${t.name}（${t.owner ? '你建立的' : `你是「${t.memberName}」`}）`;
  });
  const who = pending.aliasName ? `LINE 帳號「${pending.aliasName}」` : '這個 LINE 帳號';
  const ok = await confirmModal(
    `${who}參與了 ${pending.trips.length} 個行程。完成後，用 Discord 或 LINE 登入都看得到這些行程：${NL}${NL}${lines.join(NL)}`,
    { title: '讓 Discord 和 LINE 都能登入同一個帳號？', confirmText: '完成設定', cancelText: '取消' }
  );
  if (!ok){
    await fetch('/api/account-link/cancel', { method: 'POST', headers: apiHeaders() }).catch(()=>{});
    toast('已取消，沒有變更', 'info');
    return;
  }
  try{
    await apiJson(await fetch('/api/account-link/confirm', { method: 'POST', headers: apiHeaders() }));
    toast('完成了，兩種登入都看得到你的行程', 'success', { duration: 6000 });
    await fetchMe();
    await refreshTripList({ silent: true }).catch(()=>{});
  }catch(err){
    toast('沒有完成：' + err.message, 'error');
  }
}
async function unlinkAccount(){
  const viaLine = currentUser && currentUser.provider === 'line';
  const ok = await confirmModal(
    viaLine
      ? '你現在是用 LINE 登入。停用後，畫面上的行程會消失，要改用 Discord 登入才看得到。'
      : '停用後，用 LINE 登入就看不到你的行程，要用 Discord 登入才看得到。',
    { title: '停用 LINE 登入？', confirmText: '停用 LINE 登入', cancelText: '取消', danger: true }
  );
  if (!ok) return;
  try{
    await apiJson(await fetch('/api/account-link', { method: 'DELETE', headers: apiHeaders() }));
    toast('已停用 LINE 登入', 'success');
    if (viaLine){ clearOwnerConnectionState(); location.reload(); return; }
    await fetchMe();
  }catch(err){
    toast('沒有停用成功：' + err.message, 'error');
  }
}

/* ===================== 我的行程 ===================== */
// Bot 擁有者可以切換「列出所有行程」（GET /api/my/trips?all=1）；記在這台裝置上。
const SHOW_ALL_TRIPS_STORAGE_KEY = 'splitbill-show-all-trips';
function showAllTrips(){
  if (!currentUser || !currentUser.admin) return false;
  try{ return localStorage.getItem(SHOW_ALL_TRIPS_STORAGE_KEY) === '1'; }catch(e){ return false; }
}
async function setShowAllTrips(on){
  try{ on ? localStorage.setItem(SHOW_ALL_TRIPS_STORAGE_KEY, '1') : localStorage.removeItem(SHOW_ALL_TRIPS_STORAGE_KEY); }catch(e){}
  await refreshTripList().catch(()=>{});
}
async function refreshTripList(opts){
  opts = opts || {};
  try{
    const res = await fetch('/api/my/trips' + (showAllTrips() ? '?all=1' : ''), { headers: apiHeaders() });
    const body = await apiJson(res);
    myTrips = body.trips || [];
    populateTripSelect();
    if (!opts.silent) toast(`共 ${myTrips.length} 個行程`, 'success');
    return myTrips;
  }catch(err){
    myTrips = [];
    populateTripSelect();
    if (!opts.silent){
      toast(err.status === 401 ? '請先登入' : ('讀取行程清單失敗：' + err.message), 'error');
    }
    throw err;
  }
}
const ROLE_LABELS = { owner: '建立者', member: '成員', admin: '管理' };
function populateTripSelect(){
  const sel = document.getElementById('tripSelect');
  const prev = sel.value || currentTripId || '';
  // 封存的行程排在最後
  const ordered = [...myTrips].sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0));
  sel.innerHTML = ordered.length
    ? ordered.map(t=>`<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}（${[ROLE_LABELS[t.role], t.archived ? '已封存' : ''].filter(Boolean).join('，')}）</option>`).join('')
    : '<option value="">（還沒有任何行程，先在下方建立一個）</option>';
  if (prev && myTrips.some(t=>t.id===prev)) sel.value = prev;
  updateDeleteTripButton();
}

// 🆕 記住上次開的行程，下次重新整理頁面時可以自動接回去。存在 localStorage：
// 這是「你自己這台裝置」記住「你自己的」設定，資料不會被送到任何地方。
const OWNER_CONNECTION_STORAGE_KEY = 'splitbill-owner-connection';
function saveOwnerConnectionState(){
  try{
    if (!currentTripId) return;
    localStorage.setItem(OWNER_CONNECTION_STORAGE_KEY, JSON.stringify({ tripId: currentTripId }));
  }catch(e){}
}
function clearOwnerConnectionState(){
  try{ localStorage.removeItem(OWNER_CONNECTION_STORAGE_KEY); }catch(e){}
}
// 頁面載入時「安靜地」嘗試接回上次的行程：接不回去（行程被刪除、已經不是成員）
// 就悄悄退回一般狀態，不跳錯誤訊息。
async function restoreOwnerConnectionState(){
  let saved = null;
  try{ saved = JSON.parse(localStorage.getItem(OWNER_CONNECTION_STORAGE_KEY) || 'null'); }catch(e){}
  if (!saved || !saved.tripId) return false;
  // 舊版還存了 guildId／apiBase／管理員金鑰：tripId 照用，金鑰立刻從這台裝置上清掉
  if (saved.apiKey || saved.apiBase || saved.guildId){
    try{ localStorage.setItem(OWNER_CONNECTION_STORAGE_KEY, JSON.stringify({ tripId: saved.tripId })); }catch(e){}
  }
  if (!currentUser) return false;
  try{
    await refreshTripList({ silent: true });
    if (!myTrips.some(t => t.id === saved.tripId)){ clearOwnerConnectionState(); return false; }
    document.getElementById('tripSelect').value = saved.tripId;
    await loadTripFromApi({ quiet: true });
    return isConnected();
  }catch(e){
    return false;
  }
}

/* ===================== 建立行程 ===================== */
// 在雲端建立一個新的空白行程（自己是建立者，也是第一位已連結的成員），建立後直接開啟。
async function createTripOnServer(){
  const nameInput = document.getElementById('newTripName');
  const curInput = document.getElementById('newTripCurrency');
  const name = nameInput.value.trim();
  const baseCurrency = (curInput.value.trim() || 'TWD').toUpperCase();
  if (!name){ toast('請輸入行程名稱', 'error'); nameInput.focus(); return; }
  if (!/^[A-Z]{2,6}$/.test(baseCurrency)){ toast('結算用的幣別請輸入 2～6 個英文字母，例如 TWD、JPY。', 'error'); return; }
  try{
    const res = await fetch('/api/trips', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
      body: JSON.stringify({ name, baseCurrency })
    });
    const created = await apiJson(res);
    nameInput.value = '';
    await refreshTripList({ silent: true });
    document.getElementById('tripSelect').value = created.id;
    await loadTripFromApi({ quiet: true });
    toast(`已建立行程「${created.name}」，可以到「設定 → 成員與分享」新增朋友並傳邀請連結給他們`, 'success', { duration: 6000 });
  }catch(err){
    toast('建立行程失敗：' + err.message, 'error');
  }
}

/* ===================== 刪除行程 ===================== */
// 刪除「我的行程」下拉選單目前選到的行程。只有建立者（或 Bot 擁有者）看得到按鈕，
// 伺服器也會再檢查一次（DELETE /api/trip/:tripId 需要 owner 權限）。
function selectedTripEntry(){
  const sel = document.getElementById('tripSelect');
  return sel && sel.value ? myTrips.find(t => t.id === sel.value) || null : null;
}
function updateDeleteTripButton(){
  const renameBtn = document.getElementById('btnRenameTrip');
  if (renameBtn) renameBtn.style.display = selectedTripEntry() ? '' : 'none';
  const btn = document.getElementById('btnDeleteTrip');
  if (!btn) return;
  const t = selectedTripEntry();
  const canManage = !!t && (t.role === 'owner' || t.role === 'admin');
  btn.style.display = canManage ? '' : 'none';
  const unarchive = document.getElementById('btnUnarchiveTrip');
  if (unarchive) unarchive.style.display = canManage && t.archived ? '' : 'none';
}

/* ---------- 封存行程：大家都結清後，建立者可以封存；封存後只能看，Discord 的行程選單也不會列出來 ---------- */
async function setTripArchived(tripId, archived){
  return apiJson(await fetch(`/api/trip/${encodeURIComponent(tripId)}/archive`, {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
    body: JSON.stringify({ archived }),
  }));
}
function canManageCurrentTrip(){
  const role = currentTripRole();
  return role === 'owner' || role === 'admin';
}
async function archiveCurrentTrip(){
  if (!currentTripId) return;
  const ok = await confirmModal('封存後只能看、不能再記帳，Discord 的行程選單也不會再列出這個行程。之後可以在「設定 → 行程」取消封存。',
    { title: `封存「${trip.name}」？`, confirmText: '封存行程' });
  if (!ok) return;
  await applyArchived(currentTripId, true);
}
async function unarchiveCurrentTrip(){
  if (currentTripId) await applyArchived(currentTripId, false);
}
async function unarchiveSelectedTrip(){
  const t = selectedTripEntry();
  if (t) await applyArchived(t.id, false);
}
async function applyArchived(tripId, archived){
  let body;
  try{ body = await setTripArchived(tripId, archived); }
  catch(err){ toast((archived ? '封存失敗：' : '取消封存失敗：') + err.message, 'error'); return; }
  const entry = myTrips.find(t => t.id === tripId);
  if (entry) entry.archived = !!body.archived;
  const name = tripId === currentTripId ? trip.name : (entry ? entry.name : '');
  if (tripId === currentTripId){
    trip.archived = !!body.archived;
    if (typeof body.updatedAt === 'number') trip.updatedAt = body.updatedAt; // 跟伺服器同一個版本，下次儲存才不會被當成衝突
    renderAll();
  }
  populateTripSelect();
  toast(body.archived ? `已封存「${name}」` : `已取消封存「${name}」`, 'success');
  refreshTripList({ silent: true }).catch(()=>{});
}
// 封存中的行程：頁首下方常駐提示，所有記帳、編輯的按鈕藏起來（body.trip-archived）
function renderArchivedState(){
  const archived = !!(currentTripId && trip.archived);
  document.body.classList.toggle('trip-archived', archived);
  const banner = document.getElementById('archivedBanner');
  if (banner) banner.hidden = !archived;
  const btn = document.getElementById('archivedBannerBtn');
  if (btn) btn.hidden = !(archived && canManageCurrentTrip());
}
// 下拉選單選了就直接開啟該行程並帶到總覽；載入失敗時選單退回目前開著的行程。
async function onTripSelectChange(){
  const sel = document.getElementById('tripSelect');
  const id = sel.value;
  if (id && id !== currentTripId){
    sel.disabled = true;
    try{ await loadTripFromApi({ tripId: id }); }
    finally{ sel.disabled = false; }
    if (currentTripId === id) showMainTab('overview');
    else if (currentTripId) sel.value = currentTripId;
  }
  updateDeleteTripButton();
}

// 改名：下拉選單選到的行程。目前開著的行程直接改本地資料、走一般存檔流程
// （跟其他修改一起合併）；其他行程用 PATCH /api/trip/:tripId/name 只改名稱。
async function renameSelectedTrip(){
  const t = selectedTripEntry();
  if (!t) return;
  const isCurrent = t.id === currentTripId;
  const oldName = isCurrent ? trip.name : t.name;
  const name = await promptModal('', {
    title: '行程改名', value: oldName, maxLength: 60, placeholder: '例如：沖繩三天兩夜', confirmText: '儲存',
  });
  if (name === null) return;
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean){ toast('行程名稱不能空白', 'error'); return; }
  if (clean === oldName) return;
  if (isCurrent && !trip.archived){
    trip.name = clean;
    renderAll();
    scheduleCloudSave(0);
  } else {
    try{
      await apiJson(await fetch(`/api/trip/${encodeURIComponent(t.id)}/name`, {
        method: 'PATCH',
        headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
        body: JSON.stringify({ name: clean }),
      }));
    }catch(err){
      toast('改名失敗：' + err.message, 'error');
      return;
    }
  }
  t.name = clean;
  if (isCurrent && trip.name !== clean){ trip.name = clean; renderAll(); } // 封存的行程走上面的 PATCH
  populateTripSelect();
  toast(`已改名為「${clean}」`, 'success');
  refreshTripList({ silent: true }).catch(()=>{});
}
async function deleteSelectedTrip(){
  const t = selectedTripEntry();
  if (!t) return;
  // 第一次確認：講清楚會失去什麼
  const ok = await confirmModal(
    `行程裡所有的支出、轉帳、成員和操作紀錄都會一起刪除，所有成員都會看不到這個行程，和 Discord 伺服器的連線、邀請連結、免登入連結也會失效。

刪除後無法復原。想留一份的話，請先開啟這個行程，到「設定 → 備份與匯出」下載 JSON 備份。`,
    { title: `刪除行程「${t.name}」？`, confirmText: '繼續刪除', cancelText: '取消', danger: true }
  );
  if (!ok) return;
  // 第二次確認：要輸入行程名稱才能刪
  const typed = await typeToConfirmModal(
    `請輸入行程名稱「${t.name}」確認刪除。`,
    t.name,
    { title: '最後確認', confirmText: '永久刪除', placeholder: t.name }
  );
  if (!typed) return;

  const isCurrent = t.id === currentTripId;
  // 自己刪除目前開著的行程時，伺服器也會推「行程已被刪除」給這個分頁；
  // 先斷線，免得跳出給「別人刪掉」用的錯誤提示。
  if (isCurrent) disconnectTripEventStream();
  try{
    await apiJson(await fetch(`/api/trip/${encodeURIComponent(t.id)}`, { method: 'DELETE', headers: apiHeaders() }));
  }catch(err){
    if (isCurrent) connectTripEventStream().catch(()=>{});
    toast('刪除行程失敗：' + err.message, 'error');
    return;
  }
  if (isCurrent){
    currentTripId = null;
    clearOwnerConnectionState();
    trip = defaultTrip();
    lastSyncedTripJSON = null;
    renderAll();
    showMainTab('settings'); showSettingsSub('trips');
  }
  toast(`已刪除行程「${t.name}」`, 'success');
  await refreshTripList({ silent: true }).catch(()=>{});
}

// 把一份行程資料（從 JSON 匯入）建立成新的雲端行程，建立後直接開啟。
// 會先問「你是哪一位」，讓那位成員連結到自己的 Discord 帳號；其他人之後用邀請連結認領。
// 成功回傳建立的行程摘要，取消或失敗回傳 null。
async function createCloudTripFrom(source){
  if (!currentUser){ toast('請先登入', 'error'); return null; }
  let selfMemberId = '';
  if (source.members.length){
    selfMemberId = await pickModal(`匯入「${source.name}」：這個行程裡哪一位是你？`, [
      ...source.members.map(m => ({ value: m.id, title: m.name })),
      { value: '', title: '都不是', sub: '另外把我加成一位新成員' },
    ]);
    if (selfMemberId === null) return null; // 取消
  }
  try{
    const created = await apiJson(await fetch('/api/trips', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
      body: JSON.stringify({
        name: source.name,
        baseCurrency: source.baseCurrency,
        rates: source.rates,
        memberName: currentUser.name,
        selfMemberId: selfMemberId || undefined,
        content: { members: source.members, expenses: source.expenses, deposits: source.deposits },
      })
    }));
    await refreshTripList({ silent: true });
    await loadTripFromApi({ quiet: true, tripId: created.id });
    toast(`已匯入成新行程「${created.name}」`, 'success');
    return created;
  }catch(err){
    toast('匯入失敗：' + err.message, 'error');
    return null;
  }
}
