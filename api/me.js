// /api/me - returns the current user's info + allowed tabs
import { verifyAuthCookie, EMAIL_TO_OWNER_ID, OWNER_ID_TO_NAME } from '../lib/auth.js';

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
  const owner_id = EMAIL_TO_OWNER_ID[user.email] || null;
  const reps = (user.role === 'admin' || user.role === 'manager')
    ? Object.entries(OWNER_ID_TO_NAME).map(([ownerId, name]) => ({ ownerId, name }))
    : null;
  res.status(200).json({ ...user, owner_id, reps });
}
