'use strict';
// 左滑列：總覽「建議轉帳」露出「標記已付」，支出／轉帳明細露出「刪除」。
// 點一下（或鍵盤 Enter）：明細列（有 data-ledger）展開內容，其他列開關按鈕。
// HTML 在 overview.js 的 settleRowHtml()、render.js 的 ledgerRowHtml()：.swipe-box > .swipe-in > 按鈕 .swipe-act ＋ 列 .swipe-row。
// 清單重畫會換掉整列，所以每次都從畫面上找元素，不留跨重畫的狀態。
let swipeOpenRow = null;
{
  const calm = matchMedia('(prefers-reduced-motion:reduce)').matches;
  const actOf = row => row.parentNode.querySelector('.swipe-act');
  const widthOf = row => (actOf(row).offsetWidth || 72) + 22;
  const readonly = () => document.body.matches('.share-readonly, .trip-archived');
  // 明細離線時不能刪舊帳目
  const noSwipe = row => readonly() || (row.dataset.ledger && navigator.onLine === false);
  const tap = row => { toggleLedgerRow(row); };
  const openRow = () => (swipeOpenRow && swipeOpenRow.isConnected ? swipeOpenRow : (swipeOpenRow = null));

  // 位置＝手指位置；按鈕跟著露出的比例淡入、放大
  function put(row, x, snap){
    const act = actOf(row), p = Math.min(1, Math.max(0, -x / widthOf(row)));
    row.classList.toggle('snap', snap);
    act.classList.toggle('snap', snap);
    row._x = x;
    row.style.transform = x ? `translateX(${x}px)` : '';
    act.style.opacity = p;
    act.style.transform = `scale(${0.6 + 0.4 * p})`;
  }
  function set(row, on){
    if (!row.isConnected) return;
    const cur = openRow();
    if (on && cur && cur !== row) set(cur, false);
    put(row, on ? -widthOf(row) : 0, true);
    if (on) swipeOpenRow = row;
    else if (swipeOpenRow === row) swipeOpenRow = null;
    const act = actOf(row);
    act.tabIndex = on ? 0 : -1;
    act.setAttribute('aria-hidden', String(!on));
    if (!row.dataset.ledger) row.setAttribute('aria-expanded', String(on));
  }

  let drag = null;
  document.addEventListener('pointerdown', ev => {
    const row = ev.target.closest('.swipe-row'), cur = openRow();
    if (cur && cur !== row && !ev.target.closest('.swipe-act')) set(cur, false);
    if (drag || !row || ev.button || row.closest('.gone')) return;
    if (readonly() && !row.dataset.ledger) return;
    const shut = !!cur && cur !== row; // 這一下是用來收起別列的
    const x = new DOMMatrix(getComputedStyle(row).transform).m41;
    put(row, x, false); // 動畫中途也能直接抓住
    drag = { row, id: ev.pointerId, x: ev.clientX, y: ev.clientY, from: x, was: cur === row, shut, fixed: noSwipe(row), lock: false, pts: [[ev.clientX, ev.timeStamp]] };
  });
  document.addEventListener('pointermove', ev => {
    if (!drag || ev.pointerId !== drag.id) return;
    if (!drag.row.isConnected){ drag = null; return; }
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.lock){
      if (Math.hypot(dx, dy) < 7) return;
      if (Math.abs(dy) > Math.abs(dx)){ const { row, was } = drag; drag = null; set(row, was); return; }
      if (drag.fixed){ drag = null; return; }
      drag.lock = true;
      drag.x = ev.clientX;
      drag.row.setPointerCapture(ev.pointerId);
      return;
    }
    drag.pts.push([ev.clientX, ev.timeStamp]);
    if (drag.pts.length > 5) drag.pts.shift();
    const w = widthOf(drag.row);
    let x = drag.from + dx;
    if (x > 0) x *= 0.18;
    else if (x < -w) x = -w + (x + w) * 0.3; // 超過範圍有阻力
    put(drag.row, x, false);
  });
  function end(ev, cancelled){
    if (!drag || ev.pointerId !== drag.id) return;
    const { row, lock, was, shut, pts } = drag;
    drag = null;
    if (cancelled) return set(row, was);
    if (!lock){
      if (!row.dataset.ledger) return set(row, !was); // 點一下也能開關
      set(row, false);
      if (!was && !shut) tap(row);
      return;
    }
    const a = pts[0], b = pts[pts.length - 1];
    const v = ev.timeStamp - b[1] > 80 ? 0 : (b[0] - a[0]) / Math.max(1, b[1] - a[1]);
    set(row, v < -0.35 ? true : v > 0.35 ? false : row._x < -widthOf(row) / 2); // 甩一下，或滑過一半
  }
  document.addEventListener('pointerup', ev => end(ev, false));
  document.addEventListener('pointercancel', ev => end(ev, true));
  window.addEventListener('scroll', () => { const cur = openRow(); if (cur && !drag) set(cur, false); }, { passive: true });
  document.addEventListener('keydown', ev => {
    const row = ev.target.closest && ev.target.closest('.swipe-row');
    if (row && (ev.key === 'Enter' || ev.key === ' ') && row.dataset.ledger){ ev.preventDefault(); tap(row); return; }
    if (row && (ev.key === 'Enter' || ev.key === ' ') && !readonly()){
      ev.preventDefault();
      const on = openRow() !== row;
      set(row, on);
      if (on) actOf(row).focus({ preventScroll: true });
    }
    const cur = openRow();
    if (ev.key === 'Escape' && cur && cur.parentNode.contains(ev.target)){ set(cur, false); cur.focus(); }
  });

  window.closeSwipeRow = function(){ const cur = openRow(); if (cur) set(cur, false); };

  // 標記後：這一列往左滑出，底下的列補上來
  window.swipeRowOut = async function(el){
    const sw = el && el.closest('.swipe-box');
    if (!sw || calm) return;
    const act = sw.querySelector('.swipe-act');
    const row = sw.querySelector('.swipe-row'), wait = ms => new Promise(r => setTimeout(r, ms));
    swipeOpenRow = null;
    row.style.transition = 'transform .26s cubic-bezier(.4,0,1,1)';
    row.style.transform = 'translateX(-110%)';
    act.style.transition = 'opacity .12s';
    act.style.opacity = 0;
    await wait(180);
    sw.classList.add('gone');
    await wait(290);
  };

  // 第一次看到可以滑的列時輕輕動一下；每台裝置只提示一次
  window.swipeRowPeek = function(){
    if (calm || readonly()) return;
    try{ if (localStorage.getItem('sb_swipe_hint')) return; }catch(e){ return; }
    const row = document.querySelector('#panel-overview.active .swipe-row');
    if (!row || !row.offsetWidth) return;
    try{ localStorage.setItem('sb_swipe_hint', '1'); }catch(e){ /* 存不了就下次再提示 */ }
    setTimeout(() => {
      const now = document.querySelector('#panel-overview.active .swipe-row');
      if (!now || drag || openRow()) return;
      put(now, -34, true);
      setTimeout(() => { if (now.isConnected && !drag && !openRow()) put(now, 0, true); }, 380);
    }, 700);
  };
}
