// /api/starbridge-buyer-summary?buyerId=X — buyer summary + recent signals in one call

import { verifyAuthCookie } from '../lib/auth.js';
import { getBuyerSummary, listRecentBuyerSignals } from '../lib/starbridge.js';

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return res.status(500).json({ error: 'DASHBOARD_TOKEN not set' });

  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const buyerId = url.searchParams.get('buyerId');
  if (!buyerId) return res.status(400).json({ error: 'buyerId required' });

  const [summaryRes, signalsRes] = await Promise.allSettled([
    getBuyerSummary(buyerId),
    listRecentBuyerSignals(buyerId, { pageSize: 20 })
  ]);

  let summary = null;
  let summary_error = null;
  if (summaryRes.status === 'fulfilled') {
    summary = summaryRes.value;
  } else {
    const err = summaryRes.reason;
    if (err.status === 404) summary_error = 'no_summary_yet';
    else summary_error = err.message;
  }

  let signals = [];
  let signals_error = null;
  if (signalsRes.status === 'fulfilled') {
    signals = signalsRes.value;
  } else {
    signals_error = signalsRes.reason.message;
  }

  return res.status(200).json({ buyerId, summary, summary_error, signals, signals_error });
}
