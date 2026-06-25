// /api/starbridge-buyer-search?q=X — search buyer institutions by name

import { verifyAuthCookie } from '../lib/auth.js';
import { searchBuyers } from '../lib/starbridge.js';

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return res.status(500).json({ error: 'DASHBOARD_TOKEN not set' });

  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const q = url.searchParams.get('q');
  const state = url.searchParams.get('state') || undefined;
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '15', 10), 50);

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'q (search term) required, min 2 chars' });
  }

  try {
    const data = await searchBuyers(q.trim(), { stateCode: state, limit });
    return res.status(200).json(data);
  } catch (e) {
    if (e.status === 401) return res.status(502).json({ error: 'starbridge_unauthorized' });
    return res.status(502).json({ error: 'starbridge_failed', detail: e.message });
  }
}
