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

// ---------- Google Drive client (service account, zero deps) ----------
// Env: GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY (keep \n escapes), DRIVE_FOLDER_ID
import crypto from 'node:crypto';

let _gdToken = null; // { token, exp }
function _b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function driveToken() {
  const email = process.env.GOOGLE_SA_EMAIL;
  let key = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !key) throw new Error('GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY not set');
  key = key.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  if (_gdToken && _gdToken.exp > now + 60) return _gdToken.token;
  const header = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = _b64url(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${_b64url(signer.sign(key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`
  });
  if (!r.ok) throw new Error(`Google token ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  _gdToken = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return _gdToken.token;
}
async function driveFetch(path, opts = {}) {
  const token = await driveToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
  });
  if (!r.ok) throw new Error(`Drive ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}
function _gdEsc(name) { return name.replace(/'/g, "\\'"); }
function rootFolderId() {
  const id = process.env.DRIVE_FOLDER_ID;
  if (!id) throw new Error('DRIVE_FOLDER_ID not set');
  return id;
}
async function findChild(parentId, name, { folderOnly = false } = {}) {
  const q = encodeURIComponent(
    `'${parentId}' in parents and name = '${_gdEsc(name)}' and trashed = false` +
    (folderOnly ? ` and mimeType = 'application/vnd.google-apps.folder'` : '')
  );
  const r = await driveFetch(`/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=5`);
  return ((await r.json()).files || [])[0] || null;
}
async function ensureFolder(parentId, name) {
  const existing = await findChild(parentId, name, { folderOnly: true });
  if (existing) return existing.id;
  const r = await driveFetch(`/files?supportsAllDrives=true&fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  return (await r.json()).id;
}
async function listFolders(parentId) {
  const q = encodeURIComponent(`'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const r = await driveFetch(`/files?q=${q}&fields=files(id,name,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=100`);
  return ((await r.json()).files || []);
}
// Upload (create or overwrite-by-name) into a folder. content: Buffer.
async function uploadFile(folderId, name, content, mimeType) {
  const existing = await findChild(folderId, name);
  const token = await driveToken();
  const boundary = '-------dsb' + Date.now();
  const metadata = existing ? { name } : { name, parents: [folderId] };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--`)
  ]);
  const uploadUrl = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`;
  const r = await fetch(uploadUrl, {
    method: existing ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!r.ok) throw new Error(`Drive upload ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function downloadFile(fileId) {
  const r = await driveFetch(`/files/${fileId}?alt=media&supportsAllDrives=true`);
  return Buffer.from(await r.arrayBuffer());
}
function folderUrl(folderId) { return `https://drive.google.com/drive/folders/${folderId}`; }
// ---------- end Google Drive client ----------

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

    // ===== WEEKLY: weekly dossier batch + per-rep digests (saved to Confluence) =====
    if (action === 'weekly') {
      const sub = url.searchParams.get('sub') || 'plan';
      // Reps in the weekly loop. Cody intentionally excluded (routing rules: his
      // net-new accounts flow to Charles).
      const WEEKLY_REPS = [
        { name: 'Jay Fedje',      ownerId: '118972528' },
        { name: 'Michael Cronin', ownerId: '84179396' },
        { name: 'Charles Ramos',  ownerId: '90988586' },
        { name: 'Drew Melendres', ownerId: '30458491' }
      ];
      const now = new Date();
      const wk = (() => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
      const week = url.searchParams.get('week') || wk;
      // Storage: Google Drive (inlined client above). Week folder "Week of YYYY-MM-DD"
      // inside DRIVE_FOLDER_ID; bundle.json + one PDF per dossier.
      const WEEK_FOLDER = w => `Week of ${w}`;

      // --- plan: pick this week's top 25 targets, weighted toward STRONG intent ---
      // Strong intent = RFP / Purchase / Meeting signals (score 3x); general
      // hotness signals score 1x. Top 25 buyers by total intent score.
      if (sub === 'plan') {
        const STRONG_TYPES = new Set(['RFP', 'Purchase', 'Meeting']);
        const [hot, rfp, purchase, meeting] = await Promise.all([
          listTopRecentSignals({ pageSize: 100, sort: 'Hotness', relativeDatePeriodFrom: 'LastSevenDays' }),
          listTopRecentSignals({ pageSize: 50, filterType: ['RFP'],      relativeDatePeriodFrom: 'LastSevenDays' }).catch(() => ({ result: [] })),
          listTopRecentSignals({ pageSize: 50, filterType: ['Purchase'], relativeDatePeriodFrom: 'LastSevenDays' }).catch(() => ({ result: [] })),
          listTopRecentSignals({ pageSize: 50, filterType: ['Meeting'],  relativeDatePeriodFrom: 'LastSevenDays' }).catch(() => ({ result: [] }))
        ]);
        const all = [...(hot.result || []), ...(rfp.result || []), ...(purchase.result || []), ...(meeting.result || [])];
        const byBuyer = {};
        const seenSignal = new Set(); // dedupe the same signal appearing in two fetches
        for (const s of all) {
          const bid = s.row?.buyerId;
          if (!bid) continue;
          const sigKey = `${bid}|${s.bridge?.name || ''}|${s.row?.name || ''}`;
          if (seenSignal.has(sigKey)) continue;
          seenSignal.add(sigKey);
          const type = s.bridge?.filterType || null;
          const weight = STRONG_TYPES.has(type) ? 3 : 1;
          if (!byBuyer[bid]) byBuyer[bid] = { buyerId: bid, name: s.row?.buyerName || s.row?.name || '', signal_count: 0, intent_score: 0, strong_signals: 0, top_signal: null };
          byBuyer[bid].signal_count++;
          byBuyer[bid].intent_score += weight;
          if (STRONG_TYPES.has(type)) byBuyer[bid].strong_signals++;
          // Prefer a strong-intent signal as the headline signal
          if (!byBuyer[bid].top_signal || (STRONG_TYPES.has(type) && !STRONG_TYPES.has(byBuyer[bid].top_signal.type))) {
            byBuyer[bid].top_signal = { type, name: s.row?.name || null, bridge: s.bridge?.name || null };
          }
          if (!byBuyer[bid].name && s.row?.name) byBuyer[bid].name = s.row.name;
        }
        const targets = Object.values(byBuyer)
          .sort((a, b) => b.intent_score - a.intent_score || b.signal_count - a.signal_count)
          .slice(0, 25);
        return res.status(200).json({ week, targets, total_signals: all.length });
      }

      // --- digests: one Claude digest per rep (minus Cody) ---
      if (sub === 'digests') {
        const body = req.body || {};
        const dossierSummaries = Array.isArray(body.dossiers) ? body.dossiers : [];
        const hsToken = process.env.HUBSPOT_TOKEN;
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
        const weekStartISO = `${week}T00:00:00Z`;
        const digests = {};
        for (const rep of WEEKLY_REPS) {
          // Deals that moved this week for this rep
          let movedDeals = [];
          if (hsToken) {
            try {
              const dr = await hsSearch(hsToken, 'deals', {
                filterGroups: [{ filters: [
                  { propertyName: 'hubspot_owner_id', operator: 'EQ', value: rep.ownerId },
                  { propertyName: 'hs_lastmodifieddate', operator: 'BETWEEN', value: weekStartISO, highValue: new Date().toISOString() }
                ] }],
                properties: ['dealname', 'dealstage', 'amount', 'closedate'],
                sorts: [{ propertyName: 'amount', direction: 'DESCENDING' }], limit: 15
              });
              movedDeals = (dr.results || []).map(x => x.properties);
            } catch (e) { /* digest still works without deals */ }
          }
          const repDossiers = dossierSummaries.filter(d2 => (d2.prepared_for || '') === rep.name);
          const prompt = `You write a short Monday digest for a DegreeSight sales rep. Concise, direct, plain language. NO em dashes. Use "candidly" rather than "honestly". Be honest about gaps.

REP: ${rep.name}
WEEK OF: ${week}
NEW ACCOUNT DOSSIERS PREPARED FOR THIS REP THIS WEEK: ${JSON.stringify(repDossiers)}
THEIR DEALS WITH ACTIVITY THIS WEEK: ${JSON.stringify(movedDeals)}

Return VALID JSON only:
{
  "headline": "≤14 words, the single most important thing for ${rep.name} this week",
  "bullets": ["3-5 items, each ≤30 words, start with <b>bolded action or fact.</b> Reference the dossiers and deals above by name. If there is nothing for a category, say so candidly."],
  "focus_account": "school name from the dossiers most worth their first hour, or null"
}`;
          try {
            const r2 = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
              body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 900, messages: [{ role: 'user', content: prompt }] })
            });
            if (!r2.ok) throw new Error(`Claude ${r2.status}`);
            const j2 = await r2.json();
            const txt = (j2.content?.[0]?.text || '').replace(/^```(?:json)?\s*/gim, '').replace(/\s*```\s*$/gim, '');
            const s2 = txt.indexOf('{'), e3 = txt.lastIndexOf('}');
            digests[rep.name] = JSON.parse(txt.slice(s2, e3 + 1).replace(/,(\s*[\}\]])/g, '$1'));
          } catch (e) {
            digests[rep.name] = { headline: 'Digest unavailable', bullets: [`Claude error: ${e.message}`], focus_account: null, _error: true };
          }
          digests[rep.name].moved_deals = movedDeals.length;
          digests[rep.name].dossier_count = repDossiers.length;
        }
        return res.status(200).json({ week, digests });
      }

      // --- save: persist the weekly bundle (JSON) to the week's Drive folder ---
      if (sub === 'save') {
        const bundle = req.body || {};
        if (!bundle.week) bundle.week = week;
        bundle.saved_at = new Date().toISOString();
        bundle.saved_by = user.email;
        const folderId = await ensureFolder(rootFolderId(), WEEK_FOLDER(bundle.week));
        await uploadFile(folderId, 'bundle.json', Buffer.from(JSON.stringify(bundle, null, 2)), 'application/json');
        return res.status(200).json({ ok: true, week: bundle.week, folder_id: folderId, folder_url: folderUrl(folderId) });
      }

      // --- pdf: upload one dossier PDF (base64) into the week's folder ---
      if (sub === 'pdf') {
        const b = req.body || {};
        if (!b.pdf_base64 || !b.school_name) return res.status(400).json({ error: 'school_name and pdf_base64 required' });
        const w2 = b.week || week;
        const folderId = await ensureFolder(rootFolderId(), WEEK_FOLDER(w2));
        const safeName = String(b.school_name).replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
        const buf = Buffer.from(b.pdf_base64, 'base64');
        if (buf.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'PDF too large (>4MB)' });
        const up = await uploadFile(folderId, `${safeName}.pdf`, buf, 'application/pdf');
        return res.status(200).json({ ok: true, file_id: up.id, url: up.webViewLink || null });
      }

      // --- list: saved weeks (Drive subfolders) ---
      if (sub === 'list') {
        const folders = await listFolders(rootFolderId());
        const weeks = folders
          .filter(f => (f.name || '').startsWith('Week of '))
          .map(f => ({ week: f.name.replace('Week of ', ''), folder_id: f.id, folder_url: folderUrl(f.id), updated_at: f.modifiedTime }))
          .sort((a, b) => b.week.localeCompare(a.week));
        return res.status(200).json({ weeks });
      }

      // --- get: load one saved week's bundle.json ---
      if (sub === 'get') {
        const folder = await findChild(rootFolderId(), WEEK_FOLDER(week), { folderOnly: true });
        if (!folder) return res.status(404).json({ error: `No saved folder for week ${week}` });
        const file = await findChild(folder.id, 'bundle.json');
        if (!file) return res.status(404).json({ error: 'Folder exists but bundle.json is missing' });
        const buf = await downloadFile(file.id);
        let bundle;
        try { bundle = JSON.parse(buf.toString('utf8')); }
        catch { return res.status(500).json({ error: 'bundle.json could not be parsed' }); }
        return res.status(200).json({ week, bundle, folder_url: folderUrl(folder.id) });
      }

      // --- notify: Slack webhook to the team (reps minus Cody) ---
      if (sub === 'notify') {
        const hook = process.env.SLACK_WEBHOOK_URL;
        if (!hook) return res.status(400).json({ error: 'SLACK_WEBHOOK_URL not set. Create an incoming webhook in Slack and add it as a Vercel env var.' });
        const b = req.body || {};
        const names = WEEKLY_REPS.map(r3 => r3.name).join(', ');
        const dashUrl = `https://${req.headers.host}/sales.html`;
        const text = `📂 *Weekly dossiers are ready* (week of ${b.week || week})\n` +
          `${b.dossier_count ?? '?'} account dossier${(b.dossier_count || 0) === 1 ? '' : 's'} + personal digests for: ${names}\n` +
          `Open the *Dossier → Weekly* tab: ${dashUrl}` +
          (b.folder_url ? `\nPDFs on Drive: ${b.folder_url}` : '');
        const r4 = await fetch(hook, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        if (!r4.ok) return res.status(500).json({ error: `Slack webhook ${r4.status}: ${(await r4.text()).slice(0, 200)}` });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: `unknown weekly sub: ${sub}` });
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
