'use strict';

// Signed login cookie for the dashboard. Stateless (HMAC), so it works on
// Vercel where nothing persists between requests: "user.expiry.signature".

const crypto = require('node:crypto');

const COOKIE = 'sg_session';
const MAX_AGE_S = 7 * 24 * 3600;

const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

function createSession(secret, user, now = Date.now()) {
  const payload = `${Buffer.from(user).toString('base64url')}.${Math.floor(now / 1000) + MAX_AGE_S}`;
  return `${payload}.${sign(secret, payload)}`;
}

// Returns the username, or null when the cookie is missing, forged or expired.
function readSession(secret, cookieHeader, now = Date.now()) {
  const m = String(cookieHeader || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const want = Buffer.from(sign(secret, payload));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  if (Number(parts[1]) * 1000 < now) return null;
  return Buffer.from(parts[0], 'base64url').toString('utf8');
}

function cookieHeader(value, { secure, maxAge = MAX_AGE_S }) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

module.exports = { createSession, readSession, cookieHeader };
