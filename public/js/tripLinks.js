'use strict';
// 🆕 [行程連結] 「設定 → 成員與分享」的「邀請與分享」卡片，整張由這裡依狀態繪出：
//   - 上半部「邀請朋友加入」：所有成員都能一鍵複製預設的邀請連結
//   - 下半部「所有連結」：建立者管理每一條連結（新增、修改設定、撤銷）
// 分享連結與邀請連結已經合併成同一種連結（見 routes/links.js）：每條連結各自設定
// 「不登入的訪客能做什麼」與「能不能用 Discord 登入加入」。朋友點開後由
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

/* ===================== 連結的用途與文字 ===================== */
// 新增連結時的三種用途；之後還是可以在每條連結的「設定」裡個別調整。
const LINK_PRESETS = [
  { id: 'invite', icon: '🔑', title: '邀請成員',     sub: '用 Discord 登入，選「我是哪一位」後一起記帳', guest: 'none',  join: true,  days: 0 },
  { id: 'read',   icon: '👀', title: '給人看帳',     sub: '不用登入就能看，不能修改',                 guest: 'read',  join: false, days: 7 },
  { id: 'write',  icon: '✏️', title: '免登入一起記帳', sub: '不用登入就能新增、修改、刪除',             guest: 'write', join: false, days: 7 },
];
const LINK_GUEST_LABELS = { none: '不開放', read: '唯讀', write: '可編輯' };
const LINK_EXPIRY_CHOICES = [ { days: 1, label: '1 天' }, { days: 7, label: '7 天' }, { days: 30, label: '30 天' }, { days: 0, label: '永久' } ];

function linkIcon(l){
  if (l.guest === 'write') return '✏️';
  if (l.guest === 'read') return '👀';
  return '🔑';
}
function linkDefaultName(l){
  if (l.guest === 'none') return '邀請連結';
  return l.guest === 'write' ? '免登入記帳連結' : '看帳連結';
}
function linkIsExpired(l){ return !!l.expiresAt && l.expiresAt < Date.now(); }
function linkExpiryText(l){
  if (!l.expiresAt) return '永久有效';
  const left = l.expiresAt - Date.now();
  if (left <= 0) return '已過期';
  const days = Math.ceil(left / 86400000);
  return days <= 1 ? '今天到期' : `${days} 天後到期`;
}
// 成員按「複製邀請連結」時伺服器會用哪一條（最早建立、仍有效、只能加入）——跟 routes/links.js 一致
function defaultInviteToken(links){
  const l = links.filter(x => x.join && x.guest === 'none' && !linkIsExpired(x)).sort((a,b)=>a.createdAt-b.createdAt)[0];
  return l ? l.token : null;
}

/* ===================== 狀態 ===================== */
let tripLinksState = {
  tripId: null,
  links: null,        // null＝還沒讀到
  error: null,
  composer: null,     // { preset, join, days, label }：新增連結的表單；null＝收起
  editing: null,      // { token, guest, join, label }：正在設定的那一條
};
function resetTripLinksState(){
  tripLinksState = { tripId: currentTripId, links: null, error: null, composer: null, editing: null };
}
function isTripMember(){
  const role = currentTripRole();
  return !!currentTripId && !shareMode && (role === 'owner' || role === 'member' || role === 'admin');
}

/* ===================== 繪製 ===================== */
// 上半部：每次 renderAll() 都會呼叫，只有按鈕沒有輸入框，重繪很安全
function renderInviteSection(){
  const el = document.getElementById('inviteHero');
  if (!el) return;
  if (!isTripMember()){
    el.innerHTML = `<p class="hint" style="margin:0;">${currentTripId && shareMode
      ? '你是用連結開啟這個行程的訪客，邀請其他人請找行程成員。'
      : '請先到「帳號」開啟一個雲端行程，才能邀請朋友或分享給別人。'}</p>`;
    document.getElementById('linkManager').innerHTML = '';
    return;
  }
  const unlinked = trip.members.filter(m => !m.discordId);
  const who = unlinked.length
    ? `還有 ${unlinked.length} 位成員沒連結 Discord（${unlinked.slice(0, 3).map(m => escapeHtml(m.name)).join('、')}${unlinked.length > 3 ? '…' : ''}）。傳給他們，登入後選「我是哪一位」就能一起記帳，過去的帳目都會保留。`
    : '傳給朋友，他們用 Discord 登入後就能以新成員身分加入，一起記帳。';
  el.innerHTML = `
    <div class="tl-hero">
      <div class="tl-hero-ic" aria-hidden="true">🔑</div>
      <div class="tl-hero-text">
        <div class="tl-hero-title">邀請朋友加入</div>
        <p class="tl-hero-sub">${who}</p>
      </div>
      <button class="btn btn-brass tl-hero-btn" type="button" onclick="withLoading(this,'產生中…',copyInviteLink)">複製邀請連結</button>
    </div>
    ${canManageTrip() ? '' : '<p class="hint tl-foot">想讓沒有 Discord 的朋友看帳或一起記帳，可以請行程建立者建立免登入的連結。</p>'}`;
}

// 下半部：建立者的連結管理。只在狀態改變時重繪（裡面有輸入框）
function renderLinkManager(){
  const el = document.getElementById('linkManager');
  if (!el) return;
  if (!isTripMember() || !canManageTrip()){ el.innerHTML = ''; return; }
  const s = tripLinksState;
  const links = s.links || [];
  const sorted = links.slice().sort((a,b)=> (linkIsExpired(a) - linkIsExpired(b)) || (b.createdAt - a.createdAt));
  const inviteToken = defaultInviteToken(links);
  let body;
  if (s.links === null && !s.error) body = '<p class="hint">讀取中…</p>';
  else if (s.error) body = `<p class="hint">讀取連結失敗：${escapeHtml(s.error)}　<button type="button" class="link-btn" onclick="loadTripLinks()">重試</button></p>`;
  else if (!links.length && !s.composer) body = '<p class="hint tl-empty">還沒有任何連結。按「＋ 新增連結」建立一條，或直接用上面的「複製邀請連結」。</p>';
  else body = `<div class="tl-list">${sorted.map(l => linkRowHtml(l, l.token === inviteToken)).join('')}</div>`;

  el.innerHTML = `
    <div class="tl-section-head">
      <h3 class="section-subtitle">所有連結 ${s.links ? `<span class="n">(${links.length})</span>` : ''}</h3>
      ${s.composer ? '' : '<button class="btn btn-ghost btn-sm" type="button" onclick="openLinkComposer()">＋ 新增連結</button>'}
    </div>
    ${s.composer ? linkComposerHtml(s.composer) : ''}
    ${body}`;
}

function linkTagsHtml(l){
  const tags = [];
  if (l.join) tags.push('<span class="tl-tag">可登入加入</span>');
  if (l.guest !== 'none') tags.push(`<span class="tl-tag ${l.guest === 'write' ? 'warn' : ''}">訪客${LINK_GUEST_LABELS[l.guest]}</span>`);
  const expired = linkIsExpired(l);
  tags.push(`<span class="tl-tag ${expired ? 'off' : 'muted'}">${linkExpiryText(l)}</span>`);
  return tags.join('');
}
function linkRowHtml(l, isDefaultInvite){
  const t = escapeHtml(l.token);
  const editing = tripLinksState.editing && tripLinksState.editing.token === l.token ? tripLinksState.editing : null;
  const expired = linkIsExpired(l);
  return `
    <div class="tl-row ${expired ? 'expired' : ''} ${editing ? 'open' : ''}">
      <div class="tl-row-main">
        <div class="tl-row-ic" aria-hidden="true">${linkIcon(l)}</div>
        <div class="tl-row-text">
          <div class="tl-row-title">${escapeHtml(l.label || linkDefaultName(l))}${isDefaultInvite ? '<span class="tl-badge" title="成員按「複製邀請連結」時用的就是這一條">成員共用</span>' : ''}</div>
          <div class="tl-tags">${linkTagsHtml(l)}</div>
        </div>
        <div class="tl-row-actions">
          ${expired ? '' : `<button class="btn btn-brass btn-sm" type="button" onclick="copyLinkUrl('${t}')">複製</button>`}
          <button class="btn btn-ghost btn-sm" type="button" aria-expanded="${editing ? 'true' : 'false'}" onclick="toggleLinkEditor('${t}')">${editing ? '收起' : '設定'}</button>
        </div>
      </div>
      ${editing ? linkEditorHtml(l, editing, isDefaultInvite) : ''}
    </div>`;
}

function segTabsHtml(name, options, value, onPick){
  return `<div class="seg-tabs tl-seg" role="radiogroup" aria-label="${name}">${options.map(o =>
    `<button type="button" role="radio" class="seg-tab" aria-checked="${o.value === value}" aria-selected="${o.value === value}" onclick="${onPick}(${JSON.stringify(o.value).replace(/"/g, '&quot;')})">${o.label}</button>`
  ).join('')}</div>`;
}
function linkSummaryText(guest, join){
  if (guest === 'none' && !join) return '⚠️ 兩項都關掉的話，這條連結就沒有用途了。';
  const parts = [];
  if (guest !== 'none') parts.push(guest === 'write' ? '不登入就能看帳、記帳' : '不登入就能看帳');
  if (join) parts.push('用 Discord 登入可以加入成為成員');
  return '點開後：' + parts.join('；') + '。';
}

function linkEditorHtml(l, d, isDefaultInvite){
  return `
    <div class="tl-editor">
      <div class="tl-field">
        <div class="tl-label">不登入的訪客</div>
        ${segTabsHtml('不登入的訪客', Object.entries(LINK_GUEST_LABELS).map(([value, label]) => ({ value, label })), d.guest, 'setLinkEditGuest')}
      </div>
      <label class="check-row tl-field">
        <input type="checkbox" ${d.join ? 'checked' : ''} onchange="tripLinksState.editing.join = this.checked; renderLinkManager()">
        允許用 Discord 登入加入成為成員
      </label>
      <div class="field tl-field">
        <label for="linkEditLabel">名稱（選填）</label>
        <input type="text" id="linkEditLabel" maxlength="50" placeholder="${escapeHtml(linkDefaultName(d))}" value="${escapeHtml(d.label)}" oninput="tripLinksState.editing.label = this.value">
      </div>
      <p class="hint tl-summary">${linkSummaryText(d.guest, d.join)}</p>
      <div class="tl-editor-actions">
        <button class="btn btn-brass btn-sm" type="button" ${d.guest === 'none' && !d.join ? 'disabled' : ''} onclick="withLoading(this,'儲存中…',saveLinkEdit)">儲存</button>
        <button class="btn btn-ghost btn-sm" type="button" onclick="toggleLinkEditor(null)">取消</button>
        <button class="btn btn-danger btn-sm tl-revoke" type="button" onclick="revokeTripLink('${escapeHtml(l.token)}')">撤銷連結</button>
      </div>
      ${isDefaultInvite ? '<p class="hint tl-foot">這是成員共用的邀請連結。撤銷後舊網址立刻失效，下次有人複製邀請連結時會自動產生新的。</p>' : ''}
    </div>`;
}

function linkComposerHtml(c){
  const preset = LINK_PRESETS.find(p => p.id === c.preset);
  return `
    <div class="tl-composer">
      <div class="tl-label">這條連結要做什麼？</div>
      <div class="tl-presets" role="radiogroup" aria-label="連結用途">
        ${LINK_PRESETS.map(p => `
          <button type="button" role="radio" aria-checked="${p.id === c.preset}" class="tl-preset ${p.id === c.preset ? 'on' : ''}" onclick="pickLinkPreset('${p.id}')">
            <span class="tl-preset-ic" aria-hidden="true">${p.icon}</span>
            <span class="tl-preset-title">${p.title}</span>
            <span class="tl-preset-sub">${p.sub}</span>
          </button>`).join('')}
      </div>
      ${preset.guest !== 'none' ? `
        <label class="check-row tl-field">
          <input type="checkbox" ${c.join ? 'checked' : ''} onchange="tripLinksState.composer.join = this.checked; renderLinkManager()">
          也允許用 Discord 登入加入成為成員
        </label>` : ''}
      <div class="tl-field">
        <div class="tl-label">有效期限</div>
        ${segTabsHtml('有效期限', LINK_EXPIRY_CHOICES.map(e => ({ value: e.days, label: e.label })), c.days, 'setLinkComposerDays')}
      </div>
      <div class="field tl-field">
        <label for="linkNewLabel">名稱（選填，方便你認得這是給誰的）</label>
        <input type="text" id="linkNewLabel" maxlength="50" placeholder="例如：小華、公司同事" value="${escapeHtml(c.label)}" oninput="tripLinksState.composer.label = this.value">
      </div>
      <p class="hint tl-summary">${linkSummaryText(preset.guest, c.join)}${c.days ? `${c.days} 天後失效。` : ''}</p>
      <div class="tl-editor-actions">
        <button class="btn btn-brass" type="button" onclick="withLoading(this,'建立中…',createTripLink)">建立並複製連結</button>
        <button class="btn btn-ghost" type="button" onclick="closeLinkComposer()">取消</button>
      </div>
    </div>`;
}

/* ===================== 讀取與操作 ===================== */
// 開啟「成員與分享」或換行程時呼叫：重新讀取連結清單
async function renderTripLinksPanel(){
  if (tripLinksState.tripId !== currentTripId) resetTripLinksState();
  renderInviteSection();
  renderLinkManager();
  if (isTripMember() && canManageTrip()) await loadTripLinks();
}
async function loadTripLinks(){
  const tripId = currentTripId;
  tripLinksState.error = null;
  try{
    const links = await apiJson(await fetch(tripApiUrl('/links'), { headers: apiHeaders() }));
    if (tripId !== currentTripId) return; // 讀取途中換了行程
    tripLinksState.links = links;
  }catch(err){
    if (tripId !== currentTripId) return;
    tripLinksState.error = err.message;
  }
  renderLinkManager();
}

async function copyInviteLink(){
  try{
    const { token } = await apiJson(await fetch(tripApiUrl('/invite'), { headers: apiHeaders() }));
    await copyLinkUrl(token, '已複製邀請連結，傳給還沒加入的朋友即可（請不要公開張貼）');
    if (canManageTrip()) loadTripLinks(); // 第一次邀請時會自動建立一條，讓清單同步
  }catch(err){
    toast('取得邀請連結失敗：' + err.message, 'error');
  }
}

function openLinkComposer(){
  tripLinksState.editing = null;
  pickLinkPreset('read');
}
function closeLinkComposer(){
  tripLinksState.composer = null;
  renderLinkManager();
}
function pickLinkPreset(id){
  const p = LINK_PRESETS.find(x => x.id === id);
  const prev = tripLinksState.composer;
  tripLinksState.composer = { preset: p.id, join: p.join, days: p.days, label: prev ? prev.label : '' };
  renderLinkManager();
}
function setLinkComposerDays(days){
  tripLinksState.composer.days = days;
  renderLinkManager();
}
async function createTripLink(){
  const c = tripLinksState.composer;
  if (!c || !currentTripId) return;
  const p = LINK_PRESETS.find(x => x.id === c.preset);
  try{
    const link = await apiJson(await fetch(tripApiUrl('/links'), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
      body: JSON.stringify({ label: c.label.trim(), guest: p.guest, join: p.guest === 'none' ? true : c.join, expiresInDays: c.days })
    }));
    tripLinksState.composer = null;
    tripLinksState.links = (tripLinksState.links || []).concat(link);
    renderLinkManager();
    await copyLinkUrl(link.token, '已建立並複製連結，貼給朋友即可（請勿公開分享）');
  }catch(err){
    toast('建立連結失敗：' + err.message, 'error');
  }
}

function toggleLinkEditor(token){
  const l = token && (tripLinksState.links || []).find(x => x.token === token);
  const same = tripLinksState.editing && tripLinksState.editing.token === token;
  tripLinksState.editing = l && !same ? { token: l.token, guest: l.guest, join: l.join, label: l.label || '' } : null;
  if (tripLinksState.editing) tripLinksState.composer = null;
  renderLinkManager();
}
function setLinkEditGuest(guest){
  tripLinksState.editing.guest = guest;
  renderLinkManager();
}
// 修改設定：對方手上的網址不變，下一次開啟或儲存時就會套用
async function saveLinkEdit(){
  const d = tripLinksState.editing;
  if (!d) return;
  try{
    const link = await apiJson(await fetch(tripApiUrl(`/links/${encodeURIComponent(d.token)}`), {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
      body: JSON.stringify({ guest: d.guest, join: d.join, label: d.label })
    }));
    tripLinksState.links = tripLinksState.links.map(x => x.token === link.token ? link : x);
    tripLinksState.editing = null;
    renderLinkManager();
    toast('已更新連結設定', 'success');
  }catch(err){
    toast('修改連結失敗：' + err.message, 'error');
  }
}

async function revokeTripLink(token){
  const l = (tripLinksState.links || []).find(x => x.token === token);
  const name = l ? (l.label || linkDefaultName(l)) : '這條連結';
  const ok = await confirmModal(`確定要撤銷「${name}」嗎？拿著這個網址的人會立刻無法再用它開啟或加入行程（已經加入的成員不受影響）。`, { danger:true, confirmText:'確定撤銷' });
  if (!ok) return;
  try{
    await apiJson(await fetch(tripApiUrl(`/links/${encodeURIComponent(token)}`), { method: 'DELETE', headers: apiHeaders() }));
    tripLinksState.links = (tripLinksState.links || []).filter(x => x.token !== token);
    tripLinksState.editing = null;
    renderLinkManager();
    toast('已撤銷連結', 'success');
  }catch(err){
    toast('撤銷失敗：' + err.message, 'error');
  }
}
