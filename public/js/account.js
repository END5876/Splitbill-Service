'use strict';
// 🆕 [行程獨立化] 帳號與 Discord 連結相關的畫面：
//   - 帳號區塊（登入／登出、🆕 Discord ⇄ LINE 帳號綁定）
//   - 成員名單上的連結狀態與解除連結
//   - Discord 綁定（產生綁定碼、解除綁定）
// 所有權限都由 service 判斷；這裡只依身分決定「要不要顯示某個按鈕」。

/* ===================== 頁首帳號鈕 ===================== */
// 頁首右側的頭像：點開選單看「已用 Discord／LINE 登入」、換帳號、登出。分享連結訪客沒有帳號，不顯示
function accountAvatarHtml(cls){
  return currentUser.avatar
    ? `<img class="${cls}" src="${escapeHtml(currentUser.avatar)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="${cls} account-avatar-fallback">${escapeHtml(Array.from(currentUser.name || '?')[0])}</span>`;
}
// 只依登入身分（fetchMe）與是否是分享連結訪客（applyGuestModeUI）決定，那兩處各呼叫一次
function renderHeaderAccount(){
  const btn = document.getElementById('headerAcctBtn');
  const menu = document.getElementById('headerAcctMenu');
  if (!btn || !menu) return;
  const show = !!currentUser && !shareMode;
  btn.hidden = !show;
  if (!show){ setAccountMenu(false); return; }
  const via = PROVIDER_LABELS[currentUser.provider] || 'Discord';
  const name = currentUser.name || `${via} 使用者`;
  btn.innerHTML = accountAvatarHtml('header-acct-avatar');
  btn.setAttribute('aria-label', `帳號：${name}`);
  menu.innerHTML = `
    <div class="acct-menu-info"><b>${escapeHtml(name)}</b><span>已用 ${via} 登入${currentUser.admin ? '，管理員' : ''}</span></div>
    <button class="acct-menu-item" type="button" data-click="openAccountSettings">帳號設定</button>
    <button class="acct-menu-item" type="button" data-click="switchAccount">換帳號</button>
    <button class="acct-menu-item" type="button" data-click="logout">登出</button>`;
}
function setAccountMenu(open){
  const btn = document.getElementById('headerAcctBtn');
  const menu = document.getElementById('headerAcctMenu');
  if (!btn || !menu || open === !menu.hidden) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open){ pushLayer('acctMenu', ()=>setAccountMenu(false)); const first = menu.querySelector('button'); if (first) first.focus(); }
  else dropLayer('acctMenu');
}
function toggleAccountMenu(){ setAccountMenu(document.getElementById('headerAcctMenu').hidden); }
function openAccountSettings(){ showMainTab('settings'); showSettingsSub('account'); } // 選單由下面的點擊監聽收起
document.addEventListener('click', (e)=>{
  if (e.target.closest('#headerAcctBtn')) return;
  if (e.target.closest('#headerAcctMenu')){ if (e.target.closest('button')) setAccountMenu(false); return; }
  setAccountMenu(false);
});
document.addEventListener('keydown', (e)=>{
  if (e.key !== 'Escape' || document.getElementById('headerAcctMenu')?.hidden !== false) return;
  setAccountMenu(false);
  document.getElementById('headerAcctBtn').focus();
});
// 用 Tab 離開選單就收起來
document.getElementById('headerAcctMenu')?.addEventListener('focusout', (e)=>{
  const to = e.relatedTarget;
  if (to && (to.closest('#headerAcctMenu') || to.closest('#headerAcctBtn'))) return;
  if (to) setAccountMenu(false);
});

/* ===================== 帳號區塊 ===================== */
function renderAccountArea(){
  const el = document.getElementById('accountArea');
  if (!el) return;
  // 正在輸入暱稱時（例如 SSE 推播觸發 renderAll），不要把輸入框重繪掉
  const editingNickname = document.activeElement && document.activeElement.id === 'myNicknameInput';
  if (editingNickname){
    // 只略過重繪帳號區塊，下面行程卡片的顯示狀態照常更新
  } else if (currentUser){
    const avatar = accountAvatarHtml('account-avatar');
    const via = PROVIDER_LABELS[currentUser.provider] || 'Discord';
    el.innerHTML = `
      <div class="account-row">
        ${avatar}
        <div class="account-meta">
          <div class="account-name">${escapeHtml(currentUser.name || `${via} 使用者`)}</div>
          <div class="hint" style="margin:0;">已用 ${via} 登入</div>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" data-click="switchAccount">換帳號</button>
        <button class="btn btn-ghost btn-sm" type="button" data-click="logout">登出</button>
      </div>
      ${accountLinkHtml()}
      ${myNicknameHtml()}`;
  } else if (oauthEnabled){
    el.innerHTML = `
      <p class="hint">只會讀取你的 ${loginProviderNames()} 名稱與頭像。</p>
      <div class="btn-row">${loginButtonsHtml()}</div>`;
  } else {
    el.innerHTML = `<p class="hint">這個網站尚未開啟登入，只能用朋友傳來的連結開啟行程。</p>`;
  }
  const tripCard = document.getElementById('myTripsCard');
  if (tripCard) tripCard.style.display = currentUser ? '' : 'none';
  const allRow = document.getElementById('showAllTripsRow');
  if (allRow){
    allRow.style.display = currentUser && currentUser.admin ? '' : 'none';
    document.getElementById('showAllTripsToggle').checked = showAllTrips();
  }
}

/* ===================== 🆕 帳號綁定（Discord ⇄ LINE） ===================== */
// 兩種登入都有開才顯示。主身分一律是 Discord（Mousebot 只認得 Discord 帳號）。
function accountLinkHtml(){
  if (!currentUser || !loginProviders.discord || !loginProviders.line) return '';
  const acc = currentUser.accounts || {};
  if (acc.discord && acc.line){
    return `
      <div class="account-link">
        <div class="account-link-status"><span class="link-badge linked">Discord ✓</span><span class="link-badge linked">LINE ✓</span><span class="hint" style="margin:0;">兩種都能登入這個帳號。</span></div>
        <button class="btn btn-ghost btn-sm" type="button" data-click="unlinkAccount">停用 LINE 登入</button>
      </div>`;
  }
  if (acc.discord){
    return `
      <div class="account-link">
        <p class="hint" style="margin:0;">之後在手機上可以用 LINE 一鍵登入。</p>
        <button class="btn btn-line btn-sm" type="button" ${act('click', 'linkAccount', 'line')}>加入 LINE 登入</button>
      </div>`;
  }
  return `
    <div class="account-link">
      <p class="hint" style="margin:0;">之後也能在 Discord 群組裡直接記帳。</p>
      <button class="btn btn-brass btn-sm" type="button" ${act('click', 'linkAccount', 'discord')}>加入 Discord 登入</button>
    </div>`;
}

/* ===================== 頁首快速切換行程 ===================== */
// 取代「設定 → 帳號 → 下拉選單 → 開啟」四步驟：點行程名稱旁的 ⇅ 直接挑。
async function openTripSwitcher(){
  if (!myTrips.length) await refreshTripList({ silent: true }).catch(()=>{});
  const items = myTrips.map(t => ({
    value: t.id,
    title: t.name + (t.id === currentTripId ? '（目前開啟）' : ''),
    sub: [ROLE_LABELS[t.role], t.archived ? '已封存' : '', t.guildId ? '已連到 Discord 伺服器' : ''].filter(Boolean).join('，')
  }));
  items.push({ value: '__new__', title: '＋ 建立新行程…' });
  const picked = await pickModal('切換行程', items);
  if (!picked || picked === currentTripId) return;
  if (picked === '__new__'){
    showMainTab('settings'); showSettingsSub('trip');
    const nameInput = document.getElementById('newTripName');
    requestAnimationFrame(()=>{ nameInput.scrollIntoView({ behavior:'smooth', block:'center' }); nameInput.focus(); });
    return;
  }
  document.getElementById('tripSelect').value = picked;
  await loadTripFromApi();
}

/* ===================== 我在這個行程的暱稱 ===================== */
// 已連結帳號的成員可以自己改在行程裡顯示的名字（跟成員名單改名走同一條存檔流程）。
function myTripMember(){
  if (!currentUser || !currentTripId || shareMode) return null;
  return trip.members.find(isMyMember) || null;
}
function myNicknameHtml(){
  const me = myTripMember();
  if (!me) return '';
  return `
    <div class="my-nickname field">
      <label for="myNicknameInput">我在「${escapeHtml(trip.name || '這個行程')}」的暱稱</label>
      <div class="btn-row">
        <input type="text" id="myNicknameInput" maxlength="60" value="${escapeHtml(me.name)}" data-enter="saveMyNickname">
        <button class="btn btn-brass btn-sm" type="button" data-click="saveMyNickname">儲存</button>
      </div>
      <p class="hint" style="margin-bottom:0;">其他成員看到的是這個名字。</p>
    </div>`;
}
function saveMyNickname(){
  const me = myTripMember();
  const input = document.getElementById('myNicknameInput');
  if (!me || !input) return;
  const name = input.value.trim().slice(0, 60);
  if (!name){ toast('請輸入暱稱', 'error'); input.value = me.name; return; }
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
  const isMe = isMyMember(m);
  const linked = !!memberAccountId(m);
  const canUnlink = linked && (canManageTrip() || isMe);
  const via = m.lineId ? 'LINE' : 'Discord';
  const badge = linked
    ? `<span class="link-badge linked" title="已連結 ${via} 帳號">🔗${isMe ? ' 你' : ''}</span>`
    : `<span class="link-badge" title="還沒有連結帳號：本人用邀請連結加入，選「我是哪一位」就會連結">未連結</span>`;
  const btn = canUnlink
    ? `<button class="btn btn-ghost btn-sm member-btn" type="button" ${act('click','unlinkMember',m.id)} title="解除這位成員與 ${via} 帳號的連結" aria-label="解除連結">${ICON_UNLINK}<span class="btn-label">解除連結</span></button>`
    : '';
  return badge + btn;
}
async function unlinkMember(memberId){
  const m = trip.members.find(x => x.id === memberId);
  if (!m) return;
  const isMe = isMyMember(m);
  const ok = await confirmModal(
    isMe
      ? '解除後，你就看不到這個行程了（除非你是建立者）。帳目都會保留。'
      : `解除後，他就看不到這個行程了。帳目都會保留，之後本人可以用邀請連結再選一次「我是哪一位」。`,
    { title: `解除「${m.name}」的帳號連結？`, confirmText:'解除連結', cancelText:'取消', danger:true }
  );
  if (!ok) return;
  try{
    await apiJson(await fetch(tripApiUrl(`/members/${encodeURIComponent(memberId)}/unlink`), { method: 'POST', headers: apiHeaders() }));
    // 只更新這一位的連結狀態；完整的新版本會由 SSE 推播過來（跟其他人的改動走同一條合併流程）
    delete m.discordId;
    delete m.lineId;
    renderAll();
    toast(`已解除「${m.name}」的連結`, 'success');
    if (isMe && !canManageTrip()){
      await refreshTripList({ silent: true }).catch(()=>{});
    }
  }catch(err){
    toast('沒有解除連結：' + err.message, 'error');
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
    el.innerHTML = '<p class="hint">請先到上方「我的行程」開啟一個雲端行程。</p>';
    return;
  }
  const manage = canManageTrip();
  if (trip.guildId){
    el.innerHTML = `
      <div class="discord-status on"><span class="dot"></span>已連到 Discord 伺服器 <code class="inline">${escapeHtml(trip.guildId)}</code></div>
      <p class="hint">在那個伺服器輸入 <code class="inline">/splitbill panel</code> 就能記帳。</p>
      ${manage ? `<div class="btn-row"><button class="btn btn-danger btn-sm" type="button" data-click="detachFromDiscord" data-loading="處理中…">中斷與伺服器的連線</button></div>` : ''}`;
    return;
  }
  const code = lastBindCode && lastBindCode.tripId === currentTripId && lastBindCode.expiresAt > Date.now() ? lastBindCode : null;
  el.innerHTML = `
    <div class="discord-status"><span class="dot"></span>還沒有連到 Discord 伺服器</div>
    <p class="hint">連上後，伺服器裡的人可以用 <code class="inline">/splitbill panel</code> 記帳。</p>
    ${manage ? `
      <ol class="discord-steps">
        <li>按下方「產生連線碼」（10 分鐘內有效、只能用一次）</li>
        <li>到要連線的伺服器，輸入顯示的指令（要由你本人執行）</li>
      </ol>
      ${code ? `
        <div class="bind-code-box">
          <div class="bind-code">${escapeHtml(code.code)}</div>
          <div class="bind-code-cmd"><code class="inline">${escapeHtml(code.command)}</code></div>
          <div class="hint" id="bindCodeExpiry"></div>
          <div class="btn-row" style="justify-content:center;">
            <button class="btn btn-brass btn-sm" type="button" data-click="copyBindCommand">複製指令</button>
          </div>
        </div>` : ''}
      <div class="btn-row"><button class="btn ${code ? 'btn-ghost' : 'btn-brass'}" type="button" data-click="generateBindCode" data-loading="產生中…">${code ? '重新產生連線碼' : '產生連線碼'}</button></div>
    ` : '<p class="hint">只有行程建立者可以把行程連到 Discord 伺服器。</p>'}`;
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
    toast('沒有產生連線碼：' + err.message, 'error');
  }
}
async function copyBindCommand(){
  if (!lastBindCode) return;
  try{
    await navigator.clipboard.writeText(lastBindCode.command);
    toast('已複製指令，到 Discord 伺服器貼上送出就好', 'success');
  }catch(e){
    toast('沒辦法自動複製，請長按上方的指令複製。', 'error');
  }
}
async function detachFromDiscord(){
  const ok = await confirmModal('中斷後，Discord 的 /splitbill panel 就看不到這個行程了。網頁和帳目不受影響，之後可以再連回來。', { title:'中斷與 Discord 伺服器的連線？', confirmText:'中斷連線', cancelText:'取消', danger:true });
  if (!ok) return;
  try{
    const body = await apiJson(await fetch(tripApiUrl('/detach'), { method: 'POST', headers: apiHeaders() }));
    trip.guildId = body.trip ? body.trip.guildId : null;
    lastBindCode = null;
    renderDiscordPanel();
    refreshTripList({ silent: true }).catch(()=>{});
    toast('已中斷與伺服器的連線', 'success');
  }catch(err){
    toast('沒有中斷成功：' + err.message, 'error');
  }
}
