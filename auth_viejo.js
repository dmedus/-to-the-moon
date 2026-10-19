// Autenticación de "Mis Carteras": usuario dueño (contraseña + código 2FA) y usuario invitado (solo lectura).
// Sin dependencias: scrypt para contraseñas, TOTP (RFC 6238) para el 2FA, sesiones en memoria.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_PATH = path.join(__dirname, 'data', 'auth.json');
const COOKIE = 'mc_session';
const GUEST_USER = 'invitado';
const LIMITS = {
  owner: { idleMs: 60 * 60e3, maxMs: 12 * 3600e3 },
  guest: { idleMs: 60 * 60e3, maxMs: 4 * 3600e3 },
};
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60e3;

// ---------- Persistencia ----------
function load() {
  try { return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); } catch { return {}; }
}
function save(a) {
  const tmp = AUTH_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(a, null, 2));
  fs.renameSync(tmp, AUTH_PATH);
}

// ---------- Contraseñas ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  return { salt, hash };
}
function checkPassword(pw, rec) {
  if (!rec?.salt || !rec?.hash) return false;
  const h = crypto.scryptSync(String(pw), rec.salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(h, Buffer.from(rec.hash, 'hex'));
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'La contraseña tiene que tener al menos 10 caracteres.';
  if (pw.length > 200) return 'Contraseña demasiado larga.';
  return null;
}

// ---------- TOTP (Google Authenticator y similares) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
// Devuelve el contador usado si el código es válido (±30 s de tolerancia) y no fue usado antes.
function verifyTotp(secret, code, lastCounter = -1) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const c of [now - 1, now, now + 1]) {
    if (c <= lastCounter) continue;
    const exp = totpAt(secret, c);
    if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(String(code)))) return c;
  }
  return null;
}

// ---------- Sesiones ----------
const sessions = new Map(); // token -> { role, created, last, scale }
function newSession(role) {
  const token = crypto.randomBytes(32).toString('base64url');
  // El invitado ve todo multiplicado por un factor secreto: los % son reales, los montos no.
  // Siempre lejos de 1 (entre 0,3 y 0,7 o entre 1,5 y 3,5) para que ni los datos crudos se parezcan a los reales.
  const u = crypto.randomInt(0, 1_000_000) / 1_000_000;
  const scale = role === 'guest' ? (crypto.randomInt(0, 2) ? 0.3 + u * 0.4 : 1.5 + u * 2) : 1;
  sessions.set(token, { role, created: Date.now(), last: Date.now(), scale });
  return token;
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getSession(req) {
  const token = parseCookies(req)[COOKIE];
  const s = token && sessions.get(token);
  if (!s) return null;
  const lim = LIMITS[s.role];
  const now = Date.now();
  if (now - s.last > lim.idleMs || now - s.created > lim.maxMs) { sessions.delete(token); return null; }
  if (s.role === 'guest' && !load().guest?.enabled) { sessions.delete(token); return null; }
  s.last = now;
  return { ...s, token };
}
function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || /\.ts\.net(:\d+)?$/i.test(String(req.headers.host || ''));
}
function sessionCookie(req, token, maxAgeSec) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}
function clearCookie(req) {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
}
function dropSessions(filter = () => true) {
  for (const [t, s] of sessions) if (filter(s)) sessions.delete(t);
}

// ---------- Límite de intentos ----------
const fails = new Map(); // clave -> { count, until }
function clientKey(req) {
  // Detrás de Tailscale la conexión llega desde localhost: la IP real viene en X-Forwarded-For.
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function lockedFor(key) {
  const f = fails.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
}
function registerFail(key) {
  const f = fails.get(key) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  fails.set(key, f);
}

// La configuración inicial solo se permite desde la propia PC (no a través de Tailscale).
function isLocal(req) {
  const ra = req.socket.remoteAddress || '';
  const host = String(req.headers.host || '').toLowerCase();
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra) && !req.headers['x-forwarded-for'] &&
    !req.headers['tailscale-funnel-request'] && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

module.exports = {
  GUEST_USER, LIMITS, MAX_FAILS,
  load, save, hashPassword, checkPassword, passwordProblem,
  base32, verifyTotp, totpAt,
  newSession, getSession, sessionCookie, clearCookie, dropSessions,
  clientKey, lockedFor, registerFail, fails, isLocal,
};
