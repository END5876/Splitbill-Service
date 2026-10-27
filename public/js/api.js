'use strict';
// 連線 splitbill-service 的基礎設施：身分（Discord 登入）、目前行程、
// 即時匯率查詢、「我的行程」清單、記住上次開的行程。
/* ===================== connection ===================== */
// 🆕 [行程獨立化] 行程以 tripId 為主鍵（/api/trip/:tripId），不再需要先選伺服器。
// 網頁的身分只有兩種：
//   - Discord 登入：cookie 自動帶上，寫入請求另外帶 x-requested-with 標頭
//     （service 端的 CSRF 檢查，見 lib/auth.js）。Bot 擁有者（OWNER_USER_ID）
//     登入後可以切換「列出所有行程」，不需要另外輸入金鑰。
//   - 分享連結訪客：token 只放在網址路徑 /api/shared-trip/:token/...（見 shareGuest.js）
// SPLITBILL_API_KEY 只給 Bot／維運腳本用，網頁不再接受。
let currentUser = null;      // { id, name, avatar, admin } | null
let oauthEnabled = false;
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
  if (currentUser && trip.members.some(m => m.discordId === currentUser.id)) return 'member';
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
  }catch(e){
    currentUser = null;
  }
  renderAccountArea();
  return currentUser;
}
function loginWithDiscord(next){
  const target = next || (location.pathname + location.search + location.hash);
  location.href = `/auth/discord/login?next=${encodeURIComponent(target)}`;
}
async function logout(){
  try{
    await fetch('/auth/logout', { method: 'POST', headers: { 'x-requested-with': 'splitbill' } });
  }catch(e){}
  clearOwnerConnectionState();
  location.reload();
}
// 換一個 Discord 帳號：先登出，再帶 switch=1 去 Discord。登出不會登出 Discord 本身，
// 一般登入授權過就直接導回來；switch=1 一定顯示同意畫面，上面有「不是你？」可以換帳號（與音樂庫相同）
async function switchAccount(){
  try{
    await fetch('/auth/logout', { method: 'POST', headers: { 'x-requested-with': 'splitbill' } });
  }catch(e){}
  clearOwnerConnectionState();
  location.href = `/auth/discord/login?switch=1&next=${encodeURIComponent('/')}`;
}
// Discord 登入導回來的結果（?login=cancelled／failed）：顯示提示，並從網址拿掉
function showLoginResultFromUrl(){
  let u;
  try{ u = new URL(location.href); }catch(e){ return; }
  const result = u.searchParams.get('login');
  if (!result) return;
  u.searchParams.delete('login');
  history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  if (result === 'cancelled') toast('已取消 Discord 登入', 'info');
  else toast('Discord 登入失敗，請稍後再試一次', 'error');
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
      toast(err.status === 401 ? '請先用 Discord 登入' : ('讀取行程清單失敗：' + err.message), 'error');
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
  if (!currentUser){ toast('請先用 Discord 登入', 'error'); return null; }
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
