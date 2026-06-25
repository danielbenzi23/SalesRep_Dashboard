// /api/starbridge-signals — list top recent signals across org from Starbridge

import { verifyAuthCookie } from '../lib/auth.js';
import { listTopRecentSignals } from '../lib/starbridge.js';

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return res.status(500).json({ error: 'DASHBOARD_TOKEN not set' });

  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const sort = url.searchParams.get('sort') || 'Hotness';        // Hotness | Date
  const period = url.searchParams.get('period') || 'LastThirtyDays';
  const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') || '50', 10), 100);
  const filterTypeRaw = url.searchParams.get('filterType');      // comma-separated
  const filterType = filterTypeRaw ? filterTypeRaw.split(',').filter(Boolean) : undefined;
  const statusRaw = url.searchParams.get('status');
  const status = statusRaw ? statusRaw.split(',').filter(Boolean) : undefined;

  try {
    const data = await listTopRecentSignals({
      pageSize, sort, filterType, status, relativeDatePeriodFrom: period
    });
    return res.status(200).json(data);
  } catch (e) {
    if (e.status === 401) return res.status(502).json({ error: 'starbridge_unauthorized', detail: 'Check STARBRIDGE_API_KEY' });
    return res.status(502).json({ error: 'starbridge_failed', detail: e.message });
  }
}
