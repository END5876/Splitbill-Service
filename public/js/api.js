'use strict';
// 連線 splitbill-service 的基礎設施：身分（Discord 登入／管理員金鑰）、目前行程、
// 即時匯率查詢、「我的行程」清單、記住上次開的行程。
/* ===================== connection ===================== */
// 🆕 [行程獨立化] 行程以 tripId 為主鍵（/api/trip/:tripId），不再需要先選伺服器。
// 身分有兩種：
//   - Discord 登入（主要用法）：cookie 自動帶上，寫入請求另外帶 x-requested-with
//     標頭（service 端的 CSRF 檢查，見 lib/auth.js）
//   - 管理員金鑰（進階／維運）：在「行程 → 進階」填 SPLITBILL_API_KEY，可看到所有行程
let currentUser = null;      // { id, name, avatar } | null
let oauthEnabled = false;
let myTrips = [];            // GET /api/my/trips 的結果（含 role）
let currentTripId = null;    // 目前「連線中」的雲端行程；null＝離線編輯（本機檔案／匯入）
let lastSyncedTripJSON = null; // 用來做簡單的樂觀鎖：跟伺服器目前的版本比對，偵測是否被別人改過

function apiBaseUrl(){
  const v = document.getElementById('apiBase').value.trim();
  return v ? v.replace(/\/+$/,'') : ''; // 空字串 = 使用目前網址（同源）
}
function usingAdminKey(){
  return !!document.getElementById('apiKey').value.trim();
}
function apiHeaders(){
  const key = document.getElementById('apiKey').value.trim();
  return key ? { 'x-api-key': key } : { 'x-requested-with': 'splitbill' };
}
// 一定要以「Discord 登入者本人」身分呼叫的端點（建立／上傳行程）：只帶 cookie，
// 不帶管理員金鑰——金鑰欄位有值（例如被瀏覽器密碼管理員自動填入）時，
// 帶 x-api-key 會讓 service 端把請求當成管理端／分享連結，因而沒有 Discord 身分。
function userHeaders(){
  return { 'x-requested-with': 'splitbill' };
}
// 🆕 [分享連結] 給「擁有者/分享連結都可能呼叫」的共用工具端點用（即時匯率、
// 帳單辨識）：分享連結模式下用連結自己的 token 當憑證，否則沿用一般身分。
function apiHeadersAny(){
  if (shareMode) return { 'x-api-key': shareMode.token };
  return apiHeaders();
}
function isConnected(){ return !!currentTripId; }
function tripApiUrl(suffix){
  return `${apiBaseUrl()}/api/trip/${encodeURIComponent(currentTripId)}${suffix || ''}`;
}
// 目前行程裡「我」的身分：'admin' | 'owner' | 'member' | null
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
    const res = await fetch(`${apiBaseUrl()}/api/fx-rate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers: apiHeadersAny() });
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
    const res = await fetch(apiBaseUrl() + '/api/me', { credentials: 'same-origin' });
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
  location.href = `${apiBaseUrl()}/auth/discord/login?next=${encodeURIComponent(target)}`;
}
async function logout(){
  try{
    await fetch(apiBaseUrl() + '/auth/logout', { method: 'POST', headers: { 'x-requested-with': 'splitbill' } });
  }catch(e){}
  clearOwnerConnectionState();
  location.reload();
}

/* ===================== 我的行程 ===================== */
async function refreshTripList(opts){
  opts = opts || {};
  try{
    const res = await fetch(apiBaseUrl() + '/api/my/trips', { headers: apiHeaders() });
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

// 🆕 記住上次開的行程（連同 API 位址與管理員金鑰），下次重新整理頁面時可以
// 自動接回去。存在 localStorage：這是「你自己這台裝置」記住「你自己的」設定，
// 資料不會被送到任何地方。
const OWNER_CONNECTION_STORAGE_KEY = 'splitbill-owner-connection';
function saveOwnerConnectionState(){
  try{
    if (!currentTripId) return;
    localStorage.setItem(OWNER_CONNECTION_STORAGE_KEY, JSON.stringify({
      apiBase: document.getElementById('apiBase').value.trim(),
      apiKey: document.getElementById('apiKey').value.trim(),
      tripId: currentTripId,
    }));
  }catch(e){}
}
function clearOwnerConnectionState(){
  try{ localStorage.removeItem(OWNER_CONNECTION_STORAGE_KEY); }catch(e){}
}
// 頁面載入時「安靜地」嘗試接回上次的行程：接不回去（金鑰換過、行程被刪除、
// 已經不是成員）就悄悄退回一般狀態，不跳錯誤訊息。
async function restoreOwnerConnectionState(){
  let saved = null;
  try{ saved = JSON.parse(localStorage.getItem(OWNER_CONNECTION_STORAGE_KEY) || 'null'); }catch(e){}
  if (!saved || !saved.tripId) return false;
  // 舊版存的是 guildId＋tripId，tripId 本身仍然有效，直接沿用
  document.getElementById('apiKey').value = saved.apiKey || '';
  document.getElementById('apiBase').value = saved.apiBase || '';
  if (!saved.apiKey && !currentUser) return false;
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
    const res = await fetch(apiBaseUrl() + '/api/trips', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, currentUser ? userHeaders() : apiHeaders()),
      body: JSON.stringify({ name, baseCurrency })
    });
    const created = await apiJson(res);
    nameInput.value = '';
    await refreshTripList({ silent: true });
    document.getElementById('tripSelect').value = created.id;
    await loadTripFromApi({ quiet: true });
    toast(`已建立行程「${created.name}」，可以到「👥 成員」新增朋友並傳邀請連結給他們`, 'success', { duration: 6000 });
  }catch(err){
    toast('建立行程失敗：' + err.message, 'error');
  }
}

// 把畫面上離線編輯（或從 JSON 匯入）的行程整份上傳成新的雲端行程。
// 會先問「你是哪一位」，讓那位成員連結到自己的 Discord 帳號；其他人之後用邀請連結認領。
async function uploadLocalTripToServer(){
  if (!currentUser){ toast('請先用 Discord 登入', 'error'); return; }
  let selfMemberId = '';
  if (trip.members.length){
    // 選中的成員會連結到自己的 Discord 帳號；其他成員之後可以用邀請連結自己認領
    selfMemberId = await pickModal('上傳成雲端行程：這個行程裡哪一位是你？', [
      ...trip.members.map(m => ({ value: m.id, title: m.name })),
      { value: '', title: '都不是', sub: '另外把我加成一位新成員' },
    ]);
    if (selfMemberId === null) return; // 取消
  }
  try{
    const res = await fetch(apiBaseUrl() + '/api/trips', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, currentUser ? userHeaders() : apiHeaders()),
      body: JSON.stringify({
        name: trip.name,
        baseCurrency: trip.baseCurrency,
        rates: trip.rates,
        memberName: currentUser.name,
        selfMemberId: selfMemberId || undefined,
        content: { members: trip.members, expenses: trip.expenses, deposits: trip.deposits },
      })
    });
    const created = await apiJson(res);
    await refreshTripList({ silent: true });
    document.getElementById('tripSelect').value = created.id;
    await loadTripFromApi({ quiet: true });
    toast(`已上傳成雲端行程「${created.name}」`, 'success');
  }catch(err){
    toast('上傳失敗：' + err.message, 'error');
  }
}
