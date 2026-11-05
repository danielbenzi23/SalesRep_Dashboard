// /api/call-performance — sales call scoring data for the Call Performance dashboard
// GET ?days=90|30|180|365|all  &type=sales|all
//
// Source: HubSpot meeting records carrying the call_* properties written by the
// n8n "Sales Call Scoring" workflow (BANT, next step, intake basics). Nothing is
// computed here beyond aggregation — the scoring itself lives in HubSpot.
//
// Access: any logged-in user. Everyone can see the whole team; the widget
// decides whether to focus on one rep (the viewer, or the selected rep).

import { verifyAuthCookie, EMAIL_TO_OWNER_ID, OWNER_ID_TO_NAME } from '../lib/auth.js';

export const config = { maxDuration: 60 };

// Cody (80532547) is deliberately out of the call-scoring view. He is not
// carrying a calling quota, and a single scored call was moving the team
// average that every rep is measured against: with him in, one call weighed the
// same as Charles's thirty.
//
// This exclusion lives here rather than in the widget on purpose. `team` below
// is summarise(calls) over this same list, so dropping him here also recomputes
// the team average, the rank and the grey comparison shape on the radar. Hiding
// him in the UI instead would have shown four reps compared against a five-rep
// average.
const REPS = ['118972528', '84179396', '90988586', '30458491']; // Jay, Michael, Charles, Drew

// Call types that count as "sales calls" for the default view. Check-ins are
// customer relationship calls where BANT is not the point, so they are hidden
// unless the viewer asks for everything.
const SALES_TYPES = new Set(['discovery', 'demo', 'follow_up']);

const PROPS = [
  'hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_source', 'hubspot_owner_id',
  'call_scored_at', 'call_score_overall', 'call_bant_score',
  'call_bant_budget', 'call_bant_authority', 'call_bant_need', 'call_bant_timing',
  'call_next_step_score', 'call_next_step_outcome',
  'call_intake_score', 'call_intake_covered', 'call_type',
  'call_coaching_notes', 'call_transcript_url', 'call_zoom_meeting_id', 'call_rep_owner_id'
];

const INTAKE_ITEMS = [
  { id: 'populations', label: 'Day-one populations' },
  { id: 'sis', label: 'SIS and audit engine' },
  { id: 'crm', label: 'CRM' },
  { id: 'writeback', label: 'Write-back needs' },
  { id: 'golive_gate', label: 'Go-live gate' },
  { id: 'live_date', label: 'Live definition and date' },
  { id: 'signer', label: 'Signer and decision process' },
  { id: 'incumbent', label: 'Incumbent and competitors' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hsSearch(token, body, attempt = 0) {
  const r = await fetch('https://api.hubapi.com/crm/v3/objects/meetings/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status === 429 && attempt < 6) {
    await sleep(Math.min(6000, 600 * Math.pow(1.5, attempt)) + Math.random() * 300);
    return hsSearch(token, body, attempt + 1);
  }
  if (!r.ok) throw new Error(`HubSpot meetings ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function fetchScoredMeetings(token, sinceMs) {
  const filters = [{ propertyName: 'call_scored_at', operator: 'HAS_PROPERTY' }];
  if (sinceMs) filters.push({ propertyName: 'hs_meeting_start_time', operator: 'GTE', value: String(sinceMs) });
  const out = [];
  let after;
  for (let p = 0; p < 20; p++) {
    const body = { filterGroups: [{ filters }], properties: PROPS, limit: 100, sorts: [{ propertyName: 'hs_meeting_start_time', direction: 'DESCENDING' }] };
    if (after) body.after = after;
    const r = await hsSearch(token, body);
    for (const it of (r.results || [])) out.push({ id: it.id, ...it.properties });
    if (!r.paging?.next?.after) break;
    after = r.paging.next.after;
  }
  return out;
}

const num = v => (v === null || v === undefined || v === '') ? null : Number(v);
const tri = v => v === 'asked' ? 100 : (v === 'partially' ? 50 : 0);
const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const round1 = v => v === null ? null : Math.round(v * 10) / 10;

// Monday 00:00 UTC of the week containing d
function weekStart(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function axesOf(calls) {
  return {
    budget: round1(avg(calls.map(c => tri(c.call_bant_budget)))),
    authority: round1(avg(calls.map(c => tri(c.call_bant_authority)))),
    need: round1(avg(calls.map(c => tri(c.call_bant_need)))),
    timing: round1(avg(calls.map(c => tri(c.call_bant_timing)))),
    next_step: round1(avg(calls.map(c => num(c.call_next_step_score)).filter(v => v !== null))),
    intake: round1(avg(calls.map(c => num(c.call_intake_score)).filter(v => v !== null)))
  };
}

function summarize(calls) {
  const overall = calls.map(c => num(c.call_score_overall)).filter(v => v !== null);
  const outcomes = {};
  for (const c of calls) { const o = c.call_next_step_outcome || 'none'; outcomes[o] = (outcomes[o] || 0) + 1; }
  const intakeCoverage = {};
  for (const it of INTAKE_ITEMS) intakeCoverage[it.id] = 0;
  for (const c of calls) for (const k of String(c.call_intake_covered || '').split(';').filter(Boolean)) if (k in intakeCoverage) intakeCoverage[k]++;
  return {
    calls: calls.length,
    overall: round1(avg(overall)),
    bant: round1(avg(calls.map(c => num(c.call_bant_score)).filter(v => v !== null))),
    next_step: round1(avg(calls.map(c => num(c.call_next_step_score)).filter(v => v !== null))),
    intake: round1(avg(calls.map(c => num(c.call_intake_score)).filter(v => v !== null))),
    booked_on_call_rate: calls.length ? round1((outcomes.booked_on_call || 0) / calls.length * 100) : null,
    outcomes,
    intake_coverage: Object.fromEntries(INTAKE_ITEMS.map(it => [it.id, calls.length ? round1(intakeCoverage[it.id] / calls.length * 100) : null])),
    axes: axesOf(calls)
  };
}

export default async function handler(req, res) {
  try {
    const token = process.env.DASHBOARD_TOKEN;
    const hsToken = process.env.HUBSPOT_TOKEN;
    if (!token || !hsToken) return res.status(500).json({ error: 'DASHBOARD_TOKEN or HUBSPOT_TOKEN not set' });
    const cookies = req.headers.cookie || '';
    const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
    const user = m ? await verifyAuthCookie(m[1], token) : null;
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
    const daysParam = url.searchParams.get('days') || '90';
    const days = daysParam === 'all' ? null : Math.max(7, Math.min(730, parseInt(daysParam, 10) || 90));
    const type = url.searchParams.get('type') === 'all' ? 'all' : 'sales';
    const sinceMs = days ? Date.now() - days * 86400000 : null;

    let all;
    try { all = await fetchScoredMeetings(hsToken, sinceMs); }
    catch (e) { return res.status(502).json({ error: 'hubspot_failed', detail: e.message }); }

    // Attribute each call to the rep who led it (call_rep_owner_id, falling back
    // to the meeting owner) and keep only the DS sales team.
    const calls = all
      .map(c => ({ ...c, rep_id: String(c.call_rep_owner_id || c.hubspot_owner_id || '') }))
      .filter(c => REPS.includes(c.rep_id))
      .filter(c => type === 'all' || SALES_TYPES.has(c.call_type || ''));

    const byRep = {};
    for (const id of REPS) byRep[id] = [];
    for (const c of calls) byRep[c.rep_id].push(c);

    const reps = REPS.map(id => ({ id, name: OWNER_ID_TO_NAME[id] || id, ...summarize(byRep[id]) }))
      .filter(r => r.calls > 0)
      .sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));

    // Weekly trend: average overall per rep per week, plus the team average
    const weeks = Array.from(new Set(calls.map(c => weekStart(c.hs_meeting_start_time)))).sort();
    const trend = weeks.map(w => {
      const inWeek = calls.filter(c => weekStart(c.hs_meeting_start_time) === w);
      const row = { week: w, team: round1(avg(inWeek.map(c => num(c.call_score_overall)).filter(v => v !== null))), team_calls: inWeek.length, reps: {} };
      for (const id of REPS) {
        const rc = inWeek.filter(c => c.rep_id === id);
        if (!rc.length) continue;
        row.reps[id] = {
          calls: rc.length,
          overall: round1(avg(rc.map(c => num(c.call_score_overall)).filter(v => v !== null))),
          bant: round1(avg(rc.map(c => num(c.call_bant_score)).filter(v => v !== null))),
          next_step: round1(avg(rc.map(c => num(c.call_next_step_score)).filter(v => v !== null))),
          intake: round1(avg(rc.map(c => num(c.call_intake_score)).filter(v => v !== null)))
        };
      }
      return row;
    });

    const recent = calls
      .slice()
      .sort((a, b) => new Date(b.hs_meeting_start_time) - new Date(a.hs_meeting_start_time))
      .slice(0, 60)
      .map(c => ({
        id: c.id,
        title: c.hs_meeting_title || 'Untitled call',
        date: c.hs_meeting_start_time,
        rep_id: c.rep_id,
        rep: OWNER_ID_TO_NAME[c.rep_id] || c.rep_id,
        call_type: c.call_type || 'other',
        overall: num(c.call_score_overall),
        bant: num(c.call_bant_score),
        next_step: num(c.call_next_step_score),
        intake: num(c.call_intake_score),
        bant_items: { budget: c.call_bant_budget, authority: c.call_bant_authority, need: c.call_bant_need, timing: c.call_bant_timing },
        outcome: c.call_next_step_outcome || 'none',
        intake_covered: String(c.call_intake_covered || '').split(';').filter(Boolean),
        coaching_notes: c.call_coaching_notes || '',
        transcript_url: c.call_transcript_url || null,
        hubspot_url: `https://app.hubspot.com/contacts/2675906/record/0-47/${c.id}`
      }));

    res.setHeader('Cache-Control', 'private, max-age=120');
    return res.status(200).json({
      generated_at: new Date().toISOString(),
      filters: { days: days || 'all', type },
      intake_items: INTAKE_ITEMS,
      rep_names: OWNER_ID_TO_NAME,
      my_owner_id: EMAIL_TO_OWNER_ID[user.email] || null,
      role: user.role,
      team: summarize(calls),
      reps,
      trend,
      recent,
      totals: { scored_in_hubspot: all.length, shown: calls.length }
    });
  } catch (e) {
    console.error('[/api/call-performance]', e);
    if (!res.headersSent) return res.status(500).json({ error: 'internal_error', detail: e.message || String(e) });
  }
}
