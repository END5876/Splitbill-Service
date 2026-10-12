'use strict';
// 🆕 [行程連結] 「設定 → 成員與分享」的「邀請與分享」卡片：
//   - 成員：複製預設的邀請連結（只能用 Discord 登入加入，不開放訪客）
//   - 建立者：建立／修改／撤銷所有連結，每條連結各自設定「訪客權限」與「允許登入加入」
// 分享連結與邀請連結已經合併成同一種連結（見 routes/links.js），朋友點開後由
// bootstrap.js 的 resolveEntry() 決定要開啟行程、顯示加入畫面，還是以訪客身分開啟。

// 把 token 組成朋友可以直接點的網址。刻意放在 URL 的 hash（# 之後）而不是 query
// string：hash 完全不會被送到伺服器，不會出現在伺服器/代理的存取紀錄裡，也不會被
// Referrer 帶到第三方。頁面載入時讀到後會立刻清掉網址列（見 linkEntry.js）。
function buildLinkUrl(token){
  const url = new URL(location.href);
  url.search = '';
  url.hash = `link=${token}`;
  return url.toString();
}
async function copyLinkUrl(token, okMessage){
  const url = buildLinkUrl(token);
  try{
    await navigator.clipboard.writeText(url);
    toast(okMessage || '已複製連結，貼給朋友即可（請勿公開分享）', 'success');
  }catch(e){
    toast('複製失敗，這是連結網址（請手動複製）：' + url, 'error', { duration: 12000 });
  }
}

const LINK_GUEST_OPTIONS = [
  { value: 'none',  label: '🔒 不開放訪客' },
  { value: 'read',  label: '👀 訪客唯讀' },
  { value: 'write', label: '✏️ 訪客可編輯' },
];
// 一句話說明這條連結點開後會發生什麼事
function describeLink(l){
  const guest = { none: '', read: '不登入可以檢視', write: '不登入可以檢視與編輯' }[l.guest] || '';
  const join = l.join ? '用 Discord 登入可以加入成為成員' : '';
  return [guest, join].filter(Boolean).join('；');
}

/* ===================== 邀請（所有成員） ===================== */
// 同步、很便宜：renderAll() 每次都會呼叫
function renderInviteSection(){
  const card = document.getElementById('tripLinksCard');
  if (!card) return;
  const role = currentTripRole();
  const isMember = !!currentTripId && !shareMode && (role === 'owner' || role === 'member' || role === 'admin');
  document.getElementById('tripLinksNoTripHint').style.display = isMember ? 'none' : '';
  document.getElementById('inviteSection').style.display = isMember ? '' : 'none';
  if (!isMember) return;
  const unlinked = trip.members.filter(m => !m.discordId).length;
  document.getElementById('inviteCardHint').textContent = unlinked
    ? `目前有 ${unlinked} 位成員還沒連結 Discord 帳號。把邀請連結傳給他們，用 Discord 登入後選「我是哪一位」，就能一起看帳、記帳（過去的帳目都會保留）。`
    : '把邀請連結傳給朋友，他們用 Discord 登入後就能以新成員身分加入，一起記帳。';
}
async function copyInviteLink(){
  try{
    const { token } = await apiJson(await fetch(tripApiUrl('/invite'), { headers: apiHeaders() }));
    await copyLinkUrl(token, '已複製邀請連結，傳給還沒加入的朋友即可（請不要公開張貼）');
    if (canManageTrip()) renderTripLinksPanel(); // 第一次邀請時會自動建立一條，讓清單同步
  }catch(err){
    toast('取得邀請連結失敗：' + err.message, 'error');
  }
}

/* ===================== 連結管理（建立者） ===================== */
async function renderTripLinksPanel(){
  renderInviteSection();
  const manageArea = document.getElementById('linkManageArea');
  if (!currentTripId || shareMode || !canManageTrip()){
    manageArea.style.display = 'none';
    return;
  }
  manageArea.style.display = '';

  const listEl = document.getElementById('linkList');
  const countEl = document.getElementById('linkCount');
  try{
    const links = await apiJson(await fetch(tripApiUrl('/links'), { headers: apiHeaders() }));
    countEl.textContent = `(${links.length})`;
    listEl.innerHTML = links.length ? links.slice().sort((a,b)=>b.createdAt-a.createdAt).map(l => {
      const expired = l.expiresAt && l.expiresAt < Date.now();
      const expiryLabel = l.expiresAt ? `${expired ? '已過期' : '到期'}：${new Date(l.expiresAt).toLocaleDateString('zh-TW')}` : '永久有效';
      const token = escapeHtml(l.token);
      const safeLabel = escapeHtml(l.label || '此連結').replace(/'/g,"\\'");
      return `<div class="ledger-row">
        <div class="ledger-main">
          <div class="ledger-title">${escapeHtml(l.label || '（未命名連結）')}</div>
          <div class="ledger-sub">${escapeHtml(describeLink(l))}　·　${expiryLabel}</div>
          <div class="ledger-sub link-options">
            <select class="convert-select" aria-label="訪客權限" onchange="updateTripLink('${token}', { guest: this.value })">
              ${LINK_GUEST_OPTIONS.map(o => `<option value="${o.value}" ${l.guest===o.value?'selected':''}>${o.label}</option>`).join('')}
            </select>
            <label class="check-row"><input type="checkbox" ${l.join?'checked':''} onchange="updateTripLink('${token}', { join: this.checked })">允許登入加入</label>
          </div>
          <div class="ledger-actions">
            <button class="btn btn-brass btn-sm" onclick="copyLinkUrl('${token}')">🔗 複製連結</button>
            <button class="btn btn-danger btn-sm" onclick="revokeTripLink('${token}', '${safeLabel}')">撤銷</button>
          </div>
        </div>
      </div>`;
    }).join('') : emptyState('🔗', '還沒有任何連結', null, '');
  }catch(err){
    listEl.innerHTML = '';
    countEl.textContent = '';
    toast('讀取連結失敗：' + err.message, 'error');
  }
}

async function createTripLink(){
  if (!currentTripId){ toast('請先開啟一個雲端行程。', 'error'); return; }
  const label = document.getElementById('linkLabel').value.trim();
  const guest = document.getElementById('linkGuest').value;
  const join = document.getElementById('linkJoin').checked;
  const expiresInDays = parseInt(document.getElementById('linkExpiry').value, 10) || 0;
  if (guest === 'none' && !join){
    toast('連結至少要開放訪客存取，或允許登入加入其中一項', 'error');
    return;
  }
  try{
    const link = await apiJson(await fetch(tripApiUrl('/links'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
      body: JSON.stringify({ label, guest, join, expiresInDays })
    }));
    document.getElementById('linkLabel').value = '';
    await renderTripLinksPanel();
    await confirmModal(
      `已建立連結（${describeLink(link)}）。點「確定」會把連結複製到剪貼簿，貼給朋友即可，請不要公開分享這組網址。`,
      { confirmText: '複製連結並關閉', cancelText: '稍後再說' }
    ) && await copyLinkUrl(link.token);
  }catch(err){
    toast('建立連結失敗：' + err.message, 'error');
  }
}

// 隨時修改既有連結的設定，對方手上的網址完全不變，下一次開啟或儲存時就會套用。
async function updateTripLink(token, patch){
  try{
    const link = await apiJson(await fetch(tripApiUrl(`/links/${encodeURIComponent(token)}`), {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
      body: JSON.stringify(patch)
    }));
    toast('已更新：' + describeLink(link), 'success');
  }catch(err){
    toast('修改連結失敗：' + err.message, 'error');
  }
  renderTripLinksPanel(); // 成功時更新說明文字；失敗時把選單還原成伺服器上的設定
}

async function revokeTripLink(token, label){
  const ok = await confirmModal(`確定要撤銷「${label}」嗎？撤銷後，任何拿著這個連結的人都會立刻無法再用它開啟或加入行程（已經加入的成員不受影響）。`, { danger:true, confirmText:'確定撤銷' });
  if (!ok) return;
  try{
    await apiJson(await fetch(tripApiUrl(`/links/${encodeURIComponent(token)}`), { method: 'DELETE', headers: apiHeaders() }));
    toast('已撤銷連結', 'success');
    renderTripLinksPanel();
  }catch(err){
    toast('撤銷失敗：' + err.message, 'error');
  }
}
