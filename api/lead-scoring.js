// /api/lead-scoring — top N contacts by HubSpot lead score
// Fetches the score history from HubSpot's property-history API (batch read, 1 call for up to 100 ids)
// Computes WoW delta and position change. No DB needed.

import { verifyAuthCookie, OWNER_ID_TO_NAME } from '../lib/auth.js';

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

// History array is sorted newest-first by HubSpot.
// Return the value at-or-before the targetDate.
function scoreAtDate(history, targetMs) {
  if (!Array.isArray(history) || !history.length) return null;
  for (const e of history) {
    const t = new Date(e.timestamp || e.timestampISO || 0).getTime();
    if (t <= targetMs) return parseFloat(e.value) || 0;
  }
  // Target is before all known history entries — score was 0 at that point
  return 0;
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

  // 1) Top N contacts by hubspotscore
  let searchRes;
  try {
    searchRes = await hsApi(hsToken, 'POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [
        { propertyName: 'hubspotscore', operator: 'HAS_PROPERTY' }
      ]}],
      sorts: [{ propertyName: 'hubspotscore', direction: 'DESCENDING' }],
      properties: [
        'firstname', 'lastname', 'email', 'company', 'hubspotscore',
        'lifecyclestage', 'jobtitle', 'hubspot_owner_id', 'hs_lead_status',
        'lastmodifieddate', 'notes_last_contacted', 'createdate'
      ],
      limit
    });
  } catch (e) {
    return res.status(502).json({ error: 'hubspot_search_failed', detail: e.message });
  }

  const top = searchRes.results || [];
  const ids = top.map(c => c.id);

  // 2) Batch read with property history for hubspotscore
  let withHistory = {};
  if (ids.length > 0) {
    try {
      // batch/read supports max 100 ids — paginate if needed
      const chunks = [];
      for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
      for (const chunk of chunks) {
        const batchRes = await hsApi(hsToken, 'POST', '/crm/v3/objects/contacts/batch/read', {
          propertiesWithHistory: ['hubspotscore'],
          inputs: chunk.map(id => ({ id }))
        });
        for (const r of (batchRes.results || [])) {
          withHistory[r.id] = r.propertiesWithHistory?.hubspotscore || [];
        }
      }
    } catch (e) {
      console.error('[lead-scoring] history batch failed:', e.message);
      // Continue without history — delta will be null
    }
  }

  // 3) Compute current rank + score-at-comparison-date
  const compareMs = Date.now() - compareDays * 86400000;
  const scored = top.map((c, idx) => {
    const current = parseFloat(c.properties.hubspotscore || '0') || 0;
    const history = withHistory[c.id] || [];
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
      owner_id: c.properties.hubspot_owner_id || null,
      owner: OWNER_ID_TO_NAME[c.properties.hubspot_owner_id] || null,
      last_activity: c.properties.notes_last_contacted || c.properties.lastmodifieddate || null,
      created: c.properties.createdate || null,
      hubspot_url: `https://app.hubspot.com/contacts/0/contact/${c.id}`
    };
  });

  // 4) Compute previous ranking among the same N contacts based on past scores
  const eligible = scored.filter(s => s.score_then != null);
  const pastRanking = eligible.slice()
    .sort((a, b) => b.score_then - a.score_then)
    .map((s, idx) => [s.id, idx + 1]);
  const pastRankMap = Object.fromEntries(pastRanking);

  for (const s of scored) {
    s.rank_then = pastRankMap[s.id] || null;
    s.rank_delta = (s.rank_then != null) ? (s.rank_then - s.rank) : null;
    // Positive rank_delta = moved up (rank improved)
  }

  return res.status(200).json({
    count: scored.length,
    as_of: new Date().toISOString(),
    compared_to: new Date(compareMs).toISOString(),
    compare_days: compareDays,
    contacts: scored
  });
}
