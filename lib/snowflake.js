'use strict';
// Discord 的 snowflake ID：17–20 位數字。只有符合這個格式的字串才會被當成
// 「已連結的 Discord 帳號」「真實的 Discord 伺服器」或 Bot 宣告的操作者。
const SNOWFLAKE_RE = /^\d{17,20}$/;

function isSnowflake(v) {
  return typeof v === 'string' && SNOWFLAKE_RE.test(v);
}

module.exports = { SNOWFLAKE_RE, isSnowflake };
