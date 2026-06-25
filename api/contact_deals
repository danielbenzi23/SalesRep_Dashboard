// /api/contact-deals?contact_id=X — returns deals associated with a contact

import { verifyAuthCookie, OWNER_ID_TO_NAME } from '../lib/auth.js';

const STAGE_NAMES = {
  '56188255': 'Qualify',
  '56188256': 'Discovery',
  '56188257': 'Quote',
  '1301242997': 'Driving to Close',
  '85090957': 'Contract',
  '56188260': 'Closed won',
  '70398793': 'Go to Green House',
  '56188261': 'Closed lost'
};

const STAGE_PROBABILITY = {
  '56188255': 0.05, '56188256': 0.25, '56188257': 0.50,
  '1301242997': 0.20, '85090957': 0.90, '56188260': 1.00, '70398793': 0.01, '56188261': 0.00
};

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  const hsToken = process.env.HUBSPOT_TOKEN;
  if (!token || !hsToken) return res.status(500).json({ error: 'tokens missing' });

  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const contactId = url.searchParams.get('contact_id');
  if (!contactId) return res.status(400).json({ error: 'contact_id required' });

  // 1) Get associated deal IDs
  let dealIds = [];
  try {
    const r = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/deals`,
      { headers: { Authorization: `Bearer ${hsToken}` } }
    );
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'hubspot_assoc_failed', detail: t.slice(0, 200) });
    }
    const data = await r.json();
    dealIds = (data.results || []).map(a => a.id || a.toObjectId).filter(Boolean);
  } catch (e) {
    return res.status(502).json({ error: 'hubspot_assoc_failed', detail: e.message });
  }

  if (!dealIds.length) {
    return res.status(200).json({ count: 0, deals: [] });
  }

  // 2) Batch read deal properties
  let dealsResult;
  try {
    const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals/batch/read', {
      method: 'POST',
      headers: { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate',
                     'createdate', 'hs_lastmodifieddate', 'hubspot_owner_id',
                     'notes_last_contacted', 'closed_lost_reason'],
        inputs: dealIds.slice(0, 100).map(id => ({ id: String(id) }))
      })
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: 'hubspot_deals_failed', detail: t.slice(0, 200) });
    }
    dealsResult = await r.json();
  } catch (e) {
    return res.status(502).json({ error: 'hubspot_deals_failed', detail: e.message });
  }

  const deals = (dealsResult.results || []).map(d => {
    const p = d.properties || {};
    const stageId = p.dealstage;
    return {
      id: d.id,
      dealname: p.dealname || '(no name)',
      amount: parseFloat(p.amount) || 0,
      stage: STAGE_NAMES[stageId] || stageId || '—',
      stage_id: stageId,
      probability: STAGE_PROBABILITY[stageId] ?? null,
      is_won: stageId === '56188260',
      is_lost: stageId === '56188261',
      is_open: stageId && stageId !== '56188260' && stageId !== '56188261',
      pipeline: p.pipeline || null,
      close_date: p.closedate || null,
      create_date: p.createdate || null,
      last_activity: p.notes_last_contacted || p.hs_lastmodifieddate || null,
      owner: OWNER_ID_TO_NAME[p.hubspot_owner_id] || null,
      lost_reason: p.closed_lost_reason || null,
      hubspot_url: `https://app.hubspot.com/contacts/0/record/0-3/${d.id}`
    };
  })
  // Sort: open first (largest first), then won, then lost
  .sort((a, b) => {
    const order = (d) => d.is_open ? 0 : (d.is_won ? 1 : 2);
    const oa = order(a), ob = order(b);
    if (oa !== ob) return oa - ob;
    return b.amount - a.amount;
  });

  return res.status(200).json({ count: deals.length, deals });
}
