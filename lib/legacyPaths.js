'use strict';
/**
 * 🆕 [行程獨立化] 舊網址相容層：/api/trip/:guildId/:tripId[/...] → /api/trip/:tripId[/...]
 *
 * 行程改成以 tripId 為主鍵之後，正式路由只剩 /api/trip/:tripId。這裡讓還沒
 * 更新的呼叫端（舊版 Mousebot、舊版網頁、已經存在的書籤）在升級過渡期間
 * 繼續可用，等兩邊都換成新網址後即可整個移除。
 *
 * 判斷規則：/trip/ 後面第二段不是新路由的保留字（events、share-links…），
 * 就視為舊格式的 tripId。舊網址裡的 guildId 仍然要對得上，避免拿 A 伺服器的
 * 身分操作 B 伺服器的行程：
 *   - guildId 是 snowflake → 行程必須綁在這個伺服器
 *   - 其他字串（例如早期網頁自用的 "local"、測試用的 "g"）→ 行程必須是未綁定
 * 行程不存在時（PUT 建立新行程）照樣改寫，並把舊網址的 guildId 記在
 * req.legacyGuildId，讓建立分支知道要綁到哪個伺服器。
 */
const RESERVED_SECOND_SEGMENTS = new Set([
  'events', 'share-links', 'receipt-session', 'invite', 'members', 'bind-code', 'detach',
]);

function createLegacyTripPathRewrite(storage) {
  return function legacyTripPathRewrite(req, res, next) {
    const m = /^\/trip\/([^/]+)\/([^/]+)(\/.*)?$/.exec(req.path);
    if (!m) return next();
    const [, rawGuild, rawTrip, rest] = m;
    if (RESERVED_SECOND_SEGMENTS.has(rawTrip)) return next();

    let guildSeg, tripId;
    try {
      guildSeg = decodeURIComponent(rawGuild);
      tripId = decodeURIComponent(rawTrip);
    } catch (_) {
      return res.status(400).json({ error: '網址格式錯誤' });
    }

    const trip = storage.getTrip(tripId);
    const expectedGuild = storage.isSnowflake(guildSeg) ? guildSeg : null;
    if (trip && trip.guildId !== expectedGuild) {
      return res.status(404).json({ error: '找不到這個行程' });
    }

    req.legacyGuildId = expectedGuild;
    const query = req.url.slice(req.path.length); // 保留 ?ticket=... 等查詢字串
    req.url = `/trip/${encodeURIComponent(tripId)}${rest || ''}${query}`;
    next();
  };
}

module.exports = { createLegacyTripPathRewrite, RESERVED_SECOND_SEGMENTS };
