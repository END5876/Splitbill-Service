'use strict';
// 🆕 [行程獨立化] 帳號與 Discord 連結相關的畫面：
//   - 帳號區塊（登入／登出）
//   - 成員名單上的連結狀態與解除連結
//   - Discord 綁定（產生綁定碼、解除綁定）
// 所有權限都由 service 判斷；這裡只依身分決定「要不要顯示某個按鈕」。

/* ===================== 帳號區塊 ===================== */
function renderAccountArea(){
  const el = document.getElementById('accountArea');
  if (!el) return;
  // 正在輸入暱稱時（例如 SSE 推播觸發 renderAll），不要把輸入框重繪掉
  const editingNickname = document.activeElement && document.activeElement.id === 'myNicknameInput';
  if (editingNickname){
    // 只略過重繪帳號區塊，下面行程卡片的顯示狀態照常更新
  } else if (currentUser){
    const avatar = currentUser.avatar
      ? `<img class="account-avatar" src="${escapeHtml(currentUser.avatar)}" alt="" referrerpolicy="no-referrer">`
      : `<span class="account-avatar account-avatar-fallback">${escapeHtml((currentUser.name || '?').slice(0,1))}</span>`;
    el.innerHTML = `
      <div class="account-row">
        ${avatar}
        <div class="account-meta">
          <div class="account-name">${escapeHtml(currentUser.name || 'Discord 使用者')}</div>
          <div class="hint" style="margin:0;">已用 Discord 登入</div>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" onclick="logout()">登出</button>
      </div>
      ${myNicknameHtml()}`;
  } else if (oauthEnabled){
    el.innerHTML = `
      <p class="hint">用 Discord 帳號登入後，就能建立自己的行程、邀請朋友一起記帳。只會讀取你的 Discord 名稱與頭像。</p>
      <div class="btn-row"><button class="btn btn-brass" type="button" onclick="loginWithDiscord()">用 Discord 登入</button></div>`;
  } else {
    el.innerHTML = `<p class="hint">這個網站尚未開啟 Discord 登入，只能用朋友傳來的連結開啟行程。</p>`;
  }
  const tripCard = document.getElementById('myTripsCard');
  if (tripCard) tripCard.style.display = currentUser ? '' : 'none';
  const allRow = document.getElementById('showAllTripsRow');
  if (allRow){
    allRow.style.display = currentUser && currentUser.admin ? '' : 'none';
    document.getElementById('showAllTripsToggle').checked = showAllTrips();
  }
}

/* ===================== 頁首快速切換行程 ===================== */
// 取代「設定 → 帳號 → 下拉選單 → 開啟」四步驟：點行程名稱旁的 ⇅ 直接挑。
async function openTripSwitcher(){
  if (!myTrips.length) await refreshTripList({ silent: true }).catch(()=>{});
  const items = myTrips.map(t => ({
    value: t.id,
    title: t.name + (t.id === currentTripId ? '（目前開啟）' : ''),
    sub: [ROLE_LABELS[t.role], t.archived ? '已封存' : '', t.guildId ? '🤖 已綁定 Discord' : ''].filter(Boolean).join(' · ')
  }));
  items.push({ value: '__new__', title: '＋ 建立新行程…' });
  const picked = await pickModal('切換行程', items);
  if (!picked || picked === currentTripId) return;
  if (picked === '__new__'){
    showMainTab('settings'); showSettingsSub('account');
    const nameInput = document.getElementById('newTripName');
    requestAnimationFrame(()=>{ nameInput.scrollIntoView({ behavior:'smooth', block:'center' }); nameInput.focus(); });
    return;
  }
  document.getElementById('tripSelect').value = picked;
  await loadTripFromApi();
}

/* ===================== 我在這個行程的暱稱 ===================== */
// 已連結 Discord 的成員可以自己改在行程裡顯示的名字（跟成員名單改名走同一條存檔流程）。
function myTripMember(){
  if (!currentUser || !currentTripId || shareMode) return null;
  return trip.members.find(m => m.discordId === currentUser.id) || null;
}
function myNicknameHtml(){
  const me = myTripMember();
  if (!me) return '';
  return `
    <div class="my-nickname field">
      <label for="myNicknameInput">我在「${escapeHtml(trip.name || '這個行程')}」的暱稱</label>
      <div class="btn-row">
        <input type="text" id="myNicknameInput" maxlength="60" value="${escapeHtml(me.name)}" onkeydown="if(event.key==='Enter'){event.preventDefault(); saveMyNickname();}">
        <button class="btn btn-brass btn-sm" type="button" onclick="saveMyNickname()">儲存</button>
      </div>
      <p class="hint" style="margin-bottom:0;">其他成員在帳目、結算與 Discord 面板上看到的都是這個名字。</p>
    </div>`;
}
function saveMyNickname(){
  const me = myTripMember();
  const input = document.getElementById('myNicknameInput');
  if (!me || !input) return;
  const name = input.value.trim().slice(0, 60);
  if (!name){ toast('暱稱不能是空的', 'error'); input.value = me.name; return; }
  input.blur();
  if (name === me.name) return;
  me.name = name;
  renderAll();
  scheduleCloudSave();
  toast(`暱稱已改成「${name}」`, 'success');
}

/* ===================== 成員連結狀態 ===================== */
// 給 render.js 的成員名單用：回傳每位成員右側的連結狀態標籤（只在開啟雲端行程時顯示）。
function memberLinkBadgeHtml(m){
  if (!currentTripId || shareMode) return '';
  const isMe = currentUser && m.discordId === currentUser.id;
  const canUnlink = m.discordId && (canManageTrip() || isMe);
  const badge = m.discordId
    ? `<span class="link-badge linked" title="已連結 Discord 帳號">🔗${isMe ? ' 你' : ''}</span>`
    : `<span class="link-badge" title="尚未連結 Discord：可以用邀請連結讓本人認領">未連結</span>`;
  const btn = canUnlink
    ? `<button class="btn btn-ghost btn-sm member-btn" type="button" onclick="unlinkMember('${escapeHtml(m.id)}')" title="解除這位成員與 Discord 帳號的連結" aria-label="解除連結">${ICON_UNLINK}<span class="btn-label">解除連結</span></button>`
    : '';
  return badge + btn;
}
async function unlinkMember(memberId){
  const m = trip.members.find(x => x.id === memberId);
  if (!m) return;
  const isMe = currentUser && m.discordId === currentUser.id;
  const ok = await confirmModal(
    isMe
      ? `確定要解除你跟「${m.name}」的連結嗎？解除後你會失去這個行程的存取權（除非你是建立者），帳目都會保留。`
      : `確定要解除「${m.name}」與 Discord 帳號的連結嗎？他會失去這個行程的存取權，帳目都會保留，之後可以用邀請連結重新認領。`,
    { confirmText:'解除連結', danger:true }
  );
  if (!ok) return;
  try{
    await apiJson(await fetch(tripApiUrl(`/members/${encodeURIComponent(memberId)}/unlink`), { method: 'POST', headers: apiHeaders() }));
    // 只更新這一位的連結狀態；完整的新版本會由 SSE 推播過來（跟其他人的改動走同一條合併流程）
    delete m.discordId;
    renderAll();
    toast(`已解除「${m.name}」的連結`, 'success');
    if (isMe && !canManageTrip()){
      await refreshTripList({ silent: true }).catch(()=>{});
    }
  }catch(err){
    toast('解除連結失敗：' + err.message, 'error');
  }
}

/* ===================== Discord 綁定 ===================== */
let lastBindCode = null; // { tripId, code, command, expiresAt }
let bindCodeTimer = null;
function renderDiscordPanel(){
  const el = document.getElementById('discordPanelBody');
  if (!el) return;
  clearInterval(bindCodeTimer); bindCodeTimer = null;
  if (!currentTripId){
    el.innerHTML = '<p class="hint">請先到「帳號」開啟一個雲端行程。</p>';
    return;
  }
  const manage = canManageTrip();
  if (trip.guildId){
    el.innerHTML = `
      <div class="discord-status on"><span class="dot"></span>已綁定到 Discord 伺服器 <code class="inline">${escapeHtml(trip.guildId)}</code></div>
      <p class="hint">在那個伺服器輸入 <code class="inline">/splitbill</code> 就能用 Mousebot 的面板操作這個行程。已連結 Discord 的成員可以操作面板；尚未連結的成員在 Discord 只會顯示名字。</p>
      ${manage ? `<div class="btn-row"><button class="btn btn-danger btn-sm" type="button" onclick="withLoading(this,'處理中…',detachFromDiscord)">解除綁定</button></div>
      <p class="hint">解除綁定後 Discord 面板就看不到這個行程了；網頁、分享連結與帳目都不受影響，之後可以重新綁定（也可以綁到別的伺服器）。</p>` : ''}`;
    return;
  }
  const code = lastBindCode && lastBindCode.tripId === currentTripId && lastBindCode.expiresAt > Date.now() ? lastBindCode : null;
  el.innerHTML = `
    <div class="discord-status"><span class="dot"></span>尚未綁定任何 Discord 伺服器</div>
    <p class="hint">綁定後，伺服器裡的人可以用 Mousebot 的 <code class="inline">/splitbill</code> 面板記帳、結算，跟網頁即時同步。</p>
    ${manage ? `
      <ol class="discord-steps">
        <li>按下方「產生綁定碼」（10 分鐘內有效、只能用一次）</li>
        <li>到要綁定的伺服器，輸入顯示的指令（要由你本人執行）</li>
      </ol>
      ${code ? `
        <div class="bind-code-box">
          <div class="bind-code">${escapeHtml(code.code)}</div>
          <div class="bind-code-cmd"><code class="inline">${escapeHtml(code.command)}</code></div>
          <div class="hint" id="bindCodeExpiry"></div>
          <div class="btn-row" style="justify-content:center;">
            <button class="btn btn-brass btn-sm" type="button" onclick="copyBindCommand()">複製指令</button>
          </div>
        </div>` : ''}
      <div class="btn-row"><button class="btn ${code ? 'btn-ghost' : 'btn-brass'}" type="button" onclick="withLoading(this,'產生中…',generateBindCode)">${code ? '重新產生綁定碼' : '產生綁定碼'}</button></div>
    ` : '<p class="hint">只有行程建立者可以把行程綁定到 Discord 伺服器。</p>'}`;
  if (code){
    const tick = ()=>{
      const left = Math.max(0, code.expiresAt - Date.now());
      const el2 = document.getElementById('bindCodeExpiry');
      if (!el2){ clearInterval(bindCodeTimer); return; }
      if (!left){ clearInterval(bindCodeTimer); renderDiscordPanel(); return; }
      el2.textContent = `剩下 ${Math.floor(left/60000)} 分 ${String(Math.floor(left/1000)%60).padStart(2,'0')} 秒`;
    };
    tick();
    bindCodeTimer = setInterval(tick, 1000);
  }
}
async function generateBindCode(){
  try{
    const body = await apiJson(await fetch(tripApiUrl('/bind-code'), { method: 'POST', headers: apiHeaders() }));
    lastBindCode = Object.assign({ tripId: currentTripId }, body);
    renderDiscordPanel();
  }catch(err){
    toast('產生綁定碼失敗：' + err.message, 'error');
  }
}
async function copyBindCommand(){
  if (!lastBindCode) return;
  try{
    await navigator.clipboard.writeText(lastBindCode.command);
    toast('已複製指令，到 Discord 伺服器貼上送出即可', 'success');
  }catch(e){
    toast('複製失敗，請手動輸入：' + lastBindCode.command, 'error');
  }
}
async function detachFromDiscord(){
  const ok = await confirmModal('確定要解除綁定嗎？Discord 面板將看不到這個行程（網頁與帳目不受影響）。', { confirmText:'解除綁定', danger:true });
  if (!ok) return;
  try{
    const body = await apiJson(await fetch(tripApiUrl('/detach'), { method: 'POST', headers: apiHeaders() }));
    trip.guildId = body.trip ? body.trip.guildId : null;
    lastBindCode = null;
    renderDiscordPanel();
    refreshTripList({ silent: true }).catch(()=>{});
    toast('已解除綁定', 'success');
  }catch(err){
    toast('解除綁定失敗：' + err.message, 'error');
  }
}
