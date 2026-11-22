'use strict';
// 共用 UI 元件：toast 提示、modal 對話框（含清單挑選）、withLoading 按鈕忙碌狀態。
/* =====================================================================
   Toast 系統 — 取代所有原本分散在各分頁的 msg 區塊。
   固定顯示在畫面底部（桌面在右下），不管使用者在哪個分頁操作都看得到。
===================================================================== */
// 三個產品共用的規則（ui-review DECISIONS 第 3 題）：
//   一般提示 3 秒（opts.duration 可以給長一點）；帶動作（復原、重試…）8 秒；
//   滑鼠移上去、手指按住或鍵盤聚焦時暫停倒數；錯誤（type 'error'）紅底、有關閉鈕、不自動消失。
// opts：{ duration, action: { label, fn } }（復原用 toastUndo）
const MAX_TOASTS = 4;
function toast(message, type, opts){
  type = type || 'info';
  opts = opts || {};
  const stack = document.getElementById('toastStack');
  const isError = type === 'error';
  const action = opts.action || null;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  if (isError) el.setAttribute('role', 'alert');
  const iconId = type === 'success' ? 'i-check' : (isError ? 'i-alert' : 'i-info');
  el.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#${iconId}"/></svg><span class="msg-text"></span>`;
  el.querySelector('.msg-text').textContent = message;
  if (action){
    const btn = document.createElement('button');
    btn.className = 'undo-btn';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.onclick = ()=>{ action.fn(); dismissToast(el); };
    el.appendChild(btn);
  }
  if (isError){
    const close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.setAttribute('aria-label', '關閉這則提示');
    close.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-x"/></svg>';
    close.onclick = ()=>dismissToast(el);
    el.appendChild(close);
  }
  // 同一句錯誤還開著就不再疊一則（例如斷線時每次自動儲存都失敗）
  if (isError && [...stack.querySelectorAll('.toast.error:not(.closing) .msg-text')].some(m => m.textContent === message)) return null;
  stack.appendChild(el);
  // 同時堆太多則時，先收掉最舊的一般提示；錯誤要等使用者自己關，不算在內
  const open = [...stack.querySelectorAll('.toast:not(.closing):not(.error)')];
  open.slice(0, Math.max(0, open.length - MAX_TOASTS)).forEach(dismissToast);
  if (isError) return el;

  let remaining = action ? 8000 : (opts.duration || 3000);
  let startedAt = Date.now();
  let paused = false;
  el._t = setTimeout(()=>dismissToast(el), remaining);
  // 指標在上面或鍵盤焦點在裡面時暫停；兩者都離開後才繼續（至少再留 1.5 秒）
  const pause = ()=>{
    if (paused) return;
    paused = true;
    clearTimeout(el._t);
    remaining -= Date.now() - startedAt;
  };
  const maybeResume = ()=>setTimeout(()=>{
    if (!paused || el.matches(':hover') || el.contains(document.activeElement)) return;
    paused = false;
    startedAt = Date.now();
    el._t = setTimeout(()=>dismissToast(el), Math.max(1500, remaining));
  }, 0);
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', maybeResume);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', maybeResume);
  return el;
}
function dismissToast(el){
  if (!el || !el.parentNode) return;
  clearTimeout(el._t);
  el.classList.add('closing');
  setTimeout(()=>el.remove(), 180);
}
// 復原式刪除：資料立即移除，但跳一個帶「復原」按鈕的 toast，
// 幾秒內按下就還原，取代原本「刪除前跳原生確認框」的模式。
function toastUndo(message, restoreFn){
  toast(message, 'success', { action: { label: '復原', fn: restoreFn } });
}

/* =====================================================================
   Modal 系統 — 取代原生 confirm() / prompt()，統一站內樣式與行動裝置體驗。
   mountModal() 統一處理三種 modal 共用的無障礙行為：Esc 關閉、Tab 焦點
   限制在對話框內、關閉後把焦點還給開啟前的元素；同時間只會有一個 modal，
   新的 modal 開啟時，舊的視為「取消」並正常 resolve，呼叫端不會卡住。
===================================================================== */
let activeModal = null; // { dismiss, onKey, prevFocus }
function closeModal(){
  const m = activeModal;
  activeModal = null;
  document.getElementById('modalRoot').innerHTML = '';
  if (!m) return;
  dropLayer('modal');
  document.removeEventListener('keydown', m.onKey, true);
  if (m.prevFocus && m.prevFocus.isConnected && typeof m.prevFocus.focus === 'function') m.prevFocus.focus();
}
function mountModal(boxHtml, opts){
  if (activeModal) activeModal.dismiss();
  const prevFocus = document.activeElement;
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal-box" role="${opts.role || 'dialog'}" aria-modal="true"
        ${opts.hasTitle ? 'aria-labelledby="modalTitle"' : ''} ${opts.hasBody ? 'aria-describedby="modalBody"' : ''}>${boxHtml}</div>
    </div>`;
  const overlay = document.getElementById('modalOverlay');
  const box = overlay.querySelector('.modal-box');
  const dismiss = ()=>{ closeModal(); opts.onDismiss(); };
  const onKey = (e)=>{
    if (e.key === 'Escape'){ e.preventDefault(); dismiss(); return; }
    if (e.key !== 'Tab') return;
    const focusables = [...box.querySelectorAll('button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))){ e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))){ e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e)=>{ if (e.target === overlay) dismiss(); });
  activeModal = { dismiss, onKey, prevFocus };
  // 返回鍵先關對話框（等同按取消）
  pushLayer('modal', ()=>{ if (activeModal) activeModal.dismiss(); });
  return box;
}
// 確認鈕的文字必填，寫具體動作（例如「刪除支出」），不要用「確定」；漏傳時提醒開發者
function confirmTextOf(opts){
  if (!opts.confirmText) console.warn('confirmModal／promptModal：缺少 confirmText，請寫具體的動作', opts.title);
  return opts.confirmText || '繼續';
}
function modalTitleHtml(title){
  return title ? `<div class="modal-title" id="modalTitle">${escapeHtml(title)}</div>` : '';
}
function confirmModal(message, opts){
  opts = opts || {};
  return new Promise(resolve=>{
    mountModal(`
      ${modalTitleHtml(opts.title)}
      <div class="modal-body" id="modalBody">${escapeHtml(message)}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="modalCancelBtn">${escapeHtml(opts.cancelText || '取消')}</button>
        <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" id="modalConfirmBtn" style="${opts.danger ? 'background:var(--debt-solid);color:#fff;border:none;' : ''}">${escapeHtml(confirmTextOf(opts))}</button>
      </div>`, { hasTitle: !!opts.title, hasBody: true, onDismiss: ()=>resolve(false) });
    const finish = (val)=>{ closeModal(); resolve(val); };
    document.getElementById('modalCancelBtn').onclick = ()=>finish(false);
    document.getElementById('modalConfirmBtn').onclick = ()=>finish(true);
    // 危險操作預設聚焦在「取消」，避免手滑按 Enter 直接執行刪除／撤銷
    document.getElementById(opts.danger ? 'modalCancelBtn' : 'modalConfirmBtn').focus();
  });
}
// 🆕 純告知型 modal（取代原生 alert()）：只有一顆「知道了」按鈕，沒有
// 取消/確定的選擇，用在只是要提醒使用者「這件事做不到」的場合（例如拖曳
// 了一個非圖片格式的檔案）。跟 confirmModal() 共用同一套外觀與遮罩，
// 差別只在按鈕數量與語意（alertdialog 而非 dialog）。resolve 永遠是
// true，回傳 Promise 純粹是為了讓呼叫端能用 await 等使用者按下去再繼續。
function alertModal(message, opts){
  opts = opts || {};
  return new Promise(resolve=>{
    mountModal(`
      ${modalTitleHtml(opts.title)}
      <div class="modal-body" id="modalBody">${escapeHtml(message)}</div>
      <div class="modal-actions">
        <button class="btn btn-primary" id="modalOkBtn">${escapeHtml(opts.okText || '知道了')}</button>
      </div>`, { role: 'alertdialog', hasTitle: !!opts.title, hasBody: true, onDismiss: ()=>resolve(true) });
    document.getElementById('modalOkBtn').onclick = ()=>{ closeModal(); resolve(true); };
    document.getElementById('modalOkBtn').focus();
  });
}
// 輸入一行文字的 modal（取代原生 prompt()）。resolve 輸入的字串；取消／關閉 resolve null。
function promptModal(message, opts){
  opts = opts || {};
  return new Promise(resolve=>{
    mountModal(`
      ${modalTitleHtml(opts.title)}
      ${message ? `<div class="modal-body" id="modalBody">${escapeHtml(message)}</div>` : ''}
      <input type="text" id="modalPromptInput" autocomplete="off" ${opts.maxLength ? `maxlength="${Number(opts.maxLength)}"` : ''} placeholder="${escapeHtml(opts.placeholder || '')}" aria-label="${escapeHtml(opts.title || '輸入')}" style="margin-bottom:18px;">
      <div class="modal-actions">
        <button class="btn btn-ghost" id="modalCancelBtn">${escapeHtml(opts.cancelText || '取消')}</button>
        <button class="btn btn-primary" id="modalConfirmBtn">${escapeHtml(confirmTextOf(opts))}</button>
      </div>`, { hasTitle: !!opts.title, hasBody: !!message, onDismiss: ()=>resolve(null) });
    const input = document.getElementById('modalPromptInput');
    input.value = opts.value || '';
    const finish = (val)=>{ closeModal(); resolve(val); };
    input.addEventListener('keydown', (e)=>{ if (e.key === 'Enter'){ e.preventDefault(); finish(input.value); } });
    document.getElementById('modalCancelBtn').onclick = ()=>finish(null);
    document.getElementById('modalConfirmBtn').onclick = ()=>finish(input.value);
    input.focus();
    input.select();
  });
}
// 輸入文字確認的 modal（不可復原的刪除用）：輸入內容要和 expected 完全相同，確認按鈕才會亮起。
// resolve true＝確認；false＝取消／關閉。
function typeToConfirmModal(message, expected, opts){
  opts = opts || {};
  return new Promise(resolve=>{
    mountModal(`
      ${modalTitleHtml(opts.title)}
      <div class="modal-body" id="modalBody">${escapeHtml(message)}</div>
      <input type="text" id="modalConfirmInput" autocomplete="off" placeholder="${escapeHtml(opts.placeholder || '')}" aria-label="輸入確認文字" style="margin-bottom:18px;">
      <div class="modal-actions">
        <button class="btn btn-ghost" id="modalCancelBtn">${escapeHtml(opts.cancelText || '取消')}</button>
        <button class="btn btn-danger" id="modalConfirmBtn" disabled style="background:var(--debt-solid);color:#fff;border:none;">${escapeHtml(confirmTextOf(opts))}</button>
      </div>`, { role: 'alertdialog', hasTitle: !!opts.title, hasBody: true, onDismiss: ()=>resolve(false) });
    const input = document.getElementById('modalConfirmInput');
    const btn = document.getElementById('modalConfirmBtn');
    const matches = ()=> input.value.trim() === String(expected).trim();
    const finish = (val)=>{ closeModal(); resolve(val); };
    input.addEventListener('input', ()=>{ btn.disabled = !matches(); });
    input.addEventListener('keydown', (e)=>{ if (e.key === 'Enter' && matches()){ e.preventDefault(); finish(true); } });
    document.getElementById('modalCancelBtn').onclick = ()=>finish(false);
    btn.onclick = ()=>{ if (matches()) finish(true); };
    input.focus();
  });
}
// 清單挑選 modal（取代原本 prompt() 手動打行程 ID 的做法）
function pickModal(title, items){
  // items: [{ value, title, sub }]
  return new Promise(resolve=>{
    mountModal(`
      ${modalTitleHtml(title)}
      <div class="modal-list" id="modalList"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="modalCancelBtn">取消</button>
      </div>`, { hasTitle: !!title, onDismiss: ()=>resolve(null) });
    const list = document.getElementById('modalList');
    items.forEach(item=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-list-item';
      btn.innerHTML = `<div class="mli-title"></div>${item.sub ? '<div class="mli-sub"></div>' : ''}`;
      btn.querySelector('.mli-title').textContent = item.title;
      if (item.sub) btn.querySelector('.mli-sub').textContent = item.sub;
      btn.onclick = ()=>{ closeModal(); resolve(item.value); };
      list.appendChild(btn);
    });
    document.getElementById('modalCancelBtn').onclick = ()=>{ closeModal(); resolve(null); };
    const firstItem = list.querySelector('.modal-list-item');
    (firstItem || document.getElementById('modalCancelBtn')).focus();
  });
}

/* =====================================================================
   Loading 狀態 — 包住任何非同步按鈕動作：停用按鈕、換成 spinner 文字，
   結束後（不論成功失敗）自動還原，並防止使用者連點造成重複請求。
===================================================================== */
async function withLoading(btnEl, loadingText, fn){
  if (btnEl.disabled) return; // 已經在跑，忽略重複點擊
  btnEl._loadingOriginal = btnEl.innerHTML;
  btnEl.disabled = true;
  btnEl.innerHTML = `<span class="spinner"></span>${escapeHtml(loadingText)}`;
  try{
    await fn();
  } finally {
    btnEl.disabled = false;
    btnEl.innerHTML = btnEl._loadingOriginal;
    delete btnEl._loadingOriginal;
  }
}
// 改按鈕文字：如果按鈕正在 withLoading() 轉圈中，改的是「結束後要還原成的文字」，
// 否則轉圈結束時會被還原成舊文字（例如存完編輯後按鈕又變回「更新」）。
function setButtonLabel(btnEl, text){
  if (!btnEl) return;
  if (btnEl._loadingOriginal !== undefined) btnEl._loadingOriginal = escapeHtml(text);
  else btnEl.textContent = text;
}

/* =====================================================================
   可收合的表單卡片（支出／轉帳）：預設展開，點標題列可以收合，
   讓明細清單不會被一整張表單推到很下面；編輯既有一筆時自動展開。
===================================================================== */
function setFormCardOpen(cardId, open){
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.toggle('collapsed', !open);
  const toggle = card.querySelector('.form-card-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function toggleFormCard(cardId){
  const card = document.getElementById(cardId);
  if (card) setFormCardOpen(cardId, card.classList.contains('collapsed'));
}
// 標示表單目前是「編輯既有一筆」還是「新增」：卡片加上 .editing 樣式，
// 儲存鈕改成「更新」、清空鈕改成「取消編輯」，避免使用者沒發現自己在改舊資料。
function setFormCardEditing(cardId, saveBtnId, resetBtnId, editing){
  const card = document.getElementById(cardId);
  if (card) card.classList.toggle('editing', editing);
  // 新增叫「記下這筆」、編輯叫「儲存修改」：按鈕和完成提示用同一個說法
  setButtonLabel(document.getElementById(saveBtnId), editing ? '儲存修改' : '記下這筆');
  setButtonLabel(document.getElementById(resetBtnId), editing ? '取消編輯' : '清空表單');
  if (editing) setFormCardOpen(cardId, true);
}

