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
    const err = new Error(body.error || ('HTTP ' + res.status));
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
    const entry = { rate: body.rate, asOf: body.asOf, fetchedAt: Date.now() };
    liveRateCache[key] = entry;
    return entry;
  }catch(err){
    return null; // 由呼叫端自行退回使用手動設定的匯率，不擋住記帳
  }
}

/* ===================== 身分 ===================== */
async function fetchMe(){
  try{
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    const body = await apiJson(res);
    currentUser = body.user || null;
    oauthEnabled = !!body.oauth;
    loginProviders = body.providers || { discord: oauthEnabled, line: false };
  }catch(e){
    currentUser = null;
  }
  renderAccountArea();
  return currentUser;
}
function loginWith(provider, next){
  const target = next || (location.pathname + location.search + location.hash);
  location.href = `/auth/${encodeURIComponent(provider)}/login?next=${encodeURIComponent(target)}`;
}
function loginWithDiscord(next){ loginWith('discord', next); }
function loginWithLine(next){ loginWith('line', next); }
// 已設定好的登入方式各一顆按鈕。next：登入後回到哪裡；verb：按鈕文字「用 X 登入」後面接的字（例如「並加入」）
function loginButtonsHtml(next, verb){
  const list = [];
  if (loginProviders.line) list.push(['line', 'loginWithLine', 'btn-line']);
  if (loginProviders.discord) list.push(['discord', 'loginWithDiscord', 'btn-brass']);
  return list.map(([p, fn, cls]) =>
    `<button class="btn ${cls}" type="button" ${next ? act('click', fn, next) : `data-click="${fn}"`}>用 ${PROVIDER_LABELS[p]} 登入${escapeHtml(verb || '')}</button>`
  ).join('');
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
  if (bind === 'done') toast('帳號綁定完成，之後用哪一個登入都是同一個帳號', 'success', { duration: 6000 });
  else if (bind === 'already') toast('這兩個帳號本來就綁定在一起了', 'info');
  else if (bind === 'cancelled') toast('已取消帳號綁定', 'info');
  else if (bind === 'failed') toast('帳號綁定失敗，請稍後再試一次', 'error');
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
  if (!pending){ toast('綁定已經過期，請重新綁定一次', 'error'); return; }
  const lines = pending.trips.map(t => {
    const role = t.owner ? '你建立的行程' : `成員「${t.memberName}」`;
    return `・${t.name}（${role}${t.willUnlink ? `；你的 Discord 帳號已經是這個行程的成員，「${t.memberName}」會改成未連結，帳目不變` : ''}）`;
  });
  const who = pending.aliasName ? `LINE 帳號「${pending.aliasName}」` : '這個 LINE 帳號';
  const ok = await confirmModal(
    `${who}已經有 ${pending.trips.length} 個行程，綁定後會一起併到你的 Discord 帳號：

${lines.join(String.fromCharCode(10))}

之後用 LINE 或 Discord 登入都會看到這些行程。解除綁定時行程會留在 Discord 帳號。`,
    { title: '確認綁定並合併', confirmText: '綁定並合併', cancelText: '先不要' }
  );
  if (!ok){
    await fetch('/api/account-link/cancel', { method: 'POST', headers: apiHeaders() }).catch(()=>{});
    toast('已取消帳號綁定', 'info');
    return;
  }
  try{
    await apiJson(await fetch('/api/account-link/confirm', { method: 'POST', headers: apiHeaders() }));
    toast('帳號綁定完成，行程已經合併', 'success', { duration: 6000 });
    await fetchMe();
    await refreshTripList({ silent: true }).catch(()=>{});
  }catch(err){
    toast('綁定失敗：' + err.message, 'error');
  }
}
async function unlinkAccount(){
  const viaLine = currentUser && currentUser.provider === 'line';
  const ok = await confirmModal(
    viaLine
      ? '確定要解除 LINE 與 Discord 的綁定嗎？行程都會留在 Discord 帳號，你現在是用 LINE 登入，解除後這個 LINE 帳號就看不到那些行程了（用 Discord 登入才看得到）。'
      : '確定要解除 LINE 與 Discord 的綁定嗎？行程都會留在 Discord 帳號；之後用 LINE 登入會是一個全新、沒有任何行程的帳號。',
    { title: '解除帳號綁定', confirmText: '解除綁定', danger: true }
  );
  if (!ok) return;
  try{
    await apiJson(await fetch('/api/account-link', { method: 'DELETE', headers: apiHeaders() }));
    toast('已解除綁定', 'success');
    if (viaLine){ clearOwnerConnectionState(); location.reload(); return; }
    await fetchMe();
  }catch(err){
    toast('解除綁定失敗：' + err.message, 'error');
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
  sel.innerHTML = myTrips.length
    ? myTrips.map(t=>`<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}${t.archived?'（已封存）':''}　·　${ROLE_LABELS[t.role]||''}${t.guildId?'　·　🤖 已綁定':''}</option>`).join('')
    : '<option value="">（還沒有任何行程，先在下方建立一個）</option>';
  if (prev && myTrips.some(t=>t.id===prev)) sel.value = prev;
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
  if (!/^[A-Z]{2,6}$/.test(baseCurrency)){ toast('基準幣別請輸入 2～6 個英文字母，例如 TWD、JPY', 'error'); return; }
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
