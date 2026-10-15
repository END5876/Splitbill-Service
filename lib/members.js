'use strict';
/**
 * 🆕 [行程獨立化] 成員與 Discord 帳號的連結規則，集中在這裡由伺服器強制執行。
 *
 * discordId 決定「誰能以成員身分操作這個行程」，因此不能讓任何一個 PUT
 * 整包覆蓋進來：可編輯分享連結的持有者、或某位網頁成員，只要在 members
 * 裡塞一個自己的 discordId，就能把自己升級成成員。規則：
 *
 *   - 已存在的成員（以 id 比對）：一律沿用伺服器上的 discordId。
 *       canLink=true 的呼叫端（Bot）可以替「目前未連結」的成員補上 discordId
 *       （Discord 面板的「連結成員」），但不能改寫或清掉既有的連結。
 *   - 新成員：只有 canLink=true 的呼叫端可以帶 discordId（Bot 從 Discord 的
 *       使用者選單加人，身分本身就是 Discord 驗證過的）；其他人一律視為未連結。
 *   - 相容：Bot 送來的「新」成員若 id 本身是 Discord ID 又沒帶 discordId（舊版
 *       Mousebot），視為 discordId＝id
 *   - 同一個 Discord 帳號在一個行程裡只能連結一位成員；衝突時以伺服器上已
 *       存在的連結為準，後來者視為未連結（由 storage.repairMembers 收尾）。
 *
 * 網頁要連結成員只能走受控流程：本人透過邀請連結認領（routes/members.js）。
 */
const { isSnowflake } = require('./snowflake');

/**
 * 🔒 [移除已連結成員] 已連結 Discord 的成員代表一個人的存取權，整包 PUT 漏掉他就等於
 * 把他踢出行程。canRemoveLinked(member) 決定這次寫入能不能移除這位已連結的成員；
 * 不能移除時，他會被原樣補回名單最後面（帳目、連結都不變）。
 * 規則（由呼叫端決定）：建立者／管理端可以移除任何人；成員只能移除自己；訪客一律不能。
 * @param {{ canLink: boolean, canRemoveLinked?: (member: object) => boolean }} opts
 */
function mergeIncomingMembers(existingMembers, incomingMembers, { canLink, canRemoveLinked = () => true }) {
  const byId = new Map((existingMembers || []).map((m) => [m.id, m]));
  const linkedOnServer = new Set((existingMembers || []).filter((m) => m.discordId).map((m) => m.discordId));
  const list = Array.isArray(incomingMembers) ? incomingMembers : [];

  // 新連結一律不能撞到伺服器上既有的連結（見下方 linkedOnServer 檢查），所以
  // 之後 repairMembers 依順序去重時，既有連結永遠不會被新來的擠掉。
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const prev = byId.get(m.id);
    const next = { id: m.id, name: m.name };
    // 舊版 Mousebot（升級過渡期）加人時只送 { id: <Discord ID>, name }，沒有 discordId；
    // 只對 Bot 這種 canLink 呼叫端、而且只對「新加入」的成員，把 snowflake 格式的 id
    // 視為它的 discordId。已存在的成員不套用——否則被建立者解除連結的舊成員
    // （id 剛好是 Discord ID），會在下一次 Bot 存檔時被悄悄重新連結回去。
    const requested = typeof m.discordId === 'string' ? m.discordId
      : (canLink && !prev && isSnowflake(String(m.id || '')) ? m.id : null);
    if (prev && prev.discordId) {
      next.discordId = prev.discordId;
    } else if (canLink && requested && !linkedOnServer.has(requested)) {
      next.discordId = requested;
    }
    out.push(next);
  }

  const kept = new Set(out.map((m) => m.id));
  for (const m of existingMembers || []) {
    if (m.discordId && !kept.has(m.id) && !canRemoveLinked(m)) {
      out.push({ id: m.id, name: m.name, discordId: m.discordId });
    }
  }
  return out;
}

/** 找出連結到指定 Discord 帳號的成員。 */
function findMemberByDiscordId(trip, discordId) {
  if (!trip || !discordId) return null;
  return (trip.members || []).find((m) => m.discordId === discordId) || null;
}

module.exports = { mergeIncomingMembers, findMemberByDiscordId };
