'use strict';
/**
 * 取得「真正的使用者 IP」，給 Discord 登入的失敗限流使用（routes/oauth.js）。
 * 與 music-library-service 的 webplayer/clientIp.js 相同。
 *
 * 正式環境的連線路徑：瀏覽器 → Cloudflare → Caddy（Docker 私有網路）→ Node
 *   X-Forwarded-For: <使用者>, <Cloudflare 節點>     ← Caddy 在最右邊追加它看到的來源
 *   CF-Connecting-IP: <使用者>
 *
 * server.js 的 trust proxy 只信任本機／私有網段（Caddy），所以 req.ip 是「Caddy 看到的上一層」：
 *   - 上一層是 Cloudflare 節點 → 改用 CF-Connecting-IP（Cloudflare 自己設定，使用者無法偽造）
 *   - 上一層不是 Cloudflare（有人繞過 Cloudflare 直接連進來）→ 直接用 req.ip；
 *     這時 CF-Connecting-IP / X-Forwarded-For 都可能是偽造的，一律不採信
 *
 * 為什麼不直接把 Cloudflare 加進 trust proxy、改用 X-Forwarded-For 往前一格：
 *   任何人都能用 Cloudflare Workers 從 Cloudflare 的 IP 發請求並自填 X-Forwarded-For；
 *   CF-Connecting-IP 則由 Cloudflare 覆寫，偽造不了。
 */
const net = require('net');

// 來源：https://www.cloudflare.com/ips-v4 、https://www.cloudflare.com/ips-v6（2026-10-26 取得）
// 若 Cloudflare 有新增，漏掉的節點只會退回以節點 IP 計算限流，不會造成安全問題。
const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
];

const cloudflare = new net.BlockList();
for (const c of CLOUDFLARE_IPV4) { const [a, p] = c.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv4'); }
for (const c of CLOUDFLARE_IPV6) { const [a, p] = c.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv6'); }

// '::ffff:1.2.3.4'（IPv4-mapped IPv6）→ '1.2.3.4'；不是合法 IP 時回傳 null
function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

function isCloudflareIp(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return false;
  return cloudflare.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

function clientIp(req) {
  const hop = req.ip;
  if (isCloudflareIp(hop)) {
    const cf = normalizeIp(req.get('cf-connecting-ip'));
    if (cf) return cf;
  }
  return normalizeIp(hop) || hop;
}

// 限流計數用的 key：IPv4 用完整位址；IPv6 用前 64 位元（/64）。
// 一般使用者／一台主機通常就分到一整個 /64，以單一 IPv6 位址計數的話，換位址就能無限重試。
function rateLimitKey(ip) {
  const v = normalizeIp(ip);
  if (!v) return String(ip || '');
  if (!net.isIPv6(v)) return v;
  const addr = v.split('%')[0].toLowerCase();
  const [head, tail] = addr.split('::');
  // 結尾內嵌 IPv4（例如 64:ff9b::1.2.3.4）佔兩組
  const groups = (s) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const h = groups(head);
  const t = addr.includes('::') ? groups(tail) : [];
  const full = addr.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

module.exports = { clientIp, rateLimitKey, isCloudflareIp };
