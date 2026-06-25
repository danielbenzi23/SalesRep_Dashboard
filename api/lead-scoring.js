// /api/lead-scoring — top N contacts by HubSpot lead score
// Fetches the score history from HubSpot's property-history API (batch read, 1 call for up to 100 ids)
// Computes WoW delta and position change. No DB needed.

import { verifyAuthCookie, OWNER_ID_TO_NAME, EMAIL_TO_OWNER_ID } from '../lib/auth.js';

// Lazy-load blob lib so the endpoint still works if @vercel/blob isn't installed yet.
async function tryLoadSnapshot(beforeISO) {
  try {
    const mod = await import('../lib/blob.js');
    return await mod.getSnapshotBefore(beforeISO);
  } catch (e) {
    console.error('[lead-scoring] blob unavailable:', e.message);
    return null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hsApi(token, method, path, body, attempt = 0) {
  const r = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 429 && attempt < 6) {
    await sleep(Math.min(6000, 600 * Math.pow(1.5, attempt)));
    return hsApi(token, method, path, body, attempt + 1);
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HubSpot ${path} ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}


export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  const hsToken = process.env.HUBSPOT_TOKEN;
  if (!token || !hsToken) return res.status(500).json({ error: 'tokens missing' });

  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 200);
  const compareDays = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10), 1), 90);

  // Resolve owner filter
  // sales role → forced to own ownerId
  // admin/manager → uses ?ownerId param; ?ownerId=all returns global top
  let ownerFilterId = null;
  if (user.role === 'sales') {
    ownerFilterId = EMAIL_TO_OWNER_ID[user.email] || null;
  } else {
    const requested = url.searchParams.get('ownerId');
    if (requested && requested !== 'all') {
      ownerFilterId = OWNER_ID_TO_NAME[requested] ? requested : null;
    }
  }

  // Which score property? DegreeSight uses a custom property "all_engagement_lead_score"
  // (HubSpot's new Lead Scoring app, "All Engagement Lead Score").
  // Allow override via ?property=X or env HUBSPOT_LEAD_SCORE_PROPERTY.
  // Other options if needed:
  //   - hs_predictivecontactscore_v2 (HubSpot AI "Likelihood to close")
  //   - hubspotscore                 (legacy manual scoring)
  const SCORE_PROP = url.searchParams.get('property')
    || process.env.HUBSPOT_LEAD_SCORE_PROPERTY
    || 'all_engagement_lead_score';

  // Thresholds for tier classification (matches HubSpot Lead Scoring app's "Low/Medium/High")
  function tierFromScore(s) {
    if (s == null) return null;
    if (s <= 0)    return 'low';
    if (s < 300)   return 'low';
    if (s < 600)   return 'medium';
    if (s < 900)   return 'high';
    return 'very_high';
  }

  // 1) Top N contacts by the chosen score property (optionally filtered by owner)
  const searchFilters = [
    { propertyName: SCORE_PROP, operator: 'HAS_PROPERTY' }
  ];
  if (ownerFilterId) {
    searchFilters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerFilterId });
  }
  let searchRes;
  try {
    searchRes = await hsApi(hsToken, 'POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: searchFilters }],
      sorts: [{ propertyName: SCORE_PROP, direction: 'DESCENDING' }],
      properties: [
        'firstname', 'lastname', 'email', 'company', SCORE_PROP,
        'lifecyclestage', 'jobtitle', 'hubspot_owner_id', 'hs_lead_status',
        'lastmodifieddate', 'notes_last_contacted', 'createdate',
        'num_associated_deals'
      ],
      limit
    });
  } catch (e) {
    return res.status(502).json({ error: 'hubspot_search_failed', detail: e.message, score_property: SCORE_PROP });
  }

  const top = searchRes.results || [];

  // 2a) Fetch per-contact property history (works for calculated properties)
  // GET /crm/v3/objects/contacts/{id}?propertiesWithHistory=<score_prop>
  // Parallelized with concurrency limit.
  const compareDate = new Date(Date.now() - compareDays * 86400000);
  const compareMs = compareDate.getTime();

  function scoreAtDate(history, targetMs) {
    if (!Array.isArray(history) || !history.length) return null;
    // History is sorted newest-first by HubSpot
    for (const e of history) {
      const ts = new Date(e.timestamp).getTime();
      if (ts <= targetMs) return parseFloat(e.value) || 0;
    }
    // Target predates known history → contact didn't have the score yet
    return 0;
  }

  async function getContactHistory(id) {
    try {
      const r = await fetch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${id}?propertiesWithHistory=${SCORE_PROP}`,
        { headers: { Authorization: `Bearer ${hsToken}` } }
      );
      if (!r.ok) return [];
      const data = await r.json();
      return data.propertiesWithHistory?.[SCORE_PROP] || [];
    } catch {
      return [];
    }
  }

  // pLimit helper
  async function pLimit(items, concurrency, fn) {
    const results = new Array(items.length);
    let i = 0;
    async function worker() {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx], idx);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
  }

  const historyByContactId = {};
  const histories = await pLimit(top.map(c => c.id), 10, getContactHistory);
  top.forEach((c, idx) => { historyByContactId[c.id] = histories[idx]; });

  // 2b) Also try blob snapshot — used for GLOBAL rank delta only (across all 8k+ contacts)
  let snapshotMap = null;
  let snapshotMeta = null;
  const snap = await tryLoadSnapshot(compareDate.toISOString());
  if (snap && Array.isArray(snap.contacts)) {
    snapshotMap = Object.fromEntries(snap.contacts.map(c => [String(c.id), c]));
    snapshotMeta = { taken_at: snap.taken_at, count: snap.count };
  }

  // 3) Compute deltas using per-contact history (accurate score deltas)
  const scored = top.map((c, idx) => {
    const current = parseFloat(c.properties[SCORE_PROP] || '0') || 0;
    const history = historyByContactId[c.id] || [];
    const past = scoreAtDate(history, compareMs);
    const delta = past != null ? current - past : null;
    return {
      id: c.id,
      rank: idx + 1,
      score: current,
      score_then: past,
      score_delta: delta,
      score_change_pct: (past != null && past > 0) ? delta / past : null,
      firstname: c.properties.firstname || '',
      lastname: c.properties.lastname || '',
      name: ((c.properties.firstname || '') + ' ' + (c.properties.lastname || '')).trim() || '(no name)',
      email: c.properties.email || '',
      company: c.properties.company || '',
      lifecyclestage: c.properties.lifecyclestage || '',
      jobtitle: c.properties.jobtitle || '',
      lead_status: c.properties.hs_lead_status || '',
      tier: tierFromScore(current),
      deal_count: parseInt(c.properties.num_associated_deals || '0', 10),
      owner_id: c.properties.hubspot_owner_id || null,
      owner: OWNER_ID_TO_NAME[c.properties.hubspot_owner_id] || null,
      last_activity: c.properties.notes_last_contacted || c.properties.lastmodifieddate || null,
      created: c.properties.createdate || null,
      hubspot_url: `https://app.hubspot.com/contacts/0/contact/${c.id}`
    };
  });

  // 4) Use the snapshot's recorded GLOBAL rank (if available)
  for (const s of scored) {
    const prev = snapshotMap?.[String(s.id)];
    s.rank_then = prev ? prev.r : null;
    s.rank_delta = (s.rank_then != null) ? (s.rank_then - s.rank) : null;
    // Positive rank_delta = moved up (rank improved)
  }

  return res.status(200).json({
    count: scored.length,
    as_of: new Date().toISOString(),
    compared_to: compareDate.toISOString(),
    compare_days: compareDays,
    snapshot: snapshotMeta,        // { taken_at, count } or null
    score_property: SCORE_PROP,
    filtered_by: ownerFilterId ? {
      ownerId: ownerFilterId,
      name: OWNER_ID_TO_NAME[ownerFilterId] || null
    } : null,
    contacts: scored
  });
}
