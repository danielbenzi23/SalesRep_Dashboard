// /api/starbridge — combined signals + buyer-search + buyer-summary (was 3 functions)
// GET /api/starbridge?action=signals  → top recent signals across org
// GET /api/starbridge?action=search&q=X → search buyers by name
// GET /api/starbridge?action=summary&buyerId=X → buyer AI summary + recent signals

import { verifyAuthCookie } from '../lib/auth.js';
import {
  listTopRecentSignals,
  searchBuyers,
  getBuyerSummary,
  listRecentBuyerSignals,
  getBuyerAttributes
} from '../lib/starbridge.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return res.status(500).json({ error: 'DASHBOARD_TOKEN not set' });
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const action = url.searchParams.get('action') || 'signals';

  try {
    // ===== SEARCH =====
    if (action === 'search') {
      const q = url.searchParams.get('q');
      const state = url.searchParams.get('state') || undefined;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '15', 10), 50);
      if (!q || q.trim().length < 2) {
        return res.status(400).json({ error: 'q (search term) required, min 2 chars' });
      }
      const data = await searchBuyers(q.trim(), { stateCode: state, limit });
      return res.status(200).json(data);
    }

    // ===== BUYER SUMMARY =====
    if (action === 'summary') {
      const buyerId = url.searchParams.get('buyerId');
      if (!buyerId) return res.status(400).json({ error: 'buyerId required' });

      // Always fetch attributes in parallel — they work for any buyer
      const [summaryRes, signalsRes, attributesRes] = await Promise.allSettled([
        getBuyerSummary(buyerId),
        listRecentBuyerSignals(buyerId, { pageSize: 20 }),
        getBuyerAttributes(buyerId)
      ]);

      let summary = null, summary_error = null;
      if (summaryRes.status === 'fulfilled') summary = summaryRes.value;
      else {
        const err = summaryRes.reason;
        if (err.status === 404) summary_error = 'no_summary_yet';
        else summary_error = err.message;
      }
      let signals = [], signals_error = null;
      if (signalsRes.status === 'fulfilled') signals = signalsRes.value;
      else signals_error = signalsRes.reason.message;

      const attributes = attributesRes.status === 'fulfilled' ? attributesRes.value : {};

      return res.status(200).json({ buyerId, summary, summary_error, signals, signals_error, attributes });
    }

    // ===== SIGNALS LIST (default) =====
    const sort = url.searchParams.get('sort') || 'Hotness';
    const period = url.searchParams.get('period') || 'LastThirtyDays';
    const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') || '50', 10), 100);
    const filterTypeRaw = url.searchParams.get('filterType');
    const filterType = filterTypeRaw ? filterTypeRaw.split(',').filter(Boolean) : undefined;
    const statusRaw = url.searchParams.get('status');
    const status = statusRaw ? statusRaw.split(',').filter(Boolean) : undefined;

    const data = await listTopRecentSignals({
      pageSize, sort, filterType, status, relativeDatePeriodFrom: period
    });
    return res.status(200).json(data);

  } catch (e) {
    if (e.status === 401) return res.status(502).json({ error: 'starbridge_unauthorized', detail: 'Check STARBRIDGE_API_KEY' });
    return res.status(502).json({ error: 'starbridge_failed', detail: e.message });
  }
}
