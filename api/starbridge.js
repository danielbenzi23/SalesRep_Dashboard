// /api/starbridge — combined signals + buyer-search + buyer-summary (was 3 functions)
// GET /api/starbridge?action=signals  → top recent signals across org
// GET /api/starbridge?action=search&q=X → search buyers by name
// GET /api/starbridge?action=summary&buyerId=X → buyer AI summary + recent signals
// GET /api/starbridge?action=dossier&buyerId=X&buyerName=Y → full account dossier JSON
//   (Starbridge + HubSpot + Claude synthesis, follows Weekly Signal Dossiers rules)

import { verifyAuthCookie, OWNER_ID_TO_NAME } from '../lib/auth.js';
import {
  listTopRecentSignals,
  searchBuyers,
  getBuyerSummary,
  listRecentBuyerSignals,
  getBuyerAttributes
} from '../lib/starbridge.js';

export const config = { maxDuration: 60 };

// ---------- HubSpot helpers (dossier) ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function hsSearch(hsToken, obj, body, attempt = 0) {
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${obj}/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status === 429 && attempt < 5) {
    await sleep(Math.min(5000, 500 * Math.pow(1.6, attempt)));
    return hsSearch(hsToken, obj, body, attempt + 1);
  }
  if (!r.ok) throw new Error(`HubSpot ${obj} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function hsAssociations(hsToken, fromType, fromId, toType) {
  const r = await fetch(`https://api.hubapi.com/crm/v4/objects/${fromType}/${fromId}/associations/${toType}?limit=50`, {
    headers: { Authorization: `Bearer ${hsToken}` }
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map(x => x.toObjectId);
}

async function hsBatchRead(hsToken, obj, ids, properties) {
  if (!ids.length) return [];
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${obj}/batch/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: ids.slice(0, 50).map(id => ({ id: String(id) })), properties })
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map(x => ({ id: x.id, ...x.properties }));
}

// Fetch HubSpot company + contacts + deals + resolve ownership per the
// Weekly Signal Dossiers routing rules (company owner supersedes contact;
// closed-won = skip flag; open deal = keep owner; else Cody→Charles).
async function fetchHubSpotCompanyData(hsToken, schoolName) {
  const out = { company: null, contacts: [], deals: [], owner_name: null, destination_owner: null, deal_state: 'none', skip_reason: null };
  try {
    const cr = await hsSearch(hsToken, 'companies', {
      filterGroups: [
        { filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: schoolName }] }
      ],
      properties: ['name', 'domain', 'hubspot_owner_id', 'lifecyclestage', 'city', 'state'],
      limit: 3
    });
    const company = (cr.results || [])[0];
    if (!company) return out;
    out.company = { id: company.id, ...company.properties };
    const ownerId = company.properties.hubspot_owner_id;
    out.owner_name = OWNER_ID_TO_NAME[ownerId] || (ownerId ? `Owner ${ownerId}` : null);

    // Contacts + deals in parallel
    const [contactIds, dealIds] = await Promise.all([
      hsAssociations(hsToken, 'companies', company.id, 'contacts'),
      hsAssociations(hsToken, 'companies', company.id, 'deals')
    ]);
    const [contacts, deals] = await Promise.all([
      hsBatchRead(hsToken, 'contacts', contactIds, ['firstname', 'lastname', 'email', 'jobtitle']),
      hsBatchRead(hsToken, 'deals', dealIds, ['dealname', 'dealstage', 'amount', 'closedate', 'pipeline'])
    ]);
    out.contacts = contacts.map(c => ({
      name: [c.firstname, c.lastname].filter(Boolean).join(' '),
      email: c.email || null, title: c.jobtitle || null
    })).filter(c => c.name || c.email);
    out.deals = deals;

    // Deal-state routing (WON stage id 56188260, LOST 56188261 on DS pipeline;
    // fall back to name matching for other pipelines)
    const isWon = d => d.dealstage === '56188260' || /won/i.test(d.dealstage || '');
    const isLost = d => d.dealstage === '56188261' || /lost/i.test(d.dealstage || '');
    if (deals.some(isWon)) { out.deal_state = 'closed_won'; out.skip_reason = 'Company already has a closed-won deal'; }
    else if (deals.some(d => !isWon(d) && !isLost(d))) out.deal_state = 'open';
    else if (deals.length) out.deal_state = 'closed_lost_only';

    // Reassignment: Cody → Charles only when no open deal
    if (out.deal_state === 'open' || out.deal_state === 'closed_won') {
      out.destination_owner = out.owner_name;
    } else {
      out.destination_owner = (out.owner_name === 'Cody Bennett') ? 'Charles Ramos' : (out.owner_name || null);
    }
  } catch (e) {
    out._error = e.message;
  }
  return out;
}

// Claude synthesis — builds the dossier copy JSON following the writing rules.
async function claudeDossier(payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const prompt = `You are writing a DegreeSight account dossier. DegreeSight sells AI-powered transfer credit evaluation and degree-audit for higher ed (two motions: Inbound student-facing transferability check; Insight registrar-grade automated credit evaluation). Partner references: Indiana Wesleyan, Cumberlands, Youngstown State, Roosevelt University.

WRITING RULES (hard):
- Concise, direct, plain language. NO em dashes anywhere. No corporate filler.
- Use "candidly" rather than "honestly".
- Be honest about gaps and risk. Flag hard budgets and unclear ownership.
- Inline <b>...</b> tags allowed for emphasis. Word limits below are strict.

DATA:
${JSON.stringify(payload, null, 2)}

Return VALID JSON only:
{
  "theme": "hot" | "warm" | "neutral",
  "tag": "Signal-Driven" | "Inbound" | "Account Review",
  "context_line": "≤12 words: target type · institution type · City, ST",
  "banner_label": "Why it's hot" | "Why it matters",
  "banner_text": "≤60 words. Lead with how it surfaced and why now. <b> allowed.",
  "tldr": ["3 items, each ≤35 words, start with <b>bolded takeaway.</b>"],
  "stats": [{"n": "value", "l": "≤8 word label", "warn": false}, "... exactly 4"],
  "stack": [{"label": "System category", "value": "Product name", "ok": true}, "... up to 4; ok=true when it is in DegreeSight connector set (Banner, Colleague, PeopleSoft, Workday, Slate, TargetX, Salesforce, DegreeWorks, uAchieve, Canvas, D2L, Blackboard, Moodle)"],
  "stack_matters": "≤55 words starting with <b>Why it matters:</b>",
  "people": [{"name": "", "badge": "Best entry|Verify title|Champion", "badge_type": "owner|stale|neutral", "role": "", "note": "≤25 words", "contact": "email"}, "... up to 2, ONLY from real HubSpot contacts provided"],
  "provenance_chips": [{"src": "Starbridge", "detail": "≤6 words"}, {"src": "HubSpot", "detail": "≤6 words"}],
  "provenance_point": "≤45 words starting with <b>The point of the integration:</b>",
  "fit": ["3 items ≤35 words each, start with <b>bold claim.</b> Why they would want DegreeSight."],
  "watch": ["3-4 items ≤30 words each, start with <b>Bolded risk.</b> Budget, ownership, timing, competitors."],
  "bring": ["3 items ≤25 words each, start with <b>Bolded item.</b> What to bring to the first call."],
  "pull_highlight": "2-4 word teal phrase",
  "pull_body": "≤55 words closing strategic framing",
  "sources_footer": "Sources: Starbridge, HubSpot. Figures Starbridge/IPEDS-derived; confirm in conversation."
}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const txt = (j.content?.[0]?.text || '').replace(/^```(?:json)?\s*/gim, '').replace(/\s*```\s*$/gim, '');
  const s = txt.indexOf('{'), e2 = txt.lastIndexOf('}');
  if (s < 0 || e2 <= s) throw new Error('Claude did not return JSON');
  let jsonStr = txt.slice(s, e2 + 1).replace(/,(\s*[\}\]])/g, '$1');
  return JSON.parse(jsonStr);
}

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

    // ===== DOSSIER: full account dossier (Starbridge + HubSpot + Claude) =====
    if (action === 'dossier') {
      const buyerId = url.searchParams.get('buyerId');
      const buyerName = url.searchParams.get('buyerName') || '';
      if (!buyerId) return res.status(400).json({ error: 'buyerId required' });
      const hsToken = process.env.HUBSPOT_TOKEN;

      // 1) Starbridge + HubSpot in parallel
      const [summaryRes, signalsRes, attributesRes, hubspotRes] = await Promise.allSettled([
        getBuyerSummary(buyerId),
        listRecentBuyerSignals(buyerId, { pageSize: 15 }),
        getBuyerAttributes(buyerId),
        hsToken && buyerName ? fetchHubSpotCompanyData(hsToken, buyerName) : Promise.resolve(null)
      ]);
      const summary = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
      const signals = signalsRes.status === 'fulfilled' ? signalsRes.value : [];
      const attributes = attributesRes.status === 'fulfilled' ? attributesRes.value : {};
      const hubspot = hubspotRes.status === 'fulfilled' ? hubspotRes.value : null;

      // Closed-won guard: dossier is pointless, but still return data + the flag
      const skip = hubspot && hubspot.deal_state === 'closed_won';

      // 2) Claude synthesis
      const claudePayload = {
        school_name: buyerName,
        starbridge_summary: summary,
        starbridge_attributes: attributes,
        recent_signals: (Array.isArray(signals) ? signals : (signals?.result || [])).slice(0, 10),
        hubspot: hubspot ? {
          company: hubspot.company,
          owner: hubspot.owner_name,
          destination_owner: hubspot.destination_owner,
          deal_state: hubspot.deal_state,
          contacts: hubspot.contacts.slice(0, 10),
          deals: hubspot.deals.map(d => ({ name: d.dealname, stage: d.dealstage, amount: d.amount }))
        } : null
      };
      let dossier = null, claude_error = null;
      try { dossier = await claudeDossier(claudePayload); }
      catch (e) { claude_error = e.message; }

      return res.status(200).json({
        buyerId,
        school_name: buyerName,
        skip_recommended: skip,
        skip_reason: hubspot?.skip_reason || null,
        prepared_for: hubspot?.destination_owner || null,
        owner_name: hubspot?.owner_name || null,
        deal_state: hubspot?.deal_state || 'unknown',
        hubspot_contacts: hubspot?.contacts || [],
        compiled_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        dossier,
        claude_error,
        _sources: {
          starbridge_summary: !!summary,
          starbridge_attributes: Object.keys(attributes || {}).length > 0,
          signals_count: (Array.isArray(signals) ? signals : (signals?.result || [])).length,
          hubspot_company: !!hubspot?.company,
          hubspot_error: hubspot?._error || null
        }
      });
    }

    // ===== ANALYTICS: aggregate signals overview =====
    if (action === 'analytics') {
      const period = url.searchParams.get('period') || 'LastThirtyDays';
      const [hotSignals, newSignals, rfpSignals, meetingSignals, jobChangeSignals] = await Promise.all([
        listTopRecentSignals({ pageSize: 100, sort: 'Hotness', relativeDatePeriodFrom: period }),
        listTopRecentSignals({ pageSize: 100, sort: 'Date',    relativeDatePeriodFrom: period }),
        listTopRecentSignals({ pageSize: 30,  filterType: ['RFP'],       relativeDatePeriodFrom: period }),
        listTopRecentSignals({ pageSize: 30,  filterType: ['Meeting'],   relativeDatePeriodFrom: period }),
        listTopRecentSignals({ pageSize: 30,  filterType: ['JobChange'], relativeDatePeriodFrom: period })
      ]);

      // Aggregate
      const allRows = [...(hotSignals.result || []), ...(newSignals.result || [])];
      const buyerCounts = {};
      const buyerLastSeen = {};
      const signalsByType = {};
      const bridgeCounts = {};
      for (const s of allRows) {
        const type = s.bridge?.filterType;
        if (type) signalsByType[type] = (signalsByType[type] || 0) + 1;
        const bridgeName = s.bridge?.name;
        if (bridgeName) bridgeCounts[bridgeName] = (bridgeCounts[bridgeName] || 0) + 1;
        const buyerId = s.row?.buyerId;
        if (buyerId) {
          if (!buyerCounts[buyerId]) buyerCounts[buyerId] = { buyerId, count: 0, sample_row_name: s.row.name };
          buyerCounts[buyerId].count++;
          const when = s.row.updatedAt;
          if (when && (!buyerLastSeen[buyerId] || when > buyerLastSeen[buyerId])) buyerLastSeen[buyerId] = when;
        }
      }
      const topBuyers = Object.values(buyerCounts)
        .map(b => ({ ...b, last_seen: buyerLastSeen[b.buyerId] || null }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      const topN = (obj, n = 15) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ label: k, count: v }));

      const compactSignal = (s) => ({
        buyer_id: s.row?.buyerId || null,
        bridge_name: s.bridge?.name,
        filter_type: s.bridge?.filterType,
        row_name: s.row?.name,
        status: s.row?.status,
        updated_at: s.row?.updatedAt
      });

      return res.status(200).json({
        period,
        total_signals: allRows.length,
        unique_buyers: Object.keys(buyerCounts).length,
        signals_by_type: signalsByType,
        top_bridges: topN(bridgeCounts, 10),
        top_buyers: topBuyers,
        hottest: (hotSignals.result || []).slice(0, 15).map(compactSignal),
        recent_rfps:        (rfpSignals.result || []).slice(0, 15).map(compactSignal),
        recent_meetings:    (meetingSignals.result || []).slice(0, 15).map(compactSignal),
        recent_job_changes: (jobChangeSignals.result || []).slice(0, 15).map(compactSignal)
      });
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
