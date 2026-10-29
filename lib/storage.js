'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { openStore } = require('./db');
const { isSnowflake } = require('./snowflake');
const { isSafeId, isCurrencyCode, finiteOr, str } = require('./validate');
const { diffTrips, resolveActor } = require('./activity');
const { alert } = require('./alert');

// ── [多人協作 / 即時同步] ──────────────────────────────────────────
// 任何管道（webui 存檔、Discord 面板按鈕、快速指令…）只要呼叫 touchTrip()，
// 並在之後 persist() 成功寫進資料庫，就會在這裡發出一個 'trip-updated' 事件
// 並帶上 tripId（🆕 [SQLite] 事件延到寫入成功之後才發，見 persist()）。lib/sse.js 會訂閱
// 這個事件，把最新的行程資料透過 SSE 推播給所有正在瀏覽該行程的分頁，
// 不需要在每個寫入點各自補一段「通知前端」的程式碼。
// setMaxListeners(0)：同一個行程可能同時有多個分頁在監聽，訂閱數不受
// Node 預設 10 個的上限限制（訂閱者是可控的伺服器內部連線）。
const tripEvents = new EventEmitter();
tripEvents.setMaxListeners(0);

// ── 統一寫入專案根目錄的 data/ 資料夾 ──
// 🆕 [SQLite] 正式資料存在 splitbill.db（見 lib/db.js）。splitbill.json 只在第一次
// 啟動時被讀取、匯入資料庫，之後改名成 splitbill.json.imported-<時間戳> 留作備份。
const DATA_DIR = process.env.SPLITBILL_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'splitbill.db');
const LEGACY_JSON_FILE = path.join(DATA_DIR, 'splitbill.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUPS_TO_KEEP = envInt('SPLITBILL_BACKUP_KEEP', 7);          // 0＝不做每日備份
const REVISIONS_TO_KEEP = envInt('SPLITBILL_REVISIONS_KEEP', 50);    // 每個行程保留幾個歷史版本（可整份還原）
const ACTIVITY_TO_KEEP = envInt('SPLITBILL_ACTIVITY_KEEP', 500);     // 每個行程保留幾筆操作紀錄

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

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

const MEMBER_SKIP_KEYS = new Set(['discordId']);

/**
 * 資料防呆：成員清單。
 * - id 必須是安全字元（見 lib/validate.js）。格式不合的舊資料換一個新 id，並記在
 *   remap 裡，讓 repairTrip() 把帳目裡的引用一起改過去；空的 id 直接丟棄
 * - 重複 id 只保留第一筆
 * - discordId 只保留 snowflake 格式，且同一個行程裡一個 Discord 帳號最多連結一位成員
 *   （重複者保留第一筆、後面的一律視為未連結）
 * @param {Map<string,string>} [remap] 舊 id → 新 id（由這個函式填入）
 */
function repairMembers(rawMembers, remap, keepUnknown = false) {
  const list = Array.isArray(rawMembers) ? rawMembers : [];
  const seenIds = new Set();
  const seenDiscord = new Set();
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
    }
    // discordId 只能經由上面的檢查寫入，不能當成「不認得的欄位」被帶過來
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
  }, e, keepUnknown);
}

const EXPENSE_FIELDS = ['id', 'description', 'amount', 'currency', 'amountInBase', 'payers', 'participants', 'createdAt', 'createdBy'];
const DEPOSIT_FIELDS = ['id', 'collectorId', 'payerId', 'amount', 'currency', 'amountInBase', 'note', 'createdAt'];
// 這個版本認得的欄位（preserveUnknownFields 用）；linked 是給訪客看的衍生欄位
const KNOWN_ENTRY_KEYS = {
  members: new Set(['id', 'name', 'discordId', 'linked']),
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

// ─────────────────────────── 持久層（SQLite） ───────────────────────────
// 🆕 [SQLite] 運作方式：
//  - 啟動時把資料庫整個讀進記憶體（cache），所有路由照舊直接讀寫 cache 裡的物件，
//    路由程式不需要改。
//  - persist()：把每個行程／伺服器指標序列化，跟「上次成功寫進資料庫的內容」比對，
//    只把有變動的列在同一個交易裡寫入。路由不需要回報自己改了什麼——分享連結、
//    邀請 token、作用行程這類「就地修改」一樣會被偵測到。
//  - 寫入失敗：交易整個回滾，cache 從資料庫重新載入（丟掉這次沒存成功的修改，
//    記憶體與磁碟不會分歧），這段期間 touchTrip() 排隊的 SSE 事件也一併丟掉，
//    然後把錯誤丟回路由（路由會回 500）。
//  - touchTrip() 的 SSE 事件延到 persist() 成功之後才發：前端永遠不會收到
//    一份其實沒存進去的資料。

let cache = null;
let store = null;
let snapshot = { trips: new Map(), guilds: new Map() }; // id -> { json, updatedAt }：資料庫目前的內容
const lastStamp = new Map();   // tripId -> 最後發出的 updatedAt，讓版本號嚴格遞增
let pendingEvents = [];        // [[tripId, meta]]：等 persist() 成功後才廣播
let linkIndex = new Map();     // 行程連結 token -> tripId
let backupTimer = null;
// 🆕 [健康檢查] 最後一次每日備份的結果（見 runDailyBackup()、health()）
const backupStatus = { lastSuccessAt: null, lastFailureAt: null };
// 🆕 [多實例保護] 載入 cache 時資料庫的 data_version。整個服務的設計是「單一實例＋記憶體
// cache」：同一個資料庫檔若同時被兩個實例寫入（例如滾動部署時新舊版本重疊），各自的
// cache 會互相覆蓋對方的修改。persist() 寫入前會比對這個值，發現別的實例寫過就拒絕
// 這次寫入、重新載入（見 persist()），寧可讓使用者重試一次，也不要悄悄蓋掉資料。
let knownDataVersion = null;
// 🆕 [效能] persist() 只比對「交給過呼叫端」的行程：路由要改行程，一定得先透過
// getTrip()／findTripBy*()／listGuildTrips()… 拿到物件，這些函式會把行程記在這裡
// （listTrips()／peek*() 是唯讀用途，不記）。
// 不用每次寫入都把全部行程 JSON.stringify 一遍；exposedAll＝true 時退回全部比對
// （剛從資料庫載入、修復過程可能補了欄位，或 loadAll() 把整個 cache 交了出去）。
let exposedTripIds = new Set();
let exposedAll = true;

function expose(trip) {
  if (trip) exposedTripIds.add(trip.id);
  return trip;
}

function getStore() {
  if (!store) {
    store = openStore(DB_FILE, {
      journalMode: process.env.SPLITBILL_SQLITE_JOURNAL,
      revisionsToKeep: REVISIONS_TO_KEEP,
      activityToKeep: ACTIVITY_TO_KEEP,
      backupDir: BACKUP_DIR,
    });
  }
  return store;
}

/**
 * 把原始資料（剛從 JSON／資料庫 parse 出來的物件）修復成 cache 的形狀。
 * trips／guilds 用沒有原型的物件，行程 ID 剛好叫 "__proto__" 之類的名稱時，
 * 不會變成改寫物件原型、而是一筆普通資料。
 */
function buildCache(rawTrips, rawGuilds) {
  const trips = Object.create(null);
  for (const id of Object.keys(rawTrips || {})) {
    trips[id] = repairTrip(rawTrips[id], { keepUnknown: true });
    trips[id].id = id; // 確保 key 與 id 一致
  }
  const guilds = Object.create(null);
  for (const gid of Object.keys(rawGuilds || {})) {
    if (!isSnowflake(gid)) continue;
    guilds[gid] = repairGuildState(rawGuilds[gid], gid, trips);
  }
  return { version: DATA_VERSION, trips, guilds };
}

/**
 * 讀取舊的 splitbill.json（v1 或 v2 格式）。
 * 檔案存在但讀不懂時直接丟例外、讓服務啟動失敗：絕不把它當成「沒有資料」，
 * 否則一個壞掉的檔案會讓服務以空資料上線，使用者看到的是所有行程都消失了。
 */
function readLegacyJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`[splitbill-storage] ${path.basename(file)} 不是合法的 JSON，拒絕匯入（${err.message}）。請修好或移走這個檔案後再啟動。`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`[splitbill-storage] ${path.basename(file)} 的內容不是分帳資料，拒絕匯入。`);
  }
  return raw.version === DATA_VERSION ? raw : migrateV1(raw);
}

function tripRow(trip, json, withRevision, activity) {
  return {
    id: trip.id,
    guildId: trip.guildId || null,
    ownerId: trip.ownerId || null,
    updatedAt: typeof trip.updatedAt === 'number' ? trip.updatedAt : null,
    createdAt: typeof trip.createdAt === 'number' ? trip.createdAt : null,
    json,
    // 歷史版本不存憑證（分享連結、邀請 token），只存行程內容
    revisionJson: withRevision ? JSON.stringify(toPublicTrip(trip)) : null,
    activityJson: activity ? JSON.stringify(activity) : null,
  };
}

/**
 * 第一次啟動：有舊的 splitbill.json 就整份匯入（同一個交易，失敗就整個不算數），
 * 成功後把 JSON 改名留作備份；沒有就建立空的資料庫。
 */
function initializeStore(s) {
  if (!fs.existsSync(LEGACY_JSON_FILE)) {
    // 🆕 [資料保護] 正式環境找不到任何資料，最常見的原因是 Volume 沒掛上或路徑設錯；
    // 這時默默建立空帳本，服務看起來正常，資料卻寫進容器裡、下次部署就消失。
    // 真的是第一次部署時，設定 SPLITBILL_ALLOW_EMPTY_INIT=1 啟動一次即可。
    if (process.env.NODE_ENV === 'production' && process.env.SPLITBILL_ALLOW_EMPTY_INIT !== '1') {
      throw new Error(`[splitbill-storage] ${DATA_DIR} 裡沒有任何分帳資料（splitbill.db 尚未初始化，也沒有 splitbill.json），拒絕以空帳本啟動。`
        + '請確認資料 Volume 已掛載到這個目錄；第一次部署請設定 SPLITBILL_ALLOW_EMPTY_INIT=1。');
    }
    s.initialize({ source: 'empty' });
    return;
  }
  const legacy = readLegacyJson(LEGACY_JSON_FILE);
  const c = buildCache(legacy.trips, legacy.guilds);
  const trips = Object.values(c.trips).map((t) => tripRow(t, JSON.stringify(t), true));
  const guilds = Object.keys(c.guilds).map((gid) => ({ guildId: gid, json: JSON.stringify(c.guilds[gid]) }));
  // 舊 JSON 的資料形狀是 schema v1（成員 id 可能是 Discord ID），匯入後由 db.js 遷移到最新版本
  s.initialize({ trips, guilds, source: 'splitbill.json', schemaVersion: 1 });

  const dest = `${LEGACY_JSON_FILE}.imported-${Date.now()}`;
  try {
    fs.renameSync(LEGACY_JSON_FILE, dest);
  } catch (err) {
    // 資料已經安全進到資料庫，而且資料庫已標記初始化完成，之後不會再匯入一次
    console.warn(`[splitbill-storage] 已匯入，但無法把 splitbill.json 改名（${err.message}），之後會被忽略。`);
  }
  console.log(`[splitbill-storage] 已把 splitbill.json 匯入 SQLite（行程 ${trips.length} 筆、伺服器 ${guilds.length} 個），原檔改名為 ${path.basename(dest)}`);
}

function rebuildIndexes() {
  linkIndex = new Map();
  for (const t of Object.values(cache.trips)) {
    for (const l of t.links || []) linkIndex.set(l.token, t.id);
  }
}

/** 對外：把整個 cache 交出去，下一次 persist() 會全部比對。 */
function loadAll() {
  const c = ensureLoaded();
  exposedAll = true;
  return c;
}

function ensureLoaded() {
  if (cache) return cache;
  const s = getStore();
  if (!s.isInitialized()) initializeStore(s);

  // 先讀版本再讀資料：兩者之間若剛好有別人寫入，最多只是下一次寫入時多重新載入一次
  knownDataVersion = s.dataVersion();
  const { trips: tripRows, guilds: guildRows } = s.readAll();
  const rawTrips = {};
  const nextSnapshot = { trips: new Map(), guilds: new Map() };
  for (const r of tripRows) {
    const t = JSON.parse(r.json);
    Object.defineProperty(rawTrips, r.id, { value: t, enumerable: true, writable: true, configurable: true });
    nextSnapshot.trips.set(r.id, { json: r.json, updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : null });
  }
  const rawGuilds = {};
  for (const r of guildRows) {
    rawGuilds[r.guildId] = JSON.parse(r.json);
    nextSnapshot.guilds.set(r.guildId, { json: r.json });
  }

  cache = buildCache(rawTrips, rawGuilds);
  // snapshot 記的是「資料庫裡的原樣」：如果修復過程補了欄位，下一次 persist() 會把修復後的版本寫回去
  snapshot = nextSnapshot;
  for (const t of Object.values(cache.trips)) {
    if (typeof t.updatedAt === 'number' && t.updatedAt > (lastStamp.get(t.id) || 0)) lastStamp.set(t.id, t.updatedAt);
  }
  exposedTripIds = new Set();
  exposedAll = true;
  rebuildIndexes();
  return cache;
}

/**
 * 把 cache 目前的狀態寫進資料庫（只寫有變動的部分），成功後才廣播排隊中的 SSE 事件。
 * 失敗時丟例外，而且 cache 已經恢復成資料庫裡的狀態。
 */
function persist() {
  const c = ensureLoaded();
  const events = pendingEvents;
  pendingEvents = [];
  try {
    persistChanges(c, events);
  } catch (err) {
    console.error(`[splitbill-storage] 寫入資料庫失敗，已丟棄這次尚未儲存的修改：${err.message}`);
    alert('db-write', `寫入資料庫失敗，使用者的修改沒有存進去：${err.message}`, { cooldownMs: 15 * 60 * 1000 });
    cache = null;
    ensureLoaded();
    if (err.code === 'FOREIGN_WRITE') {
      console.error('[splitbill-storage] ⚠️ 偵測到另一個服務實例正在寫入同一個資料庫，已重新載入。正式環境請確保同時只有一個實例。');
      const busy = new Error('資料剛被另一個伺服器實例更新過，已重新載入，請再試一次。');
      busy.status = 503;
      throw busy;
    }
    throw err;
  }
  for (const [tripId, meta] of events) {
    if (hasOwn(cache.trips, tripId)) tripEvents.emit('trip-updated', tripId, meta);
  }
}

/**
 * 這個版本的操作紀錄：比較資料庫裡的上一版（prevJson）跟現在的行程。
 * meta 是路由交給 touchTrip() 的 { actor, reason }；同一次 persist 裡同一個行程被 touch
 * 多次時用最後一次的。內容沒有實質變動（例如整包 PUT 原樣存回）就不留紀錄。
 */
function buildActivity(trip, prevJson, meta) {
  if (typeof trip.updatedAt !== 'number') return null;
  let prev = null;
  try { prev = prevJson ? JSON.parse(prevJson) : null; } catch (_) { prev = null; }
  const changes = diffTrips(prev, trip);
  if (!changes.length) return null;
  const record = { updatedAt: trip.updatedAt, at: Date.now(), actor: resolveActor(meta && meta.actor, trip), changes };
  if (meta && meta.reason) record.reason = meta.reason;
  return record;
}

function persistChanges(c, events = []) {
  const metaByTrip = new Map(events);
  const changes = { trips: [], deleteTrips: [], guilds: [], deleteGuilds: [] };
  const next = { trips: new Map(snapshot.trips), guilds: new Map() };

  // 要比對的行程：交出去過的，加上資料庫裡還沒有的（新行程）
  const ids = Object.keys(c.trips);
  const candidates = exposedAll ? ids : ids.filter((id) => exposedTripIds.has(id) || !snapshot.trips.has(id));
  for (const id of candidates) {
    const trip = c.trips[id];
    const json = JSON.stringify(trip);
    const updatedAt = typeof trip.updatedAt === 'number' ? trip.updatedAt : null;
    const prev = snapshot.trips.get(id);
    next.trips.set(id, { json, updatedAt });
    if (!prev || prev.json !== json) {
      // 只有行程內容版本（updatedAt）變了才留歷史版本與操作紀錄；只改分享連結之類的不算
      const newVersion = !prev || prev.updatedAt !== updatedAt;
      const activity = newVersion ? buildActivity(trip, prev && prev.json, metaByTrip.get(id)) : null;
      changes.trips.push(tripRow(trip, json, newVersion, activity));
    }
  }
  for (const id of snapshot.trips.keys()) {
    if (!hasOwn(c.trips, id)) {
      next.trips.delete(id);
      changes.deleteTrips.push(id);
    }
  }

  for (const gid of Object.keys(c.guilds)) {
    const json = JSON.stringify(c.guilds[gid]);
    const prev = snapshot.guilds.get(gid);
    next.guilds.set(gid, { json });
    if (!prev || prev.json !== json) changes.guilds.push({ guildId: gid, json });
  }
  for (const gid of snapshot.guilds.keys()) if (!next.guilds.has(gid)) changes.deleteGuilds.push(gid);

  const dirty = changes.trips.length || changes.deleteTrips.length || changes.guilds.length || changes.deleteGuilds.length;
  if (dirty) {
    getStore().apply(changes, { expectedDataVersion: knownDataVersion });
    snapshot = next;
    rebuildIndexes();
  }
  exposedTripIds = new Set();
  exposedAll = false;
}

/** 某行程在某個 updatedAt 版本時的內容（不含憑證）；沒有這個版本回傳 null。 */
function getTripRevision(tripId, updatedAt) {
  if (typeof tripId !== 'string' || typeof updatedAt !== 'number') return null;
  return getStore().getRevision(tripId, updatedAt);
}

function listTripRevisions(tripId) {
  return typeof tripId === 'string' ? getStore().listRevisions(tripId) : [];
}

/** 操作紀錄（新的在前）。before：只要 updatedAt 小於它的（往前翻頁），省略＝從最新開始。 */
function listTripActivity(tripId, before, limit) {
  if (typeof tripId !== 'string') return [];
  const upper = typeof before === 'number' && before > 0 ? before : Number.MAX_SAFE_INTEGER;
  // 上限 101：路由一頁最多 100 筆，會多拿一筆判斷 hasMore，夾在 100 的話 limit=100 永遠是 false
  return getStore().listActivity(tripId, upper, Math.min(Math.max(limit || 30, 1), 101));
}

/**
 * 操作紀錄裡最近一次刪除這筆支出時的記帳者（createdBy）；找不到回傳 null。
 * 訪客「還原刪掉的支出」時用：訪客拿到的操作紀錄裡 createdBy 是遮蔽過的（見 toGuestActivity）。
 */
function findRemovedExpenseCreator(tripId, expenseId) {
  if (typeof tripId !== 'string' || typeof expenseId !== 'string') return null;
  for (const record of getStore().listActivity(tripId, Number.MAX_SAFE_INTEGER, ACTIVITY_TO_KEEP || 500)) {
    const change = (record.changes || []).find((c) => c && c.type === 'expense.remove' && c.id === expenseId);
    if (change && change.before && typeof change.before.createdBy === 'string') return change.before.createdBy;
  }
  return null;
}

function getTripActivity(tripId, updatedAt) {
  if (typeof tripId !== 'string' || typeof updatedAt !== 'number') return null;
  return getStore().getActivity(tripId, updatedAt);
}

/** 每日備份：data/backups/splitbill-YYYY-MM-DD.db（UTC 日期），只保留最近 N 份。 */
function runDailyBackup() {
  if (!BACKUPS_TO_KEEP) return null;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(BACKUP_DIR, `splitbill-${day}.db`);
    if (!fs.existsSync(target)) getStore().backupTo(target);
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^splitbill-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUPS_TO_KEEP))) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
    backupStatus.lastSuccessAt = fs.statSync(target).mtimeMs;
    return target;
  } catch (err) {
    backupStatus.lastFailureAt = Date.now();
    console.error(`[splitbill-storage] 每日備份失敗：${err.message}`);
    // 每小時會重試一次；同一件事 6 小時內只通知一次
    alert('daily-backup', `每日備份失敗：${err.message}`, { cooldownMs: 6 * 60 * 60 * 1000 });
    return null;
  }
}

/** 啟動時立刻備份一次（升級前留底），之後每小時檢查一次今天備份過沒有。 */
function startBackups() {
  if (backupTimer || !BACKUPS_TO_KEEP) return;
  runDailyBackup();
  backupTimer = setInterval(runDailyBackup, 60 * 60 * 1000);
  backupTimer.unref();
}

/**
 * 🆕 [健康檢查] 資料層的狀態，給 /healthz 用。
 *   db       'ok' | 'error'：資料庫還能不能讀
 *   freeMB   資料目錄所在磁碟的剩餘空間（讀不到時 null）
 *   volume   'mounted' | 'not-mounted' | 'unknown'：Linux 上資料目錄跟根目錄是不是同一個檔案系統
 *            （容器裡沒掛 Volume 時兩者相同，資料會在下次部署時消失）
 *   backup   { enabled, lastSuccessAt, lastFailureAt, ok }：最近一次失敗比最近一次成功還新時 ok=false
 */
function health() {
  let db = 'error';
  try { db = cache && store && store.ping() ? 'ok' : 'error'; } catch (_) { db = 'error'; }
  let freeMB = null;
  try {
    const st = fs.statfsSync(DATA_DIR);
    freeMB = Math.floor((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
  } catch (_) { /* 平台不支援就不回報 */ }
  let volume = 'unknown';
  if (process.platform === 'linux') {
    try { volume = fs.statSync(DATA_DIR).dev === fs.statSync('/').dev ? 'not-mounted' : 'mounted'; } catch (_) { /* unknown */ }
  }
  const { lastSuccessAt, lastFailureAt } = backupStatus;
  return {
    db,
    freeMB,
    volume,
    backup: {
      enabled: BACKUPS_TO_KEEP > 0,
      lastSuccessAt,
      lastFailureAt,
      ok: !lastFailureAt || (!!lastSuccessAt && lastSuccessAt > lastFailureAt),
    },
  };
}

/** 關閉資料庫（服務結束時呼叫；測試也會用到）。 */
function close() {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
  if (store) { store.close(); store = null; }
  cache = null;
  revokedSessions = null;
  snapshot = { trips: new Map(), guilds: new Map() };
  pendingEvents = [];
}

// ─────────────────────────── 行程 ───────────────────────────

/** 依 tripId 取得行程；不存在（或是原型鏈上的名稱）回傳 null。 */
function getTrip(tripId) {
  const db = ensureLoaded();
  return hasOwn(db.trips, tripId) ? expose(db.trips[tripId]) : null;
}

/** 寫入（新增或整包取代）一個已經 repair 過的行程。不會自動 persist／touch。 */
function setTrip(trip) {
  ensureLoaded().trips[trip.id] = trip;
  return expose(trip);
}

/** 刪除行程，並清掉所有伺服器指向它的指標。不會自動 persist。 */
function removeTrip(tripId) {
  const db = ensureLoaded();
  if (!hasOwn(db.trips, tripId)) return false;
  const guildId = db.trips[tripId].guildId;
  delete db.trips[tripId];
  if (guildId) clearGuildPointers(guildId, tripId);
  return true;
}

/**
 * 所有行程（唯讀用途：清單、摘要）。🆕 [效能] 不會把行程記成「交出去過」，
 * 下一次 persist() 不必把全部行程重新比對一遍——要修改行程請改用 getTrip()。
 */
function listTrips() {
  return Object.values(ensureLoaded().trips);
}

/** 依 tripId 讀取行程但不記成「交出去過」（只讀取、不修改的地方用，例如 SSE 權限檢查）。 */
function peekTrip(tripId) {
  const db = ensureLoaded();
  return hasOwn(db.trips, tripId) ? db.trips[tripId] : null;
}

/** 同 findTripByLinkToken()，但不記成「交出去過」（只讀取用）。 */
function peekTripByLinkToken(token) {
  if (!token || typeof token !== 'string') return null;
  ensureLoaded();
  const trip = peekTrip(linkIndex.get(token));
  const link = trip ? (trip.links || []).find((l) => l.token === token) : null;
  return link ? { trip, link } : null;
}

/** 某位使用者建立了幾個行程（只計數，不把行程物件交出去）。 */
function countTripsOwnedBy(userId) {
  let n = 0;
  for (const t of Object.values(ensureLoaded().trips)) if (t.ownerId === userId) n++;
  return n;
}

/** 給 SSE 廣播用：回傳 { trip } 或 null。 */
function findTripById(tripId) {
  const trip = getTrip(tripId);
  return trip ? { trip } : null;
}

/**
 * 🆕 [行程連結] 依 token 找出對應的行程與連結（不檢查是否過期）。連結的網址只帶
 * token，持有者永遠無法從網址本身推測出內部的 tripId。
 * @returns {{ trip: object, link: object } | null}
 */
function findTripByLinkToken(token) {
  if (!token || typeof token !== 'string') return null;
  ensureLoaded();
  const trip = getTrip(linkIndex.get(token));
  const link = trip ? (trip.links || []).find((l) => l.token === token) : null;
  return link ? { trip, link } : null;
}

// ─────────────────────── Discord 伺服器指標 ───────────────────────

/** 讀取某伺服器的指標；不存在時回傳一份空的（不會因為「查詢」就寫入新資料）。 */
function peekGuildState(guildId) {
  const db = ensureLoaded();
  return hasOwn(db.guilds, guildId) ? db.guilds[guildId] : DEFAULT_GUILD_STATE();
}

/** 取得（必要時建立）某伺服器的指標，供寫入使用。 */
function ensureGuildState(guildId) {
  const db = ensureLoaded();
  if (!hasOwn(db.guilds, guildId)) db.guilds[guildId] = DEFAULT_GUILD_STATE();
  return db.guilds[guildId];
}

/** 綁定在某伺服器上的所有行程。 */
function listGuildTrips(guildId) {
  if (!isSnowflake(guildId)) return [];
  return Object.values(ensureLoaded().trips).filter((t) => t.guildId === guildId).map(expose);
}

function clearGuildPointers(guildId, tripId) {
  const db = ensureLoaded();
  if (!hasOwn(db.guilds, guildId)) return;
  const g = db.guilds[guildId];
  if (g.defaultTripId === tripId) g.defaultTripId = null;
  for (const uid of Object.keys(g.activeTripByUser)) {
    if (g.activeTripByUser[uid] === tripId) delete g.activeTripByUser[uid];
  }
}

/**
 * 🆕 [行程獨立化] 把行程綁到某個 Discord 伺服器。一個行程同時只會綁一個伺服器；
 * 從 A 換到 B 時，A 那邊指向它的指標一併清掉。該伺服器還沒有預設行程時，
 * 順便把這個行程設成預設。不會自動 persist／touch。
 */
function attachTripToGuild(trip, guildId) {
  if (!isSnowflake(guildId)) throw new Error('guildId 格式錯誤');
  if (trip.guildId && trip.guildId !== guildId) clearGuildPointers(trip.guildId, trip.id);
  trip.guildId = guildId;
  const g = ensureGuildState(guildId);
  if (!g.defaultTripId || !getTrip(g.defaultTripId) || getTrip(g.defaultTripId).guildId !== guildId) {
    g.defaultTripId = trip.id;
  }
}

function detachTripFromGuild(trip) {
  if (trip.guildId) clearGuildPointers(trip.guildId, trip.id);
  trip.guildId = null;
}

/**
 * 更新行程的 updatedAt 時間戳記並排入廣播。任何寫入行程資料的路徑都必須經過
 * 這裡（webui 樂觀鎖比對 updatedAt、SSE 推播都靠它），之後再呼叫 persist()。
 * meta.writerId：讓寫入者本人的分頁可以精準分辨「這筆推播就是我自己剛存的」。
 *
 * 🆕 [SQLite] 兩個行為變更：
 *  - updatedAt 嚴格遞增（至少比同一行程上一次的值大 1），同一毫秒內的兩次寫入
 *    也會得到不同的版本號，舊版本的客戶端不會因為時間戳剛好相同而通過樂觀鎖比對。
 *  - 'trip-updated' 事件不在這裡立刻發出，而是等 persist() 成功寫進資料庫之後。
 * @param {object} trip - 要更新的行程物件（直接修改，不回傳新物件）
 */
function touchTrip(trip, meta) {
  if (trip && typeof trip === 'object') {
    const prev = trip.id ? (lastStamp.get(trip.id) || 0) : 0;
    trip.updatedAt = Math.max(Date.now(), prev + 1);
    if (trip.id) {
      expose(trip);
      lastStamp.set(trip.id, trip.updatedAt);
      pendingEvents.push([trip.id, meta || {}]);
    }
  }
}

/**
 * 🆕 [行程連結] 判斷一筆連結是否已過期。expiresAt 為 null 代表永久有效。
 */
function isLinkExpired(link) {
  if (!link) return true;
  if (link.expiresAt === null || link.expiresAt === undefined) return false;
  return Date.now() > link.expiresAt;
}

/**
 * 🔒 [安全性] 回傳給客戶端的 trip 一律不帶 links（以及舊版的 shareLinks／invite）。
 * 存的都是 token（等同密碼）：如果連同行程一起回傳，任何一把分享連結
 * 的持有者（包含「唯讀」）都能撈出可寫入的憑證。所有把 trip 送出伺服器的
 * 地方（GET/PUT 回應、409 的 currentTrip、SSE 廣播、清單）都必須經過這裡。
 * 回傳淺拷貝，不會動到儲存中的原物件。
 */
function toPublicTrip(trip) {
  if (!trip || typeof trip !== 'object') return trip;
  const { links, shareLinks, invite, ...rest } = trip; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * 🔒 [隱私] 給分享連結訪客（沒有登入、沒有 Discord 身分）的版本：在 toPublicTrip() 之外，
 * 再拿掉建立者與成員的 Discord ID，只保留「這位成員已連結」（linked: true）。
 * 訪客路徑（/api/shared-trip/...、訪客的 SSE）送出行程時一律經過這裡。
 */
function toGuestTrip(trip) {
  const pub = toPublicTrip(trip);
  if (!pub || typeof pub !== 'object') return pub;
  const { ownerId, ...rest } = pub; // eslint-disable-line no-unused-vars
  rest.members = (Array.isArray(pub.members) ? pub.members : []).map((m) => (
    m.discordId ? { id: m.id, name: m.name, linked: true } : { id: m.id, name: m.name }
  ));
  if (Array.isArray(pub.expenses)) rest.expenses = pub.expenses.map(toGuestExpense);
  return rest;
}

// 🔒 [隱私] 從 Discord 記帳的支出，createdBy 是記帳者的 Discord ID；訪客只看得到「從 Discord 記的」
const GUEST_CREATED_BY_DISCORD = 'discord';
function toGuestExpense(e) {
  return e && isSnowflake(e.createdBy) ? { ...e, createdBy: GUEST_CREATED_BY_DISCORD } : e;
}

/** 給訪客的操作紀錄：支出變動的 before／after 一樣不帶記帳者的 Discord ID。 */
function toGuestActivity(record) {
  if (!record || !Array.isArray(record.changes)) return record;
  return {
    ...record,
    changes: record.changes.map((c) => {
      if (!c || typeof c.type !== 'string' || !c.type.startsWith('expense.')) return c;
      const out = { ...c };
      if (c.before) out.before = toGuestExpense(c.before);
      if (c.after) out.after = toGuestExpense(c.after);
      return out;
    }),
  };
}

/**
 * 訪客整包寫入時：已存在的支出沿用伺服器上的 createdBy（訪客拿到的是遮蔽過的值，
 * 原樣存回會蓋掉真正的記帳者）；新增的支出不能自稱是某個 Discord 使用者記的。直接修改 repaired。
 */
function restoreGuestCreatedBy(existing, repaired) {
  const byId = new Map(((existing && existing.expenses) || []).map((e) => [e.id, e]));
  for (const e of (repaired && repaired.expenses) || []) {
    const old = byId.get(e.id);
    if (old) e.createdBy = old.createdBy;
    else if (isSnowflake(e.createdBy) || e.createdBy === GUEST_CREATED_BY_DISCORD) e.createdBy = 'web-ui';
  }
  return repaired;
}

// ─────────────────────── 🆕 已登出的 session ───────────────────────
// session cookie 是無狀態的簽章（lib/session.js），登出時把它的 sid 記在這裡直到原本的
// 到期時間，之後就算 cookie 被複製走也不能再用。到期的紀錄 session 本身也失效了，順手清掉。
let revokedSessions = null; // sid -> expiresAt

function loadRevokedSessions() {
  if (!revokedSessions) {
    revokedSessions = new Map(getStore().listRevokedSessions(Date.now()).map((r) => [r.sid, r.expiresAt]));
  }
  return revokedSessions;
}

function isSessionRevoked(sid) {
  if (typeof sid !== 'string') return false;
  const map = loadRevokedSessions();
  const exp = map.get(sid);
  if (exp === undefined) return false;
  if (exp < Date.now()) { map.delete(sid); return false; }
  return true;
}

function revokeSession(sid, expiresAt) {
  if (typeof sid !== 'string' || !sid) return;
  getStore().revokeSession(sid, expiresAt, Date.now());
  loadRevokedSessions().set(sid, expiresAt);
}

/** 清單用的精簡摘要（不含帳目內容）。 */
function toTripSummary(trip) {
  return {
    id: trip.id,
    name: trip.name,
    baseCurrency: trip.baseCurrency,
    archived: !!trip.archived,
    guildId: trip.guildId || null,
    ownerId: trip.ownerId || null,
    memberCount: trip.members.length,
    updatedAt: trip.updatedAt || trip.createdAt || null,
  };
}

module.exports = {
  DATA_VERSION,
  isSnowflake,
  hasOwn,
  toPublicTrip,
  toGuestTrip,
  toGuestActivity,
  restoreGuestCreatedBy,
  preserveUnknownFields,
  preserveUnknownEntryFields,
  toGuestExpense,
  health,
  toTripSummary,
  MAX_ENTRIES,
  tooManyEntries,
  isSessionRevoked,
  revokeSession,
  peekTrip,
  peekTripByLinkToken,
  genId,
  genShareToken,
  persist,
  touchTrip,
  loadAll,
  close,
  startBackups,
  runDailyBackup,
  getTripRevision,
  listTripRevisions,
  listTripActivity,
  getTripActivity,
  findRemovedExpenseCreator,
  DB_FILE,
  DEFAULT_TRIP,
  repairTrip,
  repairMembers,
  repairExpense,
  repairDeposit,
  repairLink,
  isLinkExpired,
  getTrip,
  setTrip,
  removeTrip,
  listTrips,
  countTripsOwnedBy,
  findTripById,
  findTripByLinkToken,
  peekGuildState,
  ensureGuildState,
  listGuildTrips,
  attachTripToGuild,
  detachTripFromGuild,
  migrateV1,
  tripEvents,
};
