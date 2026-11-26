// /api/login - validates email + password, sets a signed, dated session cookie
//
// Passwords, in order:
//   1. A personal password, if DASHBOARD_USER_PASSWORDS has an entry for the
//      email. That env var is JSON: { "<email>": "scrypt$<salt>$<hash>", ... }.
//      Make an entry with:  node scripts/hash-password.mjs
//   2. Otherwise the shared DASHBOARD_PASSWORD, while that env var still exists.
// Someone with a personal password can no longer use the shared one. Once
// everyone has a personal entry, delete DASHBOARD_PASSWORD to switch it off.
import { scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { USERS, makeAuthCookie, SESSION_MAX_AGE } from '../lib/auth.js';

function personalPasswords() {
  try {
    const parsed = JSON.parse(process.env.DASHBOARD_USER_PASSWORDS || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    console.error('[login] DASHBOARD_USER_PASSWORDS is not valid JSON; personal passwords are ignored');
    return {};
  }
}

function matchesHash(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  if (!want.length) return false;
  const got = scryptSync(password, Buffer.from(saltHex, 'hex'), want.length);
  return timingSafeEqual(got, want);
}

const sha = s => createHash('sha256').update(String(s)).digest();
const sameString = (a, b) => timingSafeEqual(sha(a), sha(b));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const token = process.env.DASHBOARD_TOKEN;
  const sharedPassword = process.env.DASHBOARD_PASSWORD;
  const personal = personalPasswords();
  if (!token || (!sharedPassword && !Object.keys(personal).length)) {
    res.status(500).json({ error: 'Auth not configured on server' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const email = String((body && body.email) || '').trim().toLowerCase();
  const password = body && typeof body.password === 'string' ? body.password : '';

  let ok = false;
  if (USERS[email] && password) {
    const own = Object.prototype.hasOwnProperty.call(personal, email) ? personal[email] : null;
    if (own) ok = matchesHash(password, own);
    else if (sharedPassword) ok = sameString(password, sharedPassword);
  }
  // One answer for a wrong email and a wrong password, so the form cannot be
  // used to find out which addresses have access.
  if (!ok) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const cookie = await makeAuthCookie(email, token);
  res.setHeader('Set-Cookie', [
    `auth=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`
  ]);
  res.status(200).json({ ok: true });
}
