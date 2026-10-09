'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { openStore } = require('./db');

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
const REVISIONS_TO_KEEP = envInt('SPLITBILL_REVISIONS_KEEP', 20);    // 每個行程保留幾個歷史版本

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

// Discord 的 snowflake ID：17–20 位數字。只有符合這個格式的字串才會被當成
// 「已連結的 Discord 帳號」或「真實的 Discord 伺服器」。
const SNOWFLAKE_RE = /^\d{17,20}$/;
function isSnowflake(v) {
  return typeof v === 'string' && SNOWFLAKE_RE.test(v);
}

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
  // 🆕 [分享連結] 這個行程目前開放的分享連結清單（token 等同密碼，永遠不回傳給一般讀取）。
  shareLinks: [],    // [{ token, label, permission:'read'|'write', expiresAt:number|null, createdAt }]
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

function genId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 🆕 [分享連結] 產生當作憑證使用的 token（分享連結、成員邀請連結）。
 * 刻意跟 genId() 分開：genId() 只需要「不重複」，這裡的 token 本身就是
 * 一組會被拿去當 API 憑證使用的「密碼」，因此用 24 bytes（192 bits）亂數。
 */
function genShareToken() {
  return crypto.randomBytes(24).toString('hex');
}

function emptyDb() {
  return { version: DATA_VERSION, trips: {}, guilds: {} };
}

/**
 * 資料防呆：成員清單。
 * - id 必須是非空字串，重複 id 只保留第一筆
 * - discordId 只保留 snowflake 格式，且同一個行程裡一個 Discord 帳號最多連結一位成員
 *   （重複者保留第一筆、後面的一律視為未連結）
 */
function repairMembers(rawMembers) {
  const list = Array.isArray(rawMembers) ? rawMembers : [];
  const seenIds = new Set();
  const seenDiscord = new Set();
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const id = typeof m.id === 'string' && m.id.trim() ? m.id.trim().slice(0, 64) : null;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const member = { id, name: (typeof m.name === 'string' && m.name.trim()) ? m.name.trim().slice(0, 60) : '未知成員' };
    if (isSnowflake(m.discordId) && !seenDiscord.has(m.discordId)) {
      member.discordId = m.discordId;
      seenDiscord.add(m.discordId);
    }
    out.push(member);
  }
  return out;
}

/**
 * 資料防呆與自動修復：補齊缺漏欄位、修正舊版格式，避免程式因缺欄位而崩潰。
 */
function repairTrip(rawTrip) {
  const def = DEFAULT_TRIP();
  const trip = { ...def, ...(rawTrip || {}) };

  trip.rates = { ...def.rates, ...(rawTrip && rawTrip.rates ? rawTrip.rates : {}) };
  if (!trip.rates[trip.baseCurrency]) trip.rates[trip.baseCurrency] = 1;

  trip.members = repairMembers(trip.members);

  trip.expenses = Array.isArray(trip.expenses) ? trip.expenses : [];
  trip.expenses = trip.expenses.map((e) => repairExpense(e));

  trip.deposits = Array.isArray(trip.deposits) ? trip.deposits : [];
  trip.deposits = trip.deposits.map((d) => repairDeposit(d));

  // 🆕 [分享連結]
  trip.shareLinks = Array.isArray(trip.shareLinks) ? trip.shareLinks : [];
  trip.shareLinks = trip.shareLinks.map((l) => repairShareLink(l)).filter(Boolean);

  // 🆕 [成員邀請] 一個行程同時只有一組有效的邀請連結；格式不對就整個拿掉
  // （之後有人要用時再產生新的），不憑空補一組新的 token。
  if (trip.invite && typeof trip.invite.token === 'string' && trip.invite.token.length >= 32) {
    trip.invite = {
      token: trip.invite.token,
      createdAt: typeof trip.invite.createdAt === 'number' ? trip.invite.createdAt : Date.now(),
    };
  } else {
    delete trip.invite;
  }

  // 行程建立者（Discord user ID）。只接受非空字串；其餘一律移除，避免髒資料。
  if (typeof trip.ownerId === 'string' && trip.ownerId.trim()) trip.ownerId = trip.ownerId.trim().slice(0, 64);
  else delete trip.ownerId;

  // 綁定的 Discord 伺服器：只接受 snowflake，其餘一律視為未綁定。
  if (!isSnowflake(trip.guildId)) trip.guildId = null;

  if (typeof trip.archived !== 'boolean') trip.archived = false;
  if (typeof trip.createdAt !== 'number') trip.createdAt = Date.now();
  if (!trip.id) trip.id = genId('trip');
  if (!trip.name) trip.name = '未命名行程';

  return trip;
}

function repairExpense(rawExp) {
  const e = rawExp || {};
  return {
    id: e.id || genId('exp'),
    description: e.description || '（無說明）',
    amount: typeof e.amount === 'number' ? e.amount : 0,
    currency: e.currency || 'TWD',
    amountInBase: typeof e.amountInBase === 'number' ? e.amountInBase : (typeof e.amount === 'number' ? e.amount : 0),
    payers: Array.isArray(e.payers) ? e.payers : [],
    participants: Array.isArray(e.participants) ? e.participants : [],
    createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
    createdBy: e.createdBy || 'unknown',
  };
}

/**
 * 資料防呆：修復預收款/訂金紀錄，補齊缺漏欄位，避免壞掉的資料
 * 在結算計算（calcNetBalances 等）中悄悄產生 NaN 或算錯淨額。
 */
function repairDeposit(rawDep) {
  const d = rawDep || {};
  return {
    id: d.id || genId('dep'),
    collectorId: d.collectorId || null,
    payerId: d.payerId || null,
    amount: typeof d.amount === 'number' ? d.amount : 0,
    currency: d.currency || 'TWD',
    amountInBase: typeof d.amountInBase === 'number' ? d.amountInBase : (typeof d.amount === 'number' ? d.amount : 0),
    note: d.note || '',
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : Date.now(),
  };
}

/**
 * 🆕 [分享連結] 資料防呆：修復單筆分享連結紀錄。token 缺漏或損毀時回傳
 * null 讓呼叫端直接丟棄，不憑空「復活」一筆使用者從未建立過的有效連結。
 * @returns {object|null}
 */
function repairShareLink(rawLink) {
  const l = rawLink || {};
  if (!l.token || typeof l.token !== 'string') return null;
  return {
    token: l.token,
    label: typeof l.label === 'string' ? l.label.slice(0, 50) : '',
    permission: l.permission === 'write' ? 'write' : 'read',
    expiresAt: typeof l.expiresAt === 'number' ? l.expiresAt : null,
    createdAt: typeof l.createdAt === 'number' ? l.createdAt : Date.now(),
  };
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
let shareIndex = new Map();    // 分享連結 token -> tripId
let inviteIndex = new Map();   // 成員邀請 token -> tripId
let backupTimer = null;

function getStore() {
  if (!store) {
    store = openStore(DB_FILE, {
      journalMode: process.env.SPLITBILL_SQLITE_JOURNAL,
      revisionsToKeep: REVISIONS_TO_KEEP,
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
    trips[id] = repairTrip(rawTrips[id]);
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

function tripRow(trip, json, withRevision) {
  return {
    id: trip.id,
    guildId: trip.guildId || null,
    ownerId: trip.ownerId || null,
    updatedAt: typeof trip.updatedAt === 'number' ? trip.updatedAt : null,
    createdAt: typeof trip.createdAt === 'number' ? trip.createdAt : null,
    json,
    // 歷史版本不存憑證（分享連結、邀請 token），只存行程內容
    revisionJson: withRevision ? JSON.stringify(toPublicTrip(trip)) : null,
  };
}

/**
 * 第一次啟動：有舊的 splitbill.json 就整份匯入（同一個交易，失敗就整個不算數），
 * 成功後把 JSON 改名留作備份；沒有就建立空的資料庫。
 */
function initializeStore(s) {
  if (!fs.existsSync(LEGACY_JSON_FILE)) {
    s.initialize({ source: 'empty' });
    return;
  }
  const legacy = readLegacyJson(LEGACY_JSON_FILE);
  const c = buildCache(legacy.trips, legacy.guilds);
  const trips = Object.values(c.trips).map((t) => tripRow(t, JSON.stringify(t), true));
  const guilds = Object.keys(c.guilds).map((gid) => ({ guildId: gid, json: JSON.stringify(c.guilds[gid]) }));
  s.initialize({ trips, guilds, source: 'splitbill.json' });

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
  shareIndex = new Map();
  inviteIndex = new Map();
  for (const t of Object.values(cache.trips)) {
    for (const l of t.shareLinks || []) shareIndex.set(l.token, t.id);
    if (t.invite && t.invite.token) inviteIndex.set(t.invite.token, t.id);
  }
}

function loadAll() {
  if (cache) return cache;
  const s = getStore();
  if (!s.isInitialized()) initializeStore(s);

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
  rebuildIndexes();
  return cache;
}

/**
 * 把 cache 目前的狀態寫進資料庫（只寫有變動的部分），成功後才廣播排隊中的 SSE 事件。
 * 失敗時丟例外，而且 cache 已經恢復成資料庫裡的狀態。
 */
function persist() {
  const c = loadAll();
  const events = pendingEvents;
  pendingEvents = [];
  try {
    persistChanges(c);
  } catch (err) {
    console.error(`[splitbill-storage] 寫入資料庫失敗，已丟棄這次尚未儲存的修改：${err.message}`);
    cache = null;
    loadAll();
    throw err;
  }
  for (const [tripId, meta] of events) {
    if (hasOwn(cache.trips, tripId)) tripEvents.emit('trip-updated', tripId, meta);
  }
}

function persistChanges(c) {
  const changes = { trips: [], deleteTrips: [], guilds: [], deleteGuilds: [] };
  const next = { trips: new Map(), guilds: new Map() };

  for (const id of Object.keys(c.trips)) {
    const trip = c.trips[id];
    const json = JSON.stringify(trip);
    const updatedAt = typeof trip.updatedAt === 'number' ? trip.updatedAt : null;
    const prev = snapshot.trips.get(id);
    next.trips.set(id, { json, updatedAt });
    if (!prev || prev.json !== json) {
      // 只有行程內容版本（updatedAt）變了才留歷史版本；只改分享連結之類的不算
      changes.trips.push(tripRow(trip, json, !prev || prev.updatedAt !== updatedAt));
    }
  }
  for (const id of snapshot.trips.keys()) if (!next.trips.has(id)) changes.deleteTrips.push(id);

  for (const gid of Object.keys(c.guilds)) {
    const json = JSON.stringify(c.guilds[gid]);
    const prev = snapshot.guilds.get(gid);
    next.guilds.set(gid, { json });
    if (!prev || prev.json !== json) changes.guilds.push({ guildId: gid, json });
  }
  for (const gid of snapshot.guilds.keys()) if (!next.guilds.has(gid)) changes.deleteGuilds.push(gid);

  const dirty = changes.trips.length || changes.deleteTrips.length || changes.guilds.length || changes.deleteGuilds.length;
  if (dirty) {
    getStore().apply(changes);
    snapshot = next;
  }
  rebuildIndexes();
}

/** 某行程在某個 updatedAt 版本時的內容（不含憑證）；沒有這個版本回傳 null。 */
function getTripRevision(tripId, updatedAt) {
  if (typeof tripId !== 'string' || typeof updatedAt !== 'number') return null;
  return getStore().getRevision(tripId, updatedAt);
}

function listTripRevisions(tripId) {
  return typeof tripId === 'string' ? getStore().listRevisions(tripId) : [];
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
    return target;
  } catch (err) {
    console.error(`[splitbill-storage] 每日備份失敗：${err.message}`);
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

/** 關閉資料庫（服務結束時呼叫；測試也會用到）。 */
function close() {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
  if (store) { store.close(); store = null; }
  cache = null;
  snapshot = { trips: new Map(), guilds: new Map() };
  pendingEvents = [];
}

// ─────────────────────────── 行程 ───────────────────────────

/** 依 tripId 取得行程；不存在（或是原型鏈上的名稱）回傳 null。 */
function getTrip(tripId) {
  const db = loadAll();
  return hasOwn(db.trips, tripId) ? db.trips[tripId] : null;
}

/** 寫入（新增或整包取代）一個已經 repair 過的行程。不會自動 persist／touch。 */
function setTrip(trip) {
  loadAll().trips[trip.id] = trip;
  return trip;
}

/** 刪除行程，並清掉所有伺服器指向它的指標。不會自動 persist。 */
function removeTrip(tripId) {
  const db = loadAll();
  if (!hasOwn(db.trips, tripId)) return false;
  const guildId = db.trips[tripId].guildId;
  delete db.trips[tripId];
  if (guildId) clearGuildPointers(guildId, tripId);
  return true;
}

function listTrips() {
  return Object.values(loadAll().trips);
}

/** 給 SSE 廣播用：回傳 { trip } 或 null。 */
function findTripById(tripId) {
  const trip = getTrip(tripId);
  return trip ? { trip } : null;
}

/**
 * 🆕 [分享連結] 依 token 找出對應的行程與連結。分享連結的網址只帶 token，
 * 持有者永遠無法從網址本身推測出內部的 tripId。
 * @returns {{ trip: object, shareLink: object } | null}
 */
function findTripByShareToken(token) {
  if (!token || typeof token !== 'string') return null;
  loadAll();
  const trip = getTrip(shareIndex.get(token));
  const shareLink = trip ? (trip.shareLinks || []).find((l) => l.token === token) : null;
  return shareLink ? { trip, shareLink } : null;
}

/** 🆕 [成員邀請] 依邀請 token 找出行程。 */
function findTripByInviteToken(token) {
  if (!token || typeof token !== 'string') return null;
  loadAll();
  const trip = getTrip(inviteIndex.get(token));
  return trip && trip.invite && trip.invite.token === token ? trip : null;
}

// ─────────────────────── Discord 伺服器指標 ───────────────────────

/** 讀取某伺服器的指標；不存在時回傳一份空的（不會因為「查詢」就寫入新資料）。 */
function peekGuildState(guildId) {
  const db = loadAll();
  return hasOwn(db.guilds, guildId) ? db.guilds[guildId] : DEFAULT_GUILD_STATE();
}

/** 取得（必要時建立）某伺服器的指標，供寫入使用。 */
function ensureGuildState(guildId) {
  const db = loadAll();
  if (!hasOwn(db.guilds, guildId)) db.guilds[guildId] = DEFAULT_GUILD_STATE();
  return db.guilds[guildId];
}

/** 綁定在某伺服器上的所有行程。 */
function listGuildTrips(guildId) {
  if (!isSnowflake(guildId)) return [];
  return listTrips().filter((t) => t.guildId === guildId);
}

function clearGuildPointers(guildId, tripId) {
  const db = loadAll();
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
      lastStamp.set(trip.id, trip.updatedAt);
      pendingEvents.push([trip.id, meta || {}]);
    }
  }
}

/**
 * 🆕 [分享連結] 判斷一筆分享連結是否已過期。expiresAt 為 null 代表永久有效。
 */
function isShareLinkExpired(link) {
  if (!link) return true;
  if (link.expiresAt === null || link.expiresAt === undefined) return false;
  return Date.now() > link.expiresAt;
}

/**
 * 🔒 [安全性] 回傳給客戶端的 trip 一律不帶 shareLinks 與 invite。
 * 兩者存的都是 token（等同密碼）：如果連同行程一起回傳，任何一把分享連結
 * 的持有者（包含「唯讀」）都能撈出可寫入的憑證。所有把 trip 送出伺服器的
 * 地方（GET/PUT 回應、409 的 currentTrip、SSE 廣播、清單）都必須經過這裡。
 * 回傳淺拷貝，不會動到儲存中的原物件。
 */
function toPublicTrip(trip) {
  if (!trip || typeof trip !== 'object') return trip;
  const { shareLinks, invite, ...rest } = trip; // eslint-disable-line no-unused-vars
  return rest;
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
  toTripSummary,
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
  DB_FILE,
  DEFAULT_TRIP,
  repairTrip,
  repairMembers,
  repairExpense,
  repairDeposit,
  repairShareLink,
  isShareLinkExpired,
  getTrip,
  setTrip,
  removeTrip,
  listTrips,
  findTripById,
  findTripByShareToken,
  findTripByInviteToken,
  peekGuildState,
  ensureGuildState,
  listGuildTrips,
  attachTripToGuild,
  detachTripFromGuild,
  migrateV1,
  tripEvents,
};
