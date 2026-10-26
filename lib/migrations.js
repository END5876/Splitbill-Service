'use strict';
/**
 * 資料庫 schema 遷移（由 lib/db.js 的 openStore() 依序執行）。
 * -----------------------------------------------------------------
 * MIGRATIONS[v](db, { justImported }) 把資料庫從 v-1 升到 v，在同一個交易裡執行，成功後 schema_version 才會更新。
 * justImported：資料是這次啟動才從舊的 splitbill.json 匯入的（沒有開著的舊頁面要顧慮）。
 * 執行前 db.js 會先 VACUUM INTO 一份 backups/splitbill-pre-v<v>-<時間>.db。
 *
 * ⚠️ 新增會改變資料形狀的遷移時：
 *   1. 在 lib/db.js 把 SCHEMA_VERSION 加 1，並在這裡加上對應的函式
 *   2. 在 README 的「回滾邊界」表加一列：之後不能直接回滾到這個版本之前的映像
 */
const crypto = require('crypto');
const { isSnowflake } = require('./snowflake');

// 成員引用出現的欄位：支出的 payers／participants[].userId、轉帳的 payerId／collectorId
const MEMBER_REF_KEYS = new Set(['userId', 'payerId', 'collectorId']);

function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * 把物件裡指向成員的 id 依 map 換掉（深層走訪）。
 * - 只換 MEMBER_REF_KEYS 與 id 欄位，discordId、createdBy 不動（那些本來就是 Discord 使用者 ID）
 * - actor（操作紀錄的操作者）整個跳過：它的 userId 是 Discord 使用者 ID，不是成員 ID
 */
function remapMemberRefs(value, map) {
  if (Array.isArray(value)) return value.map((v) => remapMemberRefs(v, map));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'actor') setOwn(out, k, v);
    else if ((k === 'id' || MEMBER_REF_KEYS.has(k)) && typeof v === 'string' && map.has(v)) setOwn(out, k, map.get(v));
    else setOwn(out, k, remapMemberRefs(v, map));
  }
  return out;
}

function newMemberId(used) {
  let id;
  do id = `mem_${crypto.randomBytes(4).toString('hex')}`; while (used.has(id));
  used.add(id);
  return id;
}

/**
 * v2：v1 遷移過來的成員 id 就是 Discord ID（snowflake），會經由分享連結的訪客視圖、
 * 歷史版本與操作紀錄洩漏出去。換成 mem_xxxx，並改寫行程、歷史版本與操作紀錄裡的引用。
 * 成員的 discordId 不變，所以 Bot 端（一律用 discordId 找成員）不受影響。
 * 有改到的行程 updatedAt 會加 1，還開著舊頁面的分頁下次存檔會拿到 409、重新合併
 * （剛從 JSON 匯入的資料不用，版本號維持原樣）。
 */
function migrateLegacyMemberIds(db, { justImported = false } = {}) {
  const trips = db.prepare('SELECT id, updated_at, data FROM trips').all();
  const updateTrip = db.prepare('UPDATE trips SET updated_at = ?, data = ? WHERE id = ?');
  const revisionsOf = db.prepare('SELECT updated_at, data FROM trip_revisions WHERE trip_id = ?');
  const updateRevision = db.prepare('UPDATE trip_revisions SET data = ? WHERE trip_id = ? AND updated_at = ?');
  const activityOf = db.prepare('SELECT updated_at, data FROM trip_activity WHERE trip_id = ?');
  const updateActivity = db.prepare('UPDATE trip_activity SET data = ? WHERE trip_id = ? AND updated_at = ?');
  let changedTrips = 0;
  let changedMembers = 0;

  for (const row of trips) {
    const trip = JSON.parse(row.data);
    const revisions = revisionsOf.all(row.id).map((r) => ({ updatedAt: r.updated_at, data: JSON.parse(r.data) }));

    // 目前的成員與歷史版本裡出現過的成員都要換（被刪掉的成員也可能出現在舊版本裡），
    // 帳目裡引用到的也要：成員被移除後，支出／轉帳裡仍可能留著他的 id（Discord ID）
    const used = new Set();
    const legacy = new Set();
    const consider = (id) => {
      if (typeof id !== 'string') return;
      used.add(id);
      if (isSnowflake(id)) legacy.add(id);
    };
    for (const t of [trip, ...revisions.map((r) => r.data)]) {
      if (!t || typeof t !== 'object') continue;
      for (const m of Array.isArray(t.members) ? t.members : []) if (m) consider(m.id);
      for (const e of Array.isArray(t.expenses) ? t.expenses : []) {
        for (const p of [...(e && Array.isArray(e.payers) ? e.payers : []), ...(e && Array.isArray(e.participants) ? e.participants : [])]) {
          if (p) consider(p.userId);
        }
      }
      for (const d of Array.isArray(t.deposits) ? t.deposits : []) {
        if (d) { consider(d.payerId); consider(d.collectorId); }
      }
    }
    if (!legacy.size) continue;
    const map = new Map([...legacy].map((id) => [id, newMemberId(used)]));

    const next = remapMemberRefs(trip, map);
    if (!justImported && typeof next.updatedAt === 'number') next.updatedAt += 1;
    updateTrip.run(typeof next.updatedAt === 'number' ? next.updatedAt : row.updated_at, JSON.stringify(next), row.id);
    for (const r of revisions) updateRevision.run(JSON.stringify(remapMemberRefs(r.data, map)), row.id, r.updatedAt);
    for (const a of activityOf.all(row.id)) {
      updateActivity.run(JSON.stringify(remapMemberRefs(JSON.parse(a.data), map)), row.id, a.updated_at);
    }
    changedTrips++;
    changedMembers += map.size;
  }
  if (changedTrips) {
    console.log(`[splitbill-db] schema v2：${changedTrips} 個行程、${changedMembers} 位舊版成員的 id 已從 Discord ID 換成 mem_ 開頭的 id`);
  }
}

const MIGRATIONS = {
  2: migrateLegacyMemberIds,
};

module.exports = { MIGRATIONS, remapMemberRefs };
