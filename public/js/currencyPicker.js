'use strict';
/* =====================================================================
   幣別搜尋選單（設定 → 行程 → 匯率 → 新增幣別）
   不是每個人都記得貨幣代碼：可以打國家／地區、貨幣名稱或代碼搜尋，
   選到之後會立刻查即時匯率（fetchLiveRate，見 js/api.js）填進匯率欄位，
   使用者確認後按「新增幣別」才會寫進行程。
   清單裡沒有的幣別，只要輸入合法代碼（例如 XAF）也能直接使用。
===================================================================== */

// [代碼, 中文名稱, 國旗, 國家／地區與別名（用來搜尋，空白分隔）]
const CURRENCY_LIST = [
  ['TWD', '新台幣', '🇹🇼', '台灣 臺灣 台幣 臺幣 新臺幣 taiwan NT'],
  ['JPY', '日圓', '🇯🇵', '日本 日幣 日元 japan yen'],
  ['KRW', '韓元', '🇰🇷', '韓國 南韓 韓幣 korea won'],
  ['USD', '美元', '🇺🇸', '美國 美金 usa united states dollar'],
  ['EUR', '歐元', '🇪🇺', '歐盟 歐洲 德國 法國 義大利 西班牙 荷蘭 比利時 奧地利 芬蘭 希臘 葡萄牙 愛爾蘭 斯洛維尼亞 斯洛伐克 克羅埃西亞 盧森堡 馬爾他 賽普勒斯 愛沙尼亞 拉脫維亞 立陶宛 europe euro'],
  ['HKD', '港幣', '🇭🇰', '香港 港元 hong kong'],
  ['MOP', '澳門幣', '🇲🇴', '澳門 澳門元 macau pataca'],
  ['CNY', '人民幣', '🇨🇳', '中國 大陸 中國大陸 rmb china yuan'],
  ['SGD', '新加坡幣', '🇸🇬', '新加坡 新幣 singapore'],
  ['MYR', '馬幣', '🇲🇾', '馬來西亞 令吉 malaysia ringgit'],
  ['THB', '泰銖', '🇹🇭', '泰國 thailand baht'],
  ['VND', '越南盾', '🇻🇳', '越南 vietnam dong'],
  ['PHP', '菲律賓披索', '🇵🇭', '菲律賓 philippines peso'],
  ['IDR', '印尼盾', '🇮🇩', '印尼 印度尼西亞 峇里島 indonesia rupiah bali'],
  ['INR', '印度盧比', '🇮🇳', '印度 india rupee'],
  ['KHR', '柬埔寨瑞爾', '🇰🇭', '柬埔寨 cambodia riel'],
  ['LAK', '寮國基普', '🇱🇦', '寮國 老撾 laos kip'],
  ['MMK', '緬甸元', '🇲🇲', '緬甸 myanmar kyat'],
  ['BND', '汶萊幣', '🇧🇳', '汶萊 brunei'],
  ['MNT', '蒙古圖格里克', '🇲🇳', '蒙古 mongolia tugrik'],
  ['NPR', '尼泊爾盧比', '🇳🇵', '尼泊爾 nepal rupee'],
  ['LKR', '斯里蘭卡盧比', '🇱🇰', '斯里蘭卡 sri lanka rupee'],
  ['MVR', '馬爾地夫拉菲亞', '🇲🇻', '馬爾地夫 maldives rufiyaa'],
  ['PKR', '巴基斯坦盧比', '🇵🇰', '巴基斯坦 pakistan rupee'],
  ['BDT', '孟加拉塔卡', '🇧🇩', '孟加拉 bangladesh taka'],
  ['KZT', '哈薩克堅戈', '🇰🇿', '哈薩克 kazakhstan tenge'],
  ['UZS', '烏茲別克索姆', '🇺🇿', '烏茲別克 uzbekistan som'],
  ['AUD', '澳幣', '🇦🇺', '澳洲 澳大利亞 澳元 australia dollar'],
  ['NZD', '紐幣', '🇳🇿', '紐西蘭 紐元 new zealand dollar'],
  ['FJD', '斐濟幣', '🇫🇯', '斐濟 fiji dollar'],
  ['XPF', '太平洋法郎', '🇵🇫', '大溪地 法屬玻里尼西亞 新喀里多尼亞 tahiti cfp franc'],
  ['GBP', '英鎊', '🇬🇧', '英國 英格蘭 蘇格蘭 uk united kingdom britain pound'],
  ['CHF', '瑞士法郎', '🇨🇭', '瑞士 列支敦斯登 switzerland franc'],
  ['SEK', '瑞典克朗', '🇸🇪', '瑞典 sweden krona'],
  ['NOK', '挪威克朗', '🇳🇴', '挪威 norway krone'],
  ['DKK', '丹麥克朗', '🇩🇰', '丹麥 格陵蘭 法羅群島 denmark krone'],
  ['ISK', '冰島克朗', '🇮🇸', '冰島 iceland krona'],
  ['PLN', '波蘭茲羅提', '🇵🇱', '波蘭 poland zloty'],
  ['CZK', '捷克克朗', '🇨🇿', '捷克 czech koruna'],
  ['HUF', '匈牙利福林', '🇭🇺', '匈牙利 hungary forint'],
  ['RON', '羅馬尼亞列伊', '🇷🇴', '羅馬尼亞 romania leu'],
  ['BGN', '保加利亞列弗', '🇧🇬', '保加利亞 bulgaria lev'],
  ['RSD', '塞爾維亞第納爾', '🇷🇸', '塞爾維亞 serbia dinar'],
  ['BAM', '波赫可兌換馬克', '🇧🇦', '波士尼亞 赫塞哥維納 波赫 bosnia mark'],
  ['MKD', '北馬其頓第納爾', '🇲🇰', '北馬其頓 馬其頓 macedonia denar'],
  ['ALL', '阿爾巴尼亞列克', '🇦🇱', '阿爾巴尼亞 albania lek'],
  ['MDL', '摩爾多瓦列伊', '🇲🇩', '摩爾多瓦 moldova leu'],
  ['UAH', '烏克蘭格里夫納', '🇺🇦', '烏克蘭 ukraine hryvnia'],
  ['RUB', '俄羅斯盧布', '🇷🇺', '俄羅斯 russia ruble'],
  ['GEL', '喬治亞拉里', '🇬🇪', '喬治亞 格魯吉亞 georgia lari'],
  ['AMD', '亞美尼亞德拉姆', '🇦🇲', '亞美尼亞 armenia dram'],
  ['AZN', '亞塞拜然馬納特', '🇦🇿', '亞塞拜然 azerbaijan manat'],
  ['TRY', '土耳其里拉', '🇹🇷', '土耳其 turkey türkiye lira'],
  ['ILS', '以色列新謝克爾', '🇮🇱', '以色列 israel shekel'],
  ['AED', '阿聯酋迪拉姆', '🇦🇪', '阿聯 阿拉伯聯合大公國 杜拜 阿布達比 uae dubai dirham'],
  ['SAR', '沙烏地里亞爾', '🇸🇦', '沙烏地阿拉伯 沙烏地 saudi riyal'],
  ['QAR', '卡達里亞爾', '🇶🇦', '卡達 卡塔爾 qatar riyal'],
  ['KWD', '科威特第納爾', '🇰🇼', '科威特 kuwait dinar'],
  ['BHD', '巴林第納爾', '🇧🇭', '巴林 bahrain dinar'],
  ['OMR', '阿曼里亞爾', '🇴🇲', '阿曼 oman rial'],
  ['JOD', '約旦第納爾', '🇯🇴', '約旦 jordan dinar'],
  ['EGP', '埃及鎊', '🇪🇬', '埃及 egypt pound'],
  ['MAD', '摩洛哥迪拉姆', '🇲🇦', '摩洛哥 morocco dirham'],
  ['TND', '突尼西亞第納爾', '🇹🇳', '突尼西亞 tunisia dinar'],
  ['ZAR', '南非蘭特', '🇿🇦', '南非 south africa rand'],
  ['KES', '肯亞先令', '🇰🇪', '肯亞 kenya shilling'],
  ['TZS', '坦尚尼亞先令', '🇹🇿', '坦尚尼亞 tanzania shilling'],
  ['NGN', '奈及利亞奈拉', '🇳🇬', '奈及利亞 nigeria naira'],
  ['MUR', '模里西斯盧比', '🇲🇺', '模里西斯 mauritius rupee'],
  ['CAD', '加幣', '🇨🇦', '加拿大 加元 canada dollar'],
  ['MXN', '墨西哥披索', '🇲🇽', '墨西哥 mexico peso'],
  ['BRL', '巴西雷亞爾', '🇧🇷', '巴西 brazil real'],
  ['ARS', '阿根廷披索', '🇦🇷', '阿根廷 argentina peso'],
  ['CLP', '智利披索', '🇨🇱', '智利 chile peso'],
  ['COP', '哥倫比亞披索', '🇨🇴', '哥倫比亞 colombia peso'],
  ['PEN', '秘魯索爾', '🇵🇪', '秘魯 peru sol'],
  ['UYU', '烏拉圭披索', '🇺🇾', '烏拉圭 uruguay peso'],
  ['BOB', '玻利維亞諾', '🇧🇴', '玻利維亞 bolivia boliviano'],
  ['CRC', '哥斯大黎加科朗', '🇨🇷', '哥斯大黎加 costa rica colon'],
  ['DOP', '多明尼加披索', '🇩🇴', '多明尼加 dominican peso'],
  ['JMD', '牙買加元', '🇯🇲', '牙買加 jamaica dollar'],
];
const CURRENCY_BY_CODE = Object.fromEntries(CURRENCY_LIST.map(([code, name, flag, aliases]) => [code, { code, name, flag, aliases }]));

function currencyLabel(code){
  const c = CURRENCY_BY_CODE[code];
  return c ? `${c.name} ${code}` : code;
}

// 依搜尋字排序：代碼完全相同 > 代碼開頭 > 名稱開頭 > 其他包含
function searchCurrencies(query){
  const q = String(query || '').trim().toLowerCase();
  const base = trip && trip.baseCurrency;
  const pool = CURRENCY_LIST.filter(([code]) => code !== base);
  if (!q) return pool.map(([code]) => CURRENCY_BY_CODE[code]);
  const scored = [];
  for (const [code, name, , aliases] of pool){
    const lc = code.toLowerCase();
    let score = -1;
    if (lc === q) score = 0;
    else if (lc.startsWith(q)) score = 1;
    else if (name.toLowerCase().startsWith(q)) score = 2;
    else if (aliases.toLowerCase().split(/\s+/).some(a => a.startsWith(q))) score = 3;
    else if (name.toLowerCase().includes(q) || aliases.toLowerCase().includes(q)) score = 4;
    if (score >= 0) scored.push({ score, c: CURRENCY_BY_CODE[code] });
  }
  return scored.sort((a, b) => a.score - b.score).map(x => x.c);
}

// 把使用者打的字解析成幣別代碼：已從清單選取 > 名稱／代碼完全相同 > 合法的自訂代碼
function resolveTypedCurrency(input){
  if (input.dataset.code) return input.dataset.code;
  const raw = input.value.trim();
  if (!raw) return '';
  const up = raw.toUpperCase();
  if (CURRENCY_BY_CODE[up]) return up;
  const byName = CURRENCY_LIST.find(([, name]) => name === raw);
  if (byName) return byName[0];
  const hits = searchCurrencies(raw);
  if (hits.length === 1) return hits[0].code;
  return /^[A-Z][A-Z0-9]{1,9}$/.test(up) ? up : '';
}

(function initCurrencyPicker(){
  const input = document.getElementById('newRateCurrency');
  const list = document.getElementById('newRateCurrencyList');
  const valInput = document.getElementById('newRateValue');
  const hint = document.getElementById('newRateHint');
  if (!input || !list || !valInput) return;

  let options = [];   // 目前顯示的選項：{ code, label }
  let activeIdx = -1;
  let lookupSeq = 0;  // 連續選不同幣別時，只採用最後一次查詢的結果

  function setHint(text, state){
    if (!hint) return;
    hint.textContent = text || '';
    hint.dataset.state = state || '';
  }
  function close(){
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIdx = -1;
  }
  function highlight(idx){
    activeIdx = idx;
    [...list.children].forEach((li, i) => li.classList.toggle('active', i === idx));
    const li = list.children[idx];
    if (li){
      input.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    }
  }
  function open(){
    const q = input.value.trim();
    const hits = searchCurrencies(q).slice(0, 40);
    options = hits.map(c => ({ code: c.code, label: `${c.flag} ${c.name}`, has: trip && trip.rates && trip.rates[c.code] != null }));
    const up = q.toUpperCase();
    if (!hits.length && /^[A-Z][A-Z0-9]{1,9}$/.test(up)){
      options.push({ code: up, label: `使用代碼「${up}」`, custom: true });
    }
    list.innerHTML = options.length
      ? options.map((o, i) => `
          <li role="option" id="curOpt${i}" data-idx="${i}" class="cur-opt">
            <span class="cur-opt-name">${escapeHtml(o.label)}</span>
            ${o.has ? '<span class="cur-opt-has">已設定</span>' : ''}
            ${o.custom ? '' : `<span class="cur-opt-code">${escapeHtml(o.code)}</span>`}
          </li>`).join('')
      : '<li class="cur-opt-empty">找不到符合的幣別，可以改打貨幣代碼，例如 XAF</li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(options.length ? 0 : -1);
  }

  async function pick(opt){
    close();
    input.value = currencyLabel(opt.code);
    input.dataset.code = opt.code;
    const base = trip.baseCurrency;
    const seq = ++lookupSeq;
    valInput.value = '';
    valInput.placeholder = '查詢中…';
    setHint(`正在查詢 1 ${opt.code} ＝ 多少 ${base}…`, 'loading');
    const live = await fetchLiveRate(opt.code, base);
    if (seq !== lookupSeq) return;
    valInput.placeholder = '匯率';
    if (live && live.rate > 0){
      valInput.value = String(parseFloat(live.rate.toPrecision(6)));
      setHint(`已帶入即時匯率：1 ${opt.code} ＝ ${valInput.value} ${base}。確認後按「新增幣別」。`, 'ok');
    } else {
      setHint(`查不到 ${opt.code} 的即時匯率，請自己輸入匯率（1 ${opt.code} ＝ 多少 ${base}）。`, 'error');
      valInput.focus();
    }
  }

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'newRateCurrencyList');
  input.setAttribute('aria-expanded', 'false');

  input.addEventListener('focus', open);
  input.addEventListener('input', () => {
    delete input.dataset.code;
    lookupSeq++;
    setHint('', '');
    open();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      e.preventDefault();
      if (list.hidden){ open(); return; }
      if (!options.length) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      highlight((activeIdx + d + options.length) % options.length);
    } else if (e.key === 'Enter'){
      if (!list.hidden && options[activeIdx]){ e.preventDefault(); pick(options[activeIdx]); }
    } else if (e.key === 'Escape'){
      if (!list.hidden){ e.preventDefault(); e.stopPropagation(); close(); }
    }
  });
  // mousedown 先擋掉，避免輸入框失焦把清單關掉、點擊落空
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-idx]');
    if (li) pick(options[Number(li.dataset.idx)]);
  });

  // 新增完成後（addRate 清空欄位）一併清掉選取狀態與提示
  window.resetCurrencyPicker = function(){
    lookupSeq++;
    input.value = '';
    delete input.dataset.code;
    valInput.placeholder = '匯率';
    setHint('', '');
    close();
  };
})();
