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


export const config = { maxDuration: 60 };

async function handleSnapshot(req, res) {
  // Lazy import to avoid loading blob lib when not needed
  let saveSnapshot;
  try {
    const mod = await import('../lib/blob.js');
    saveSnapshot = mod.saveSnapshot;
  } catch (e) {
    return res.status(500).json({ error: 'blob_not_available', detail: e.message });
  }

  const cronSecret = process.env.CRON_SECRET;
  const cronHeader = req.headers.authorization || req.headers['x-vercel-cron'];
  const isCron = cronSecret
    ? cronHeader === `Bearer ${cronSecret}`
    : !!req.headers['x-vercel-cron'];

  if (!isCron) {
    const token = process.env.DASHBOARD_TOKEN;
    const cookies = req.headers.cookie || '';
    const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
    const user = m && token ? await verifyAuthCookie(m[1], token) : null;
    if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
      return res.status(401).json({ error: 'Not authorized — admin or cron only' });
    }
  }

  const hsToken = process.env.HUBSPOT_TOKEN;
  if (!hsToken) return res.status(500).json({ error: 'HUBSPOT_TOKEN not set' });

  const SCORE_PROP = process.env.HUBSPOT_LEAD_SCORE_PROPERTY || 'all_engagement_lead_score';

  const t0 = Date.now();
  const all = [];
  let after;
  let pages = 0;
  while (all.length < 50000) {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: SCORE_PROP, operator: 'GT', value: '0' }
      ]}],
      sorts: [{ propertyName: SCORE_PROP, direction: 'DESCENDING' }],
      properties: [SCORE_PROP],
      limit: 200
    };
    if (after) body.after = after;
    const r = await hsApi(hsToken, 'POST', '/crm/v3/objects/contacts/search', body);
    for (const c of (r.results || [])) {
      all.push({ id: c.id, s: parseFloat(c.properties[SCORE_PROP] || '0') || 0 });
    }
    pages++;
    if (!r.paging?.next?.after) break;
    after = r.paging.next.after;
  }
  const fetchMs = Date.now() - t0;
  const ranked = all.map((c, i) => ({ id: c.id, s: c.s, r: i + 1 }));
  const snapshot = {
    v: 1, score_property: SCORE_PROP, taken_at: new Date().toISOString(),
    count: ranked.length, pages, contacts: ranked
  };
  const dateKey = new Date().toISOString().slice(0, 10);
  let saved;
  try { saved = await saveSnapshot(dateKey, snapshot); }
  catch (e) { return res.status(502).json({ error: 'blob_save_failed', detail: e.message }); }
  return res.status(200).json({
    ok: true, date: dateKey, count: ranked.length,
    pages_fetched: pages, fetch_ms: fetchMs, total_ms: Date.now() - t0, blob_url: saved.url
  });
}

// ============================================================
// Shared definitions with the weekly "LeadScoringLeads <> AutomatedReport"
// email (n8n fXLZ2fGwho7wlFSQ). The report and this tab were drifting: the
// report filtered a pool and ranked by weekly momentum, the tab listed whatever
// had a score and ranked by absolute value. Two different "top leads" lists for
// the same rep is worse than one imperfect one, so the rules live here and
// match the report field for field.
const DS_PIPELINE = '23928898';
const GH_PIPELINE = '733019294';                       // Green House = nurture
const DS_ADVANCED = { '56188257': 'Quote', '1301242997': 'Driving to Close', '85090957': 'Contract' };
const DS_EARLY    = { '56188255': 'Qualify', '56188256': 'Discovery' };
const EX_CUSTOMER_STAGE = '149736736';
const WORKING_STATUSES = ['IN_PROGRESS', 'CONNECTED', 'ATTEMPTED_TO_CONTACT', 'OPEN', 'OPEN_DEAL'];

// Engagement that counts. Marketing email opens are deliberately NOT here:
// bulk sends and Apple Mail privacy fire them without a human reading anything.
// They travel as a hint (marketing_open_days) and never move the ranking.
const ACTIVITY_FIELDS = [
  'hs_last_sales_activity_timestamp',
  'hs_analytics_last_visit_timestamp',
  'hs_sales_email_last_opened',
  'recent_conversion_date'
];

// The Stage column was printing raw ids — "149736736" instead of "Ex-customer".
const STAGE_LABELS = {
  subscriber: 'Subscriber', lead: 'Lead', marketingqualifiedlead: 'MQL',
  salesqualifiedlead: 'SQL', opportunity: 'Opportunity', customer: 'Customer',
  evangelist: 'Evangelist', other: 'Other', [EX_CUSTOMER_STAGE]: 'Ex-customer'
};
const stageLabel = v => {
  const k = String(v || '').toLowerCase();
  return STAGE_LABELS[k] || STAGE_LABELS[String(v || '')] || (v ? String(v) : '');
};

const tsOf = v => {
  if (!v) return 0;
  const n = Number(v);
  if (!Number.isNaN(n) && n > 1e11) return n;   // HubSpot epoch millis
  const d = Date.parse(v);
  return Number.isNaN(d) ? 0 : d;
};

// Contacts the rep should not be looking at. Same four exclusions as the email,
// each for a different reason: already lost, our own staff, already deep in a
// deal, or someone at a school that is already a customer.
async function buildExclusions(hsToken) {
  const out = { lostContactIds: new Set(), advancedContactIds: new Set(),
                customerDomains: new Set(), openDealsByContact: {} };
  const safe = async (fn) => { try { return await fn(); } catch (e) { console.error('[lead-scoring]', e.message); return null; } };

  const pageAll = async (path, body, max = 10) => {
    const rows = []; let after;
    for (let i = 0; i < max; i++) {
      const r = await hsApi(hsToken, 'POST', path, after ? { ...body, after } : body);
      for (const x of (r.results || [])) rows.push(x);
      if (!r.paging?.next?.after) break;
      after = r.paging.next.after;
    }
    return rows;
  };
  const assocContacts = async (dealIds) => {
    const map = {};
    for (let i = 0; i < dealIds.length; i += 100) {
      const r = await hsApi(hsToken, 'POST', '/crm/v4/associations/deals/contacts/batch/read',
        { inputs: dealIds.slice(i, i + 100).map(id => ({ id })) });
      for (const row of (r.results || [])) {
        const did = String(row.from?.id || '');
        for (const t of (row.to || [])) {
          const cid = String(t.toObjectId != null ? t.toObjectId : t.id);
          (map[cid] = map[cid] || []).push(did);
        }
      }
    }
    return map;
  };

  // 1) closed-lost in the last 12 months
  await safe(async () => {
    const yearAgo = String(Date.now() - 365 * 86400000);
    const lost = await pageAll('/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: 'hs_is_closed_lost', operator: 'EQ', value: 'true' },
        { propertyName: 'closedate', operator: 'GTE', value: yearAgo }
      ]}],
      properties: ['dealname'], limit: 200
    });
    const map = await assocContacts(lost.map(d => d.id));
    for (const cid of Object.keys(map)) out.lostContactIds.add(cid);
  });

  // 2) open deals — both to exclude the advanced ones and to label the rest
  await safe(async () => {
    const open = await pageAll('/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [{ propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }] }],
      properties: ['dealname', 'dealstage', 'pipeline'], limit: 200
    });
    const info = {};
    for (const d of open) info[String(d.id)] = {
      pipeline: String(d.properties?.pipeline || ''), stage: String(d.properties?.dealstage || '') };
    const map = await assocContacts(open.map(d => d.id));
    for (const [cid, dids] of Object.entries(map)) {
      const deals = dids.map(id => info[id]).filter(Boolean);
      out.openDealsByContact[cid] = deals;
      if (deals.some(d => d.pipeline === DS_PIPELINE && DS_ADVANCED[d.stage])) out.advancedContactIds.add(cid);
    }
  });

  // 3) customer institutions, matched by email domain
  await safe(async () => {
    const comps = await pageAll('/crm/v3/objects/companies/search', {
      filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }] }],
      properties: ['name', 'domain'], limit: 200
    });
    for (const c of comps) {
      const dom = String(c.properties?.domain || '').toLowerCase().trim().replace(/^www\./, '');
      if (dom) out.customerDomains.add(dom);
    }
  });

  return out;
}

function classifyOpenDeals(list) {
  const r = { advanced: false, early: false, nurture: false, other: false, labels: [] };
  for (const d of (list || [])) {
    if (d.pipeline === DS_PIPELINE && DS_ADVANCED[d.stage]) { r.advanced = true; r.labels.push(DS_ADVANCED[d.stage]); }
    else if (d.pipeline === DS_PIPELINE && DS_EARLY[d.stage]) { r.early = true; r.labels.push(DS_EARLY[d.stage]); }
    else if (d.pipeline === GH_PIPELINE) { r.nurture = true; r.labels.push('Nurture'); }
    else { r.other = true; r.labels.push('Deal'); }
  }
  return r;
}

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  const hsToken = process.env.HUBSPOT_TOKEN;
  if (!token || !hsToken) return res.status(500).json({ error: 'tokens missing' });

  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  // ----- SNAPSHOT branch -----
  if (url.searchParams.get('action') === 'snapshot') {
    return handleSnapshot(req, res);
  }

  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

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
  // Same pool as the weekly email: Medium/High only, customers and ex-customers
  // out. The old filter was "has a score at all", which is why the tab showed
  // names the report had already set aside.
  const searchFilters = [
    { propertyName: SCORE_PROP, operator: 'HAS_PROPERTY' },
    { propertyName: 'lifecyclestage', operator: 'NOT_IN', values: ['customer', EX_CUSTOMER_STAGE] },
    { propertyName: 'all_engagement_lead_score_threshold', operator: 'IN', values: ['Medium', 'High'] }
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
        'all_engagement_lead_score_threshold',
        'lifecyclestage', 'jobtitle', 'hubspot_owner_id', 'hs_lead_status',
        'lastmodifieddate', 'notes_last_contacted', 'createdate',
        'num_associated_deals',
        // Engagement, for the ranking and the Last activity column.
        ...ACTIVITY_FIELDS, 'hs_email_last_open_date'
      ],
      // Over-fetch: the four exclusions below cut the list, and asking for
      // exactly `limit` would return fewer than `limit` usable rows.
      limit: Math.min(200, Math.max(limit * 2, limit))
    });
  } catch (e) {
    return res.status(502).json({ error: 'hubspot_search_failed', detail: e.message, score_property: SCORE_PROP });
  }

  let top = searchRes.results || [];

  // The four exclusions the weekly email applies. Without them the tab shows
  // the rep names the report deliberately left out.
  const excl = await buildExclusions(hsToken);
  const isInternal = c => /@degreesight\.com$/i.test(String(c.properties?.email || ''));
  const isCustomerDomain = (email) => {
    const dom = String(email || '').toLowerCase().split('@')[1] || '';
    if (!dom) return false;
    for (const c of excl.customerDomains) if (dom === c || dom.endsWith('.' + c)) return true;
    return false;
  };
  const removed = { lost: 0, internal: 0, advanced: 0, customerDomain: 0 };
  top = top.filter(c => {
    const id = String(c.id);
    if (excl.lostContactIds.has(id)) { removed.lost++; return false; }
    if (isInternal(c)) { removed.internal++; return false; }
    if (excl.advancedContactIds.has(id)) { removed.advanced++; return false; }
    if (isCustomerDomain(c.properties?.email)) { removed.customerDomain++; return false; }
    return true;
  }).slice(0, limit);

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

  // ---- the report's own fields, added on top ----
  const nowMs = Date.now();
  const WEEK = 7 * 86400000;
  for (const r of scored) {
    const p = top.find(c => String(c.id) === String(r.id))?.properties || {};

    // Last activity = the most recent REAL engagement, not "record touched".
    // The old value was notes_last_contacted || lastmodifieddate, and
    // lastmodifieddate moves when a workflow writes a field, so a contact who
    // had done nothing for months could read as active today.
    const lastActTs = Math.max(0, ...ACTIVITY_FIELDS.map(f => tsOf(p[f])));
    const mktTs = tsOf(p.hs_email_last_open_date);
    r.last_activity_ts = lastActTs || null;
    r.last_activity = lastActTs ? new Date(lastActTs).toISOString() : null;
    r.last_activity_days = lastActTs ? Math.floor((nowMs - lastActTs) / 86400000) : null;
    r.marketing_open_days = mktTs ? Math.floor((nowMs - mktTs) / 86400000) : null;

    // Raw id in, words out. "149736736" meant nothing to a rep.
    r.lifecyclestage_id = r.lifecyclestage;
    r.lifecyclestage = stageLabel(r.lifecyclestage);
    r.tier_threshold = p.all_engagement_lead_score_threshold || null;

    const dc = classifyOpenDeals(excl.openDealsByContact[String(r.id)]);
    r.open_deal_labels = dc.labels;
    r.in_deal = dc.early || dc.other;
    r.in_nurture = dc.nurture;
    r.ex_customer = String(r.lifecyclestage_id) === EX_CUSTOMER_STAGE;
    r.working = WORKING_STATUSES.includes(String(r.lead_status || '').toUpperCase());
    const createdTs = tsOf(p.createdate);
    r.is_new = createdTs > 0 && (nowMs - createdTs) <= WEEK;
    r.engaged_this_week = !!lastActTs && (nowMs - lastActTs) <= WEEK;
    // "clean" = nobody is on it and it is not parked. Same definition the email
    // uses to decide what belongs in New and Movers.
    r.clean = !r.working && !r.in_deal && !r.in_nurture && !r.ex_customer;
    r.is_mover = r.clean && ((r.score_delta || 0) > 0 || r.engaged_this_week);

    r.status_badges = [];
    if (r.working) r.status_badges.push('Working · ' + String(r.lead_status || '').replace(/_/g, ' ').toLowerCase());
    if (r.in_deal) r.status_badges.push('In deal · ' + dc.labels.filter(l => l !== 'Nurture').join(', '));
    if (r.in_nurture) r.status_badges.push('Nurture');
    if (r.ex_customer) r.status_badges.push('Ex-customer');
    if (!r.status_badges.length && r.is_new) r.status_badges.push('New');
  }

  // Weekly momentum, the email's ranking: what moved, then who engaged, then
  // absolute score. Ranking by score alone put the same names on top every
  // week and buried the ones that had just started moving.
  scored.sort((a, b) =>
    ((b.score_delta || 0) - (a.score_delta || 0)) ||
    ((b.last_activity_ts || 0) - (a.last_activity_ts || 0)) ||
    (b.score - a.score));
  scored.forEach((r, i) => { r.rank = i + 1; });

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
    // Section membership, so the tab can show New and Movers the way the email
    // does without recomputing the rules in the browser.
    sections: {
      new: scored.filter(r => r.is_new && r.clean).map(r => r.id),
      movers: scored.filter(r => r.is_mover && !r.is_new).map(r => r.id)
    },
    pool: {
      shown: scored.length,
      working: scored.filter(r => r.working).length,
      in_deal: scored.filter(r => r.in_deal).length,
      nurture: scored.filter(r => r.in_nurture).length,
      engaged_7d: scored.filter(r => r.engaged_this_week).length,
      gained_score: scored.filter(r => (r.score_delta || 0) > 0).length,
      excluded: removed
    },
    ranking: 'weekly momentum: score gained, then most recent engagement, then total score',
    matches_report: 'LeadScoringLeads <> AutomatedReport (n8n fXLZ2fGwho7wlFSQ)',
    contacts: scored
  });
}
