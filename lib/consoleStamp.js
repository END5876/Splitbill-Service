'use strict';
/**
 * 在所有 console 輸出前加上「2026-11-20 14:03:05」格式的時間（和 Mousebot／music-library 同格式）。
 * Dockge／docker logs 本身不顯示時間，沒有這個就看不出錯誤是什麼時候發生的。
 *
 * 時區用 TZ，沒設定就用 Asia/Taipei；LOG_TIMESTAMPS=0 可關閉（部署平台已經會加時間時）。
 */

function makeStampFormat(tz) {
  /** @type {Intl.DateTimeFormatOptions} */
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz || 'Asia/Taipei' });
  } catch {
    return new Intl.DateTimeFormat('en-US', opts); // TZ 寫錯就退回系統時區
  }
}

/** 「YYYY-MM-DD HH:mm:ss」 */
function formatStamp(date = new Date(), fmt = makeStampFormat(process.env.TZ)) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

let installed = false;
function installConsoleTimestamps(env = process.env) {
  if (installed || env.LOG_TIMESTAMPS === '0') return;
  installed = true;
  const fmt = makeStampFormat(env.TZ);
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(formatStamp(new Date(), fmt), ...args);
  }
}

module.exports = { installConsoleTimestamps, formatStamp };
