'use strict';
// 行程送出伺服器前的樣子（去掉憑證、遮蔽帳號）與「誰記的、誰改過」的標記。全是純函式。
// 由 lib/storage.js 統一匯出，其他檔案照舊從 storage 取用。

const { isSnowflake } = require('./snowflake');
const { isLineId, memberAccountId } = require('./accounts');
const { EXPENSE_FIELDS, DEPOSIT_FIELDS } = require('./tripRepair');

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
  const { links, shareLinks, invite, ...rest } = trip;
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
  const { ownerId, ...rest } = pub;
  rest.members = (Array.isArray(pub.members) ? pub.members : []).map((m) => (
    memberAccountId(m) ? { id: m.id, name: m.name, linked: true } : { id: m.id, name: m.name }
  ));
  if (Array.isArray(pub.expenses)) rest.expenses = pub.expenses.map(toGuestExpense);
  if (Array.isArray(pub.deposits)) rest.deposits = pub.deposits.map(toGuestExpense);
  return rest;
}

// 🔒 [隱私] createdBy／updatedBy 是記帳者的帳號（Discord ID 或 line:…）；訪客只看得到「是成員記的」
const GUEST_CREATED_BY_DISCORD = 'discord';
const isAccountRef = (v) => isSnowflake(v) || isLineId(v);
function toGuestExpense(e) {
  if (!e || !(isAccountRef(e.createdBy) || isAccountRef(e.updatedBy))) return e;
  const out = { ...e };
  if (isAccountRef(out.createdBy)) out.createdBy = GUEST_CREATED_BY_DISCORD;
  if (isAccountRef(out.updatedBy)) out.updatedBy = GUEST_CREATED_BY_DISCORD;
  return out;
}

/**
 * 🆕 寫入時記下「誰記的、誰改過」：前端傳來的 createdBy／updatedBy 一律不信，改用這次請求的身分。
 *   - 新的一筆：createdBy＝操作者（網頁登入者的帳號、Bot 代為操作的 Discord 使用者）；
 *     沒有可辨識的身分（訪客、管理金鑰）時保留原本的規則（訪客見 restoreGuestCreatedBy）
 *   - 既有的一筆：createdBy 沿用伺服器上的值；內容有變才把 updatedBy 換成操作者（訪客記成 'guest'）
 * existingList／list 是同一種帳目（支出或轉帳）；直接修改 list 裡的物件。
 */
// 只比這個版本認得的內容欄位：伺服器上的舊資料可能帶著較新版本寫的欄位（keepUnknown），不能因此算成「改過」
const CONTENT_KEYS = [...new Set([...EXPENSE_FIELDS, ...DEPOSIT_FIELDS])].filter((k) => k !== 'createdBy' && k !== 'updatedBy').sort();
function entryContentKey(x) {
  return JSON.stringify(CONTENT_KEYS.map((k) => [k, x[k] === undefined ? null : x[k]]));
}
function actorAccountId(actor) {
  if (!actor) return null;
  if ((actor.kind === 'user' || actor.kind === 'bot') && typeof actor.userId === 'string') return actor.userId.slice(0, 64);
  if (actor.kind === 'guest') return 'guest';
  return null;
}
function stampAuthors(existingList, list, actor) {
  const who = actorAccountId(actor);
  const byId = new Map((existingList || []).map((x) => [x.id, x]));
  for (const x of list || []) {
    const old = byId.get(x.id);
    if (!old) {
      if (who && who !== 'guest') x.createdBy = who;
      // 🔒 訪客新增的不能自稱是某個成員（支出、轉帳都一樣；Discord ID、LINE 帳號、遮蔽過的 'discord' 都不行）
      else if (who === 'guest' && (isAccountRef(x.createdBy) || x.createdBy === GUEST_CREATED_BY_DISCORD)) {
        if (Object.prototype.hasOwnProperty.call(x, 'payers')) x.createdBy = 'web-ui';
        else delete x.createdBy;
      }
      delete x.updatedBy;
      continue;
    }
    if (old.createdBy !== undefined) x.createdBy = old.createdBy;
    else delete x.createdBy;
    if (who && entryContentKey(x) !== entryContentKey(old)) x.updatedBy = who;
    else if (old.updatedBy !== undefined) x.updatedBy = old.updatedBy;
    else delete x.updatedBy;
  }
}
/** 整包寫入（PUT 整個行程）用：支出與轉帳都記下誰記的、誰改過。直接修改 repaired。 */
function stampTripAuthors(existing, repaired, actor) {
  stampAuthors(existing && existing.expenses, repaired.expenses, actor);
  stampAuthors(existing && existing.deposits, repaired.deposits, actor);
  return repaired;
}

/** 給訪客的操作紀錄：支出變動的 before／after 一樣不帶記帳者的 Discord ID。 */
function toGuestActivity(record) {
  if (!record || !Array.isArray(record.changes)) return record;
  return {
    ...record,
    changes: record.changes.map((c) => {
      if (!c || typeof c.type !== 'string' || !(c.type.startsWith('expense.') || c.type.startsWith('deposit.'))) return c;
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
  toPublicTrip,
  isLinkExpired,
  toGuestTrip,
  toGuestExpense,
  actorAccountId,
  stampAuthors,
  stampTripAuthors,
  toGuestActivity,
  restoreGuestCreatedBy,
  toTripSummary,
};
