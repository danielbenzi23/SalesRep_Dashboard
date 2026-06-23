// /api/me - returns the current user's info + allowed tabs
import { verifyAuthCookie } from '../lib/auth.js';

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'DASHBOARD_TOKEN not set' });
    return;
  }
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = match ? await verifyAuthCookie(match[1], token) : null;
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  res.status(200).json(user);
}
