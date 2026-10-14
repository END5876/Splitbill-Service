// 在 <head> 裡同步執行：CSS 載入前就先決定主題，避免深色模式使用者看到一閃而過的淺色畫面。
// （原本是 index.html 裡的 inline <script>；CSP 不允許 inline script，所以搬成檔案。）
(function(){
  try{
    var saved = localStorage.getItem('splitbill-theme');
    var theme = saved || ((window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    // 跟 js/theme.js 的 THEME_COLORS 保持一致（瀏覽器網址列／PWA 狀態列顏色）
    if (theme === 'dark') document.querySelector('meta[name="theme-color"]').setAttribute('content', '#1E1F22');
  }catch(e){}
})();
