'use strict';
const express = require('express');
const crypto = require('crypto');
const session = require('../lib/session');

// 🆕 [Discord 登入] OAuth2 授權碼流程（scope 只要 identify：只拿 Discord 使用者 ID、
// 名稱、頭像，不讀伺服器清單、不讀 email）。登入只證明身分，不授予任何權限。
//
// 環境變數：
//   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET   Discord Developer Portal → OAuth2
//   PUBLIC_BASE_URL     網頁對外網址（例如 https://splitbill.zeabur.app），用來組 redirect_uri；
//                       Discord 後台的 Redirects 要填 <PUBLIC_BASE_URL>/auth/discord/callback
//   SESSION_SECRET      至少 32 字元的隨機字串，用來簽 cookie
//   DISCORD_API_BASE / DISCORD_AUTHORIZE_URL    （測試用）覆寫 Discord 端點

const API_BASE = (process.env.DISCORD_API_BASE || 'https://discord.com/api').replace(/\/+$/, '');
const AUTHORIZE_URL = process.env.DISCORD_AUTHORIZE_URL || 'https://discord.com/oauth2/authorize';

function config() {
  const clientId = process.env.DISCORD_CLIENT_ID || '';
  const clientSecret = process.env.DISCORD_CLIENT_SECRET || '';
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!clientId || !clientSecret || !base || !session.isEnabled()) return null;
  return { clientId, clientSecret, redirectUri: `${base}/auth/discord/callback` };
}

/** 只允許站內相對路徑，避免被拿來當開放式重新導向。 */
function safeNext(v) {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return '/';
  return v.slice(0, 500);
}

function avatarUrl(user) {
  return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;
}

module.exports = function createOAuthRouter() {
  const router = express.Router();

  router.get('/discord/login', (req, res) => {
    const cfg = config();
    if (!cfg) return res.status(503).send('Discord 登入尚未設定（需要 DISCORD_CLIENT_ID、DISCORD_CLIENT_SECRET、PUBLIC_BASE_URL、SESSION_SECRET）');
    const state = crypto.randomBytes(16).toString('hex');
    session.writeOAuthState(res, state, safeNext(req.query.next));
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'none');
    res.redirect(302, url.toString());
  });

  router.get('/discord/callback', async (req, res) => {
    const cfg = config();
    if (!cfg) return res.status(503).send('Discord 登入尚未設定');
    const saved = session.readOAuthState(req);
    session.clearOAuthState(res);
    const { code, state, error } = req.query;
    if (error) return res.redirect(302, '/?login=cancelled');
    if (!saved || typeof state !== 'string' || state !== saved.state || typeof code !== 'string') {
      return res.status(400).send('登入流程已過期或無效，請回到網頁重新登入一次。');
    }
    try {
      const tokenRes = await fetch(`${API_BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: cfg.redirectUri,
        }),
      });
      const tok = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tok.access_token) throw new Error(tok.error_description || tok.error || `token HTTP ${tokenRes.status}`);

      const meRes = await fetch(`${API_BASE}/users/@me`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const me = await meRes.json().catch(() => ({}));
      if (!meRes.ok || !/^\d{17,20}$/.test(String(me.id || ''))) throw new Error(`users/@me HTTP ${meRes.status}`);

      session.writeSession(res, { id: String(me.id), name: me.global_name || me.username || '', avatar: avatarUrl(me) });
      res.redirect(302, safeNext(saved.next));
    } catch (err) {
      console.error('[splitbill-oauth] Discord 登入失敗：', err.message);
      res.status(502).send('Discord 登入失敗，請稍後再試一次。');
    }
  });

  // POST 才能登出（避免被 <img src="/auth/logout"> 之類的跨站請求登出）；
  // 一樣要求 x-requested-with，理由同 lib/auth.js 的 CSRF 說明。
  router.post('/logout', (req, res) => {
    if (req.get('x-requested-with') !== 'splitbill') return res.status(403).json({ error: '缺少 CSRF 標頭' });
    session.clearSession(res);
    res.json({ ok: true });
  });

  return router;
};
