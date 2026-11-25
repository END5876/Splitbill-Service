'use strict';
// 行程資料的格式：預設值、修復（repair*）、保留不認得的欄位、v1 → v2 轉換。全是純函式，不碰資料庫。
// 由 lib/storage.js 統一匯出，其他檔案照舊從 storage 取用。

const crypto = require('crypto');
const { isSnowflake } = require('./snowflake');
const { isLineId } = require('./accounts');
const { isSafeId, isCurrencyCode, finiteOr, str } = require('./validate');

// 🆕 [行程獨立化] 資料檔 v2 格式：行程是頂層實體，不再掛在 Discord 伺服器底下。
//   {
//     version: 2,
//     trips:  { [tripId]: trip },     // trip.guildId 為 null＝尚未綁定任何 Discord 伺服器
//     guilds: { [guildId]: { defaultTripId, activeTripByUser } }
//   }
// guilds 只剩 bot 端「每人各自的作用行程」這類指標，行程本身的身分（tripId、
// 網址、分享連結、SSE 訂閱）完全不受綁定／解除綁定伺服器影響。
// 舊版 v1（{ [guildId]: { trips, defaultTripId, activeTripByUser } }）在第一次匯入
// SQLite 時一併轉成 v2（🆕 [SQLite] 見 initializeStore()；原檔改名保留，不另外備份）。
// 這個 v2 形狀現在也就是記憶體 cache 的形狀。
const DATA_VERSION = 2;

// 🔒 所有用外部輸入（網址參數、請求內容）當 key 去查物件的地方，一律先確認
// 是物件自己的屬性，避免 /api/trip/constructor、activeTripByUser['__proto__']
// 這類原型鏈上的名稱被誤當成「存在的資料」。
function hasOwn(obj, key) {
  return !!obj && typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
}

// ---------- 預設欄位（用於資料防呆 / 自動補齊） ----------
const DEFAULT_TRIP = () => ({
  id: '',
  name: '',
  baseCurrency: 'TWD',
  rates: { TWD: 1 }, // rates[currency] = 該幣別兌基準幣的匯率 (1 該幣別 = rate 基準幣)
  // [{ id, name, discordId? }]
  //   id：行程內部的穩定成員 ID，expenses/deposits 一律引用這個 ID，永遠不會因為
  //       連結／解除連結 Discord 帳號而改變。舊資料的成員 id 本身就是 Discord ID，
  //       遷移後維持原樣不改寫；之後新增的成員一律是 mem_xxxx。
  //   discordId：已連結的 Discord 帳號（snowflake）。沒有這個欄位＝未連結，在 Discord
  //       端只會顯示純文字名字、不能被提及、也不能操作面板。
  //       ⚠️ 這個欄位只能由伺服器端的受控流程寫入（見 lib/members.js），不能從
  //       id 反推、也不能由網頁直接 PUT 進來。
  members: [],
  expenses: [],
  deposits: [],      // [{ id, collectorId, payerId, amount, currency, amountInBase, note, createdAt }]
  // 🆕 [行程連結] 這個行程目前開放的連結（token 等同密碼，永遠不回傳給一般讀取）。
  // 分享連結與成員邀請連結合併成同一種：
  //   guest  不登入直接打開時的權限：'none'（不開放）| 'read' | 'write'
  //   join   用 Discord 登入後可以認領成員／以新成員加入
  // 舊資料的 shareLinks（→ join:false）與 invite（→ guest:'none', join:true）在 repairTrip() 轉換。
  links: [],         // [{ token, label, guest, join, expiresAt:number|null, createdAt }]
  // 🆕 [行程獨立化] 綁定的 Discord 伺服器；null＝只存在於網頁、bot 看不到。
  guildId: null,
  archived: false,
  createdAt: Date.now(),
});

const DEFAULT_GUILD_STATE = () => ({
  // 🔄 [修正：切換行程影響全體] defaultTripId：伺服器層級的後備行程，只在使用者
  // 「從未自己選過」時使用；activeTripByUser：{ [userId]: tripId }，每人各自獨立。
  defaultTripId: null,
  activeTripByUser: {},
});

// ── 🆕 [回滾防護] 保留不認得的欄位 ──
// 從資料庫載入時（buildCache），較新版本的程式可能已經寫下這個版本不認得的欄位。
// 只留已知欄位的話，回滾一版映像後第一次存檔就會把它們剝掉（而且不會留下歷史版本）。
// 所以「從資料庫讀出來的資料」保留不認得的欄位；「客戶端送來的資料」（整包 PUT）仍然
// 只留已知欄位，另外用 preserveUnknownFields() 把伺服器上原有的不認得欄位接回去。
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 把 raw 裡 out 沒有的欄位複製到 out（keep 為 false 時什麼都不做）。 */
function withUnknown(out, raw, keep, skip) {
  if (!keep || !raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    if (UNSAFE_KEYS.has(key) || Object.prototype.hasOwnProperty.call(out, key) || (skip && skip.has(key))) continue;
    out[key] = raw[key];
  }
  return out;
}

function genId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 🆕 [行程連結] 產生當作憑證使用的 token。
 * 刻意跟 genId() 分開：genId() 只需要「不重複」，這裡的 token 本身就是
 * 一組會被拿去當 API 憑證使用的「密碼」，因此用 24 bytes（192 bits）亂數。
 */
function genShareToken() {
  return crypto.randomBytes(24).toString('hex');
}

function emptyDb() {
  return { version: DATA_VERSION, trips: {}, guilds: {} };
}

const MEMBER_SKIP_KEYS = new Set(['discordId', 'lineId']);

/**
 * 資料防呆：成員清單。
 * - id 必須是安全字元（見 lib/validate.js）。格式不合的舊資料換一個新 id，並記在
 *   remap 裡，讓 repairTrip() 把帳目裡的引用一起改過去；空的 id 直接丟棄
 * - 重複 id 只保留第一筆
 * - discordId 只保留 snowflake 格式、lineId 只保留 line:U… 格式（🆕 [LINE 登入]，見 lib/accounts.js），
 *   一位成員只會有其中一個（兩個都有時以 discordId 為準）；同一個行程裡一個帳號最多連結一位成員
 *   （重複者保留第一筆、後面的一律視為未連結）
 * @param {Map<string,string>} [remap] 舊 id → 新 id（由這個函式填入）
 */
function repairMembers(rawMembers, remap, keepUnknown = false) {
  const list = Array.isArray(rawMembers) ? rawMembers : [];
  const seenIds = new Set();
  const seenDiscord = new Set(); // 已連結的帳號（Discord ID 與 line:U… 共用，兩種格式不會撞號）
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    let id = typeof m.id === 'string' && m.id.trim() ? m.id.trim() : null;
    if (!id || seenIds.has(id)) continue;
    if (!isSafeId(id)) {
      const replaced = genId('mem');
      if (remap) remap.set(m.id, replaced);
      console.warn(`[splitbill-storage] 成員 id 含有不允許的字元，已改為 ${replaced}`);
      id = replaced;
    }
    seenIds.add(id);
    const member = { id, name: (typeof m.name === 'string' && m.name.trim()) ? m.name.trim().slice(0, 60) : '未知成員' };
    if (isSnowflake(m.discordId) && !seenDiscord.has(m.discordId)) {
      member.discordId = m.discordId;
      seenDiscord.add(m.discordId);
    } else if (!member.discordId && isLineId(m.lineId) && !seenDiscord.has(m.lineId)) {
      member.lineId = m.lineId;
      seenDiscord.add(m.lineId);
    }
    // discordId／lineId 只能經由上面的檢查寫入，不能當成「不認得的欄位」被帶過來
    out.push(withUnknown(member, m, keepUnknown, MEMBER_SKIP_KEYS));
  }
  return out;
}

/**
 * 資料防呆與自動修復：補齊缺漏欄位、修正舊版格式，避免程式因缺欄位而崩潰。
 * @param {{ keepUnknown?: boolean }} [opts] keepUnknown：保留不認得的欄位（只給從資料庫載入用）
 */
function repairTrip(rawTrip, opts = {}) {
  const keepUnknown = opts.keepUnknown === true;
  const def = DEFAULT_TRIP();
  const trip = { ...def, ...(rawTrip || {}) };

  // 🔒 幣別代碼會被放進網頁（選單、按鈕參數），只接受安全格式；匯率必須是正的有限數字
  if (!isCurrencyCode(trip.baseCurrency)) trip.baseCurrency = def.baseCurrency;
  const rawRates = rawTrip && rawTrip.rates && typeof rawTrip.rates === 'object' ? rawTrip.rates : {};
  trip.rates = {};
  for (const [code, rate] of Object.entries(rawRates)) {
    if (isCurrencyCode(code) && finiteOr(rate, 0) > 0) trip.rates[code] = rate;
  }
  trip.rates[trip.baseCurrency] = 1;

  trip.name = str(trip.name, 100).trim();

  const memberRemap = new Map();
  trip.members = repairMembers(trip.members, memberRemap, keepUnknown);
  const ref = (id) => (memberRemap.has(id) ? memberRemap.get(id) : id);

  const seenEntryIds = new Set();
  const uniqueId = (entry, prefix) => {
    if (seenEntryIds.has(entry.id)) entry.id = genId(prefix);
    seenEntryIds.add(entry.id);
    return entry;
  };
  trip.expenses = (Array.isArray(trip.expenses) ? trip.expenses : [])
    .map((e) => uniqueId(repairExpense(e, ref, trip.baseCurrency, keepUnknown), 'exp'));
  trip.deposits = (Array.isArray(trip.deposits) ? trip.deposits : [])
    .map((d) => uniqueId(repairDeposit(d, ref, trip.baseCurrency, keepUnknown), 'dep'));

  // 🆕 [行程連結] 舊版的 shareLinks／invite 轉進 links（token 不變，舊網址照樣能用）
  const rawLinks = Array.isArray(trip.links) ? trip.links.slice() : [];
  if (Array.isArray(trip.shareLinks)) {
    for (const l of trip.shareLinks) {
      if (l && typeof l === 'object') rawLinks.push({ ...l, guest: l.permission === 'write' ? 'write' : 'read', join: false });
    }
  }
  if (trip.invite && typeof trip.invite.token === 'string' && trip.invite.token.length >= 32) {
    rawLinks.push({ token: trip.invite.token, label: '邀請連結', guest: 'none', join: true, expiresAt: null, createdAt: trip.invite.createdAt });
  }
  delete trip.shareLinks;
  delete trip.invite;
  const seenTokens = new Set();
  trip.links = rawLinks.map((l) => repairLink(l, keepUnknown)).filter((l) => l && !seenTokens.has(l.token) && seenTokens.add(l.token));

  // 行程建立者（Discord user ID）。只接受非空字串；其餘一律移除，避免髒資料。
  if (typeof trip.ownerId === 'string' && trip.ownerId.trim()) trip.ownerId = trip.ownerId.trim().slice(0, 64);
  else delete trip.ownerId;

  // 綁定的 Discord 伺服器：只接受 snowflake，其餘一律視為未綁定。
  if (!isSnowflake(trip.guildId)) trip.guildId = null;

  if (typeof trip.archived !== 'boolean') trip.archived = false;
  if (typeof trip.createdAt !== 'number') trip.createdAt = Date.now();
  if (!trip.id) trip.id = genId('trip');
  if (!trip.name) trip.name = '未命名行程';

  // 🔒 只留下已知欄位：整包 PUT（包含可編輯分享連結）送來的其他欄位一律丟掉，
  // 不會被存進資料庫、留在 50 份歷史版本裡，也不會被廣播給其他人。
  // 例外是從資料庫載入（keepUnknown）：那些欄位是伺服器自己寫的，見 withUnknown()。
  const out = {};
  for (const key of TRIP_FIELDS) if (trip[key] !== undefined) out[key] = trip[key];
  if (typeof trip.updatedAt === 'number') out.updatedAt = trip.updatedAt;
  else delete out.updatedAt;
  return withUnknown(out, trip, keepUnknown, TRIP_SKIP_KEYS);
}

// 舊版格式的欄位，repairTrip() 已經轉換過，不能當成「不認得的欄位」保留下來
const TRIP_SKIP_KEYS = new Set(['shareLinks', 'invite']);

/**
 * 🆕 [回滾防護] 客戶端整包寫入後，把伺服器上原有、但這個版本不認得的欄位接回去
 * （行程本身，以及 id 相同的成員／支出／轉帳）。客戶端送來的不認得欄位早就在
 * repairTrip() 被丟掉，這裡只會補回伺服器自己原本存的。直接修改 repaired。
 */
function preserveUnknownFields(existing, repaired) {
  if (!existing || !repaired) return repaired;
  carryUnknown(existing, repaired, new Set([...TRIP_FIELDS, ...TRIP_SKIP_KEYS]));
  for (const kind of Object.keys(KNOWN_ENTRY_KEYS)) {
    const byId = new Map((existing[kind] || []).map((x) => [x.id, x]));
    for (const item of repaired[kind] || []) {
      const old = byId.get(item.id);
      if (old) carryUnknown(old, item, KNOWN_ENTRY_KEYS[kind]);
    }
  }
  return repaired;
}

/** 同 preserveUnknownFields()，給單筆寫入用：kind 是 'members' | 'expenses' | 'deposits'。 */
function preserveUnknownEntryFields(kind, old, entry) {
  if (old && entry && KNOWN_ENTRY_KEYS[kind]) carryUnknown(old, entry, KNOWN_ENTRY_KEYS[kind]);
  return entry;
}

function carryUnknown(from, to, knownKeys) {
  for (const key of Object.keys(from)) {
    if (UNSAFE_KEYS.has(key) || knownKeys.has(key) || Object.prototype.hasOwnProperty.call(to, key)) continue;
    to[key] = from[key];
  }
}

// repairTrip() 輸出的欄位（順序即 JSON 的欄位順序）
const TRIP_FIELDS = [
  'id', 'name', 'baseCurrency', 'rates', 'members', 'expenses', 'deposits', 'links',
  'guildId', 'archived', 'createdAt', 'ownerId', 'updatedAt',
];

// 一個行程最多幾筆支出／幾筆轉帳（整包 PUT 與單筆 API 共用）
const MAX_ENTRIES = 5000;

/** 整包寫入的支出／轉帳筆數超過上限時回傳錯誤訊息，否則 null。 */
function tooManyEntries(raw) {
  for (const [key, label] of [['expenses', '支出'], ['deposits', '轉帳']]) {
    if (raw && Array.isArray(raw[key]) && raw[key].length > MAX_ENTRIES) {
      return `${label}最多 ${MAX_ENTRIES} 筆`;
    }
  }
  return null;
}

// 代墊／分攤清單：只留下指向安全 id 的項目，金額一律是有限數字（舊版 Bot 用 share 欄位）
function repairShares(list, ref) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const userId = ref(p.userId);
    if (!isSafeId(userId)) continue;
    out.push({ userId, amount: finiteOr(p.amount, finiteOr(p.share, 0)) });
  }
  return out;
}

const identity = (x) => x;

/**
 * 資料防呆：支出。id 格式不對就換新的；金額不是有限數字一律當 0（結算不會出現 NaN）。
 * @param {(id:string)=>string} [ref] 成員 id 的對應（見 repairMembers 的 remap）
 */
function repairExpense(rawExp, ref = identity, baseCurrency = 'TWD', keepUnknown = false) {
  const e = rawExp && typeof rawExp === 'object' ? rawExp : {};
  const amount = finiteOr(e.amount, 0);
  return withUnknown({
    id: isSafeId(e.id) ? e.id : genId('exp'),
    description: str(e.description, 500) || '（無說明）',
    amount,
    currency: isCurrencyCode(e.currency) ? e.currency : baseCurrency,
    amountInBase: finiteOr(e.amountInBase, amount),
    payers: repairShares(e.payers, ref),
    participants: repairShares(e.participants, ref),
    createdAt: finiteOr(e.createdAt, Date.now()),
    createdBy: str(e.createdBy, 64) || 'unknown',
    // 最後修改的人（伺服器依登入身分寫入，見 stampAuthors）；沒改過就沒有這個欄位
    ...(str(e.updatedBy, 64) ? { updatedBy: str(e.updatedBy, 64) } : {}),
  }, e, keepUnknown);
}

const EXPENSE_FIELDS = ['id', 'description', 'amount', 'currency', 'amountInBase', 'payers', 'participants', 'createdAt', 'createdBy', 'updatedBy'];
const DEPOSIT_FIELDS = ['id', 'collectorId', 'payerId', 'amount', 'currency', 'amountInBase', 'note', 'createdAt', 'createdBy', 'updatedBy'];
// 這個版本認得的欄位（preserveUnknownFields 用）；linked 是給訪客看的衍生欄位
const KNOWN_ENTRY_KEYS = {
  members: new Set(['id', 'name', 'discordId', 'lineId', 'linked']),
  expenses: new Set(EXPENSE_FIELDS),
  deposits: new Set(DEPOSIT_FIELDS),
};

/**
 * 資料防呆：修復預收款/訂金紀錄，補齊缺漏欄位，避免壞掉的資料
 * 在結算計算（calcNetBalances 等）中悄悄產生 NaN 或算錯淨額。
 */
function repairDeposit(rawDep, ref = identity, baseCurrency = 'TWD', keepUnknown = false) {
  const d = rawDep && typeof rawDep === 'object' ? rawDep : {};
  const amount = finiteOr(d.amount, 0);
  const member = (id) => (isSafeId(ref(id)) ? ref(id) : null);
  return withUnknown({
    id: isSafeId(d.id) ? d.id : genId('dep'),
    collectorId: member(d.collectorId),
    payerId: member(d.payerId),
    amount,
    currency: isCurrencyCode(d.currency) ? d.currency : baseCurrency,
    amountInBase: finiteOr(d.amountInBase, amount),
    note: str(d.note, 500),
    createdAt: finiteOr(d.createdAt, Date.now()),
    // 誰記的／誰改過（伺服器依登入身分寫入，見 stampAuthors）；舊資料沒有這兩個欄位
    ...(str(d.createdBy, 64) ? { createdBy: str(d.createdBy, 64) } : {}),
    ...(str(d.updatedBy, 64) ? { updatedBy: str(d.updatedBy, 64) } : {}),
  }, d, keepUnknown);
}

const LINK_GUEST_LEVELS = new Set(['none', 'read', 'write']);

/**
 * 🆕 [行程連結] 資料防呆：修復單筆連結紀錄。token 缺漏或損毀時回傳
 * null 讓呼叫端直接丟棄，不憑空「復活」一筆使用者從未建立過的有效連結。
 * 權限欄位不認得時一律往保守的方向修（guest:'none'、join:false）。
 * @returns {object|null}
 */
function repairLink(rawLink, keepUnknown = false) {
  const l = rawLink || {};
  if (!l.token || typeof l.token !== 'string') return null;
  return withUnknown({
    token: l.token,
    label: typeof l.label === 'string' ? l.label.slice(0, 50) : '',
    guest: LINK_GUEST_LEVELS.has(l.guest) ? l.guest : 'none',
    join: l.join === true,
    expiresAt: typeof l.expiresAt === 'number' ? l.expiresAt : null,
    createdAt: typeof l.createdAt === 'number' ? l.createdAt : Date.now(),
  }, l, keepUnknown);
}

function repairGuildState(raw, guildId, trips) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const g = DEFAULT_GUILD_STATE();
  const belongs = (tid) => hasOwn(trips, tid) && trips[tid].guildId === guildId;

  // 🔄 舊資料相容：舊版全域 activeTripId → defaultTripId
  const def = src.defaultTripId || src.activeTripId || null;
  g.defaultTripId = belongs(def) ? def : null;

  const active = (src.activeTripByUser && typeof src.activeTripByUser === 'object') ? src.activeTripByUser : {};
  for (const uid of Object.keys(active)) {
    if (belongs(active[uid])) g.activeTripByUser[uid] = active[uid];
  }
  return g;
}

/**
 * 🆕 [行程獨立化] v1 → v2 遷移。
 * - 每個行程搬到頂層 trips，trip.guildId＝原本所在的伺服器（不是 snowflake 的
 *   假伺服器 ID，例如早期網頁自己用的 "local"，一律變成未綁定 null）
 * - 成員：舊資料的 id 本身就是 Discord ID，補上 discordId＝id，id 維持不變，
 *   因此 expenses/deposits 完全不需要改寫
 * - 不同伺服器底下理論上不會有重複 tripId；萬一有，後出現的換一個新 ID
 */
function migrateV1(raw) {
  const db = emptyDb();
  for (const guildId of Object.keys(raw || {})) {
    const g = raw[guildId];
    if (!g || typeof g !== 'object') continue;
    const trips = (g.trips && typeof g.trips === 'object') ? g.trips : {};
    const renamed = {};
    for (const tripKey of Object.keys(trips)) {
      const t = trips[tripKey];
      if (!t || typeof t !== 'object') continue;
      let id = tripKey;
      if (hasOwn(db.trips, id)) {
        id = genId('trip');
        renamed[tripKey] = id;
        console.warn(`[splitbill-storage] 遷移時發現重複的行程 ID「${tripKey}」，已改為 ${id}`);
      }
      const members = Array.isArray(t.members) ? t.members.map((m) => (
        m && typeof m === 'object' && isSnowflake(m.id) && !m.discordId ? { ...m, discordId: m.id } : m
      )) : [];
      db.trips[id] = { ...t, id, members, guildId: isSnowflake(guildId) ? guildId : null };
    }
    if (isSnowflake(guildId)) {
      const mapId = (tid) => (tid && renamed[tid]) || tid || null;
      const active = {};
      for (const [uid, tid] of Object.entries(g.activeTripByUser || {})) active[uid] = mapId(tid);
      db.guilds[guildId] = {
        defaultTripId: mapId(g.defaultTripId || g.activeTripId),
        activeTripByUser: active,
      };
    }
  }
  return db;
}

module.exports = {
  EXPENSE_FIELDS,
  DEPOSIT_FIELDS,
  DATA_VERSION,
  repairTrip,
  repairGuildState,
  migrateV1,
  hasOwn,
  DEFAULT_GUILD_STATE,
  DEFAULT_TRIP,
  genId,
  genShareToken,
  repairMembers,
  preserveUnknownFields,
  preserveUnknownEntryFields,
  MAX_ENTRIES,
  tooManyEntries,
  repairExpense,
  repairDeposit,
  repairLink,
};
