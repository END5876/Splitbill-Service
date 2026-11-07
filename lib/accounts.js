'use strict';
/**
 * 🆕 [LINE 登入] 使用者身分字串的格式與成員連結欄位，集中在這裡。
 *
 * 身分（principal.userId、trip.ownerId、操作紀錄的 actor.userId）有兩種格式：
 *   Discord  snowflake（純數字），跟過去完全一樣
 *   LINE     'line:' + LINE 的 userId（U 開頭加 32 碼 hex），例如 line:U0123…
 * 兩種格式不可能撞號，所以權限判斷只要比對字串，不用知道是哪個平台。
 *
 * 成員的連結欄位：
 *   discordId  已連結的 Discord 帳號（Mousebot 直接讀這個欄位，只會放 Discord ID）
 *   lineId     已連結、而且只用 LINE 的帳號（line:U…）
 * 一位成員最多只有其中一個。LINE 帳號綁定到 Discord 帳號之後（見 storage 的帳號綁定），
 * 主身分就是 Discord ID，行程裡的 lineId 會在合併時改成 discordId。
 */
const { isSnowflake } = require('./snowflake');

const LINE_PREFIX = 'line:';
const LINE_ID_RE = /^line:U[0-9a-f]{32}$/;

function isLineId(v) {
  return typeof v === 'string' && LINE_ID_RE.test(v);
}

/** LINE API 回傳的 userId（U…）轉成這裡用的身分字串；格式不對回傳 null。 */
function lineAccountId(lineUserId) {
  const id = LINE_PREFIX + String(lineUserId || '');
  return isLineId(id) ? id : null;
}

/** 合法的使用者身分：Discord ID 或 line:U…。 */
function isAccountId(v) {
  return isSnowflake(v) || isLineId(v);
}

/** 身分屬於哪個平台：'discord' | 'line' | null。 */
function providerOf(v) {
  if (isSnowflake(v)) return 'discord';
  if (isLineId(v)) return 'line';
  return null;
}

/** 這位成員連結的帳號（Discord ID 或 line:U…）；未連結回傳 null。 */
function memberAccountId(m) {
  if (!m) return null;
  return m.discordId || m.lineId || null;
}

/** 依身分格式，把連結寫進成員（並清掉另一個欄位）。直接修改 member。 */
function setMemberAccount(member, accountId) {
  delete member.discordId;
  delete member.lineId;
  if (isSnowflake(accountId)) member.discordId = accountId;
  else if (isLineId(accountId)) member.lineId = accountId;
  return member;
}

function clearMemberAccount(member) {
  delete member.discordId;
  delete member.lineId;
  return member;
}

/** 找出連結到指定帳號的成員。 */
function findMemberByAccount(trip, accountId) {
  if (!trip || !accountId) return null;
  return (trip.members || []).find((m) => memberAccountId(m) === accountId) || null;
}

module.exports = {
  LINE_PREFIX,
  isLineId,
  lineAccountId,
  isAccountId,
  providerOf,
  memberAccountId,
  setMemberAccount,
  clearMemberAccount,
  findMemberByAccount,
};
