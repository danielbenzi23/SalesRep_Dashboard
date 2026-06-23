// /api/login - validates email + password, sets signed cookie
import { USERS, signEmail } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const expectedPassword = process.env.DASHBOARD_PASSWORD;
  const token = process.env.DASHBOARD_TOKEN;
  if (!expectedPassword || !token) {
    res.status(500).json({ error: 'Auth not configured on server' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const email = (body && body.email || '').trim().toLowerCase();
  const password = body && body.password;

  if (!USERS[email]) {
    res.status(401).json({ error: 'Email not authorized' });
    return;
  }
  if (password !== expectedPassword) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const sig = await signEmail(email, token);
  res.setHeader('Set-Cookie', [
    `auth=${email}:${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
  ]);
  res.status(200).json({ ok: true });
}
