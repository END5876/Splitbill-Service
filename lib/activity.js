'use strict';
/**
 * 操作紀錄：每次行程內容版本（updatedAt）變動時，比較寫入前後的行程，記下「誰、改了什麼」。
 * -----------------------------------------------------------------
 * 由 storage.persist() 在寫入資料庫的同一個交易裡產生（見 storage.js 的 persistChanges），
 * 所以任何寫入管道（網頁單筆、整包 PUT、Bot、認領連結…）都會留下紀錄，路由不用各自處理。
 *
 * 一筆紀錄：
 *   { updatedAt, at, actor: { kind, name, userId? }, reason?, changes: [...] }
 * 支出／轉帳的變動會帶完整的 before／after，讓網頁可以「還原刪掉的這筆」或
 * 「復原這次修改」——不受 trip_revisions 只保留最近 N 份快照的限制。
 */

// 單筆紀錄最多列幾項變動（匯入、整份還原這類大量變動），超過的只記數量
const MAX_CHANGES = 40;

const EXPENSE_FIELDS = [
  ['description', '說明'],
  ['amount', '金額'],
  ['currency', '幣別'],
  ['amountInBase', '換算金額'],
  ['createdAt', '日期'],
];
const DEPOSIT_FIELDS = [
  ['payerId', '付款人'],
  ['collectorId', '收款人'],
  ['amount', '金額'],
  ['currency', '幣別'],
  ['amountInBase', '換算金額'],
  ['note', '備註'],
  ['createdAt', '日期'],
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fmtAmount = (n) => (Math.round(n * 100) / 100).toLocaleString('en-US');

function nameLookup(...trips) {
  const names = new Map();
  for (const t of trips) for (const m of (t && t.members) || []) if (!names.has(m.id)) names.set(m.id, m.name);
  return (id) => names.get(id) || '（已刪除成員）';
}

function expenseLabel(e) {
  return `${e.description} ${fmtAmount(e.amount)} ${e.currency}`;
}
function depositLabel(d, name) {
  return `${name(d.payerId)} → ${name(d.collectorId)} ${fmtAmount(d.amount)} ${d.currency}${d.note ? `（${d.note}）` : ''}`;
}

/** 欄位層級的差異；成員 id 會換成名字，代墊／分攤只標示「有變動」。 */
function fieldChanges(before, after, fields, name) {
  const out = [];
  for (const [key, label] of fields) {
    if (same(before[key], after[key])) continue;
    const isMember = key === 'payerId' || key === 'collectorId';
    out.push({ field: key, label, from: isMember ? name(before[key]) : before[key], to: isMember ? name(after[key]) : after[key] });
  }
  if (before.payers && !same(before.payers, after.payers)) out.push({ field: 'payers', label: '代墊付款人' });
  if (before.participants && !same(before.participants, after.participants)) out.push({ field: 'participants', label: '分攤方式' });
  return out;
}

function diffEntries(kind, prevList, nextList, labelOf, fields, name, push) {
  const prev = new Map((prevList || []).map((x) => [x.id, x]));
  const next = new Map((nextList || []).map((x) => [x.id, x]));
  for (const [id, after] of next) {
    const before = prev.get(id);
    if (!before) push({ type: `${kind}.add`, id, label: labelOf(after), after });
    else if (!same(before, after)) {
      push({ type: `${kind}.edit`, id, label: labelOf(after), before, after, fields: fieldChanges(before, after, fields, name) });
    }
  }
  for (const [id, before] of prev) {
    if (!next.has(id)) push({ type: `${kind}.remove`, id, label: labelOf(before), before });
  }
}

/**
 * 比較兩個版本的行程，回傳變動清單。prev 為 null 代表新建立的行程。
 * @returns {object[]}
 */
function diffTrips(prev, next) {
  const changes = [];
  let overflow = 0;
  const push = (c) => { if (changes.length < MAX_CHANGES) changes.push(c); else overflow++; };

  if (!prev) {
    return [{
      type: 'trip.create', label: next.name,
      counts: { members: next.members.length, expenses: next.expenses.length, deposits: next.deposits.length },
    }];
  }
  const name = nameLookup(next, prev);

  if (prev.name !== next.name) push({ type: 'trip.rename', from: prev.name, to: next.name });
  if (prev.baseCurrency !== next.baseCurrency) push({ type: 'trip.baseCurrency', from: prev.baseCurrency, to: next.baseCurrency });
  if (!!prev.archived !== !!next.archived) push({ type: 'trip.archive', to: !!next.archived });
  if ((prev.guildId || null) !== (next.guildId || null)) push({ type: next.guildId ? 'trip.bind' : 'trip.unbind' });

  const prevRates = prev.rates || {};
  const nextRates = next.rates || {};
  for (const code of new Set([...Object.keys(prevRates), ...Object.keys(nextRates)])) {
    if (code === next.baseCurrency && code === prev.baseCurrency) continue;
    const a = prevRates[code];
    const b = nextRates[code];
    if (a === b) continue;
    if (a === undefined) push({ type: 'rate.add', code, to: b });
    else if (b === undefined) push({ type: 'rate.remove', code, from: a });
    else push({ type: 'rate.change', code, from: a, to: b });
  }

  const prevMembers = new Map(prev.members.map((m) => [m.id, m]));
  const nextMembers = new Map(next.members.map((m) => [m.id, m]));
  for (const [id, m] of nextMembers) {
    const before = prevMembers.get(id);
    if (!before) { push({ type: 'member.add', id, label: m.name }); continue; }
    if (before.name !== m.name) push({ type: 'member.rename', id, from: before.name, to: m.name });
    if (!before.discordId && m.discordId) push({ type: 'member.link', id, label: m.name });
    if (before.discordId && !m.discordId) push({ type: 'member.unlink', id, label: m.name });
  }
  for (const [id, m] of prevMembers) if (!nextMembers.has(id)) push({ type: 'member.remove', id, label: m.name });

  diffEntries('expense', prev.expenses, next.expenses, expenseLabel, EXPENSE_FIELDS, name, push);
  diffEntries('deposit', prev.deposits, next.deposits, (d) => depositLabel(d, name), DEPOSIT_FIELDS, name, push);

  if (overflow) changes.push({ type: 'more', count: overflow });
  return changes;
}

/**
 * 把路由交給 touchTrip() 的操作者描述成要存下來的樣子。名字在寫入當下決定
 * （之後成員改名，舊紀錄仍顯示當時的名字）：已連結的成員用行程裡的名字，
 * 否則用 Discord 登入名稱。
 * @param {{ kind: 'user'|'bot'|'guest'|'admin', userId?: string, name?: string, linkLabel?: string }|null} actor
 */
function resolveActor(actor, trip) {
  if (!actor) return { kind: 'system', name: '系統' };
  if (actor.kind === 'guest') {
    return { kind: 'guest', name: actor.linkLabel ? `訪客（${actor.linkLabel}）` : '分享連結訪客' };
  }
  if (actor.kind === 'admin') return { kind: 'admin', name: '管理端' };
  const member = actor.userId ? (trip.members || []).find((m) => m.discordId === actor.userId) : null;
  const name = (member && member.name) || actor.name || 'Discord 使用者';
  return { kind: actor.kind === 'bot' ? 'bot' : 'user', name, userId: actor.userId || null };
}

module.exports = { diffTrips, resolveActor, MAX_CHANGES };
