// /api/zoom — recent sales meetings and their call summary.
//   GET ?action=meetings&days=30&limit=5[&ownerId=…]
//   GET ?action=summary&meeting_id=<HubSpot meeting id>
//
// The page was written against Zoom's own API, but this project holds no Zoom
// credentials. Everything it needs is already in HubSpot: Zoom meetings are
// logged there as meeting records, and the n8n "Sales Call Scoring" workflow
// writes the score, coaching notes and transcript link onto them. So this
// endpoint answers in the shape the page expects, from HubSpot.

import { verifyAuthCookie, EMAIL_TO_OWNER_ID, OWNER_ID_TO_NAME, OWNER_ID_TO_EMAIL } from '../lib/auth.js';

export const config = { maxDuration: 30 };

const PORTAL = '2675906';
const PROPS = [
  'hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_source', 'hubspot_owner_id',
  'call_scored_at', 'call_score_overall', 'call_bant_score', 'call_next_step_score', 'call_next_step_outcome',
  'call_intake_score', 'call_type', 'call_coaching_notes', 'call_transcript_url', 'call_zoom_meeting_id', 'call_rep_owner_id'
];
const TYPE_LABELS = { discovery: 'Discovery', demo: 'Demo', follow_up: 'Follow-up', check_in: 'Check-in', other: 'Other' };

async function hs(token, path, init = {}, attempt = 0) {
  const r = await fetch(`https://api.hubapi.com${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  if (r.status === 429 && attempt < 5) {
    await new Promise(res => setTimeout(res, 500 * Math.pow(1.6, attempt)));
    return hs(token, path, init, attempt + 1);
  }
  return r;
}

const minutes = (start, end) => {
  const s = Date.parse(start || ''), e = Date.parse(end || '');
  return Number.isFinite(s) && Number.isFinite(e) && e > s ? Math.round((e - s) / 60000) : null;
};
const ownerOf = p => String(p.call_rep_owner_id || p.hubspot_owner_id || '');
const score = v => (v === null || v === undefined || v === '') ? null : Math.round(Number(v));

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  const hsToken = process.env.HUBSPOT_TOKEN;
  if (!token || !hsToken) return res.status(500).json({ error: 'tokens missing' });
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  res.setHeader('Cache-Control', 'private, max-age=120');
  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const action = url.searchParams.get('action') || 'meetings';

  try {
    if (action === 'meetings') {
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 180);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '5', 10) || 5, 1), 50);

      // Same owner rule as the rest of the workspace: a rep sees their own,
      // admins and managers pick a rep or the whole team.
      let owners;
      if (user.role === 'sales') {
        const own = EMAIL_TO_OWNER_ID[user.email];
        if (!own) return res.status(403).json({ error: 'Your email is not mapped to a HubSpot owner' });
        owners = [own];
      } else {
        const requested = url.searchParams.get('ownerId');
        owners = requested && OWNER_ID_TO_NAME[requested] ? [requested] : Object.keys(OWNER_ID_TO_NAME);
      }

      const now = Date.now();
      const r = await hs(hsToken, '/crm/v3/objects/meetings/search', {
        method: 'POST',
        body: JSON.stringify({
          filterGroups: [{ filters: [
            { propertyName: 'hubspot_owner_id', operator: 'IN', values: owners },
            { propertyName: 'hs_meeting_start_time', operator: 'BETWEEN', value: String(now - days * 86400000), highValue: String(now) }
          ] }],
          properties: PROPS, limit,
          sorts: [{ propertyName: 'hs_meeting_start_time', direction: 'DESCENDING' }]
        })
      });
      if (!r.ok) return res.status(502).json({ error: 'hubspot_meetings_failed', detail: (await r.text()).slice(0, 200) });
      const data = await r.json();
      const meetings = (data.results || []).map(it => {
        const p = it.properties || {};
        return {
          id: it.id,
          topic: p.hs_meeting_title || '(no title)',
          start_time: p.hs_meeting_start_time || null,
          duration: minutes(p.hs_meeting_start_time, p.hs_meeting_end_time),
          host_email: OWNER_ID_TO_EMAIL[ownerOf(p)] || OWNER_ID_TO_NAME[ownerOf(p)] || '',
          scored: !!p.call_scored_at
        };
      });
      return res.status(200).json({ days, total: data.total || meetings.length, meetings });
    }

    if (action === 'summary') {
      const id = url.searchParams.get('meeting_id') || url.searchParams.get('meeting_uuid') || '';
      if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'meeting_id must be a HubSpot meeting id' });
      const r = await hs(hsToken, `/crm/v3/objects/meetings/${id}?properties=${PROPS.join(',')}`);
      if (r.status === 404) return res.status(404).json({ error: 'meeting_not_found' });
      if (!r.ok) return res.status(502).json({ error: 'hubspot_meeting_failed', detail: (await r.text()).slice(0, 200) });
      const p = (await r.json()).properties || {};

      const details = [];
      const add = (label, summary) => { if (summary !== null && summary !== undefined && summary !== '') details.push({ label, summary: String(summary) }); };
      if (p.call_scored_at) {
        add('Call type', TYPE_LABELS[p.call_type] || p.call_type);
        const pts = (label, v) => { const n = score(v); if (n !== null) add(label, `${n} / 100`); };
        pts('Overall score', p.call_score_overall);
        pts('BANT', p.call_bant_score);
        pts('Next step', p.call_next_step_score);
        pts('Intake basics', p.call_intake_score);
        add('Next step outcome', p.call_next_step_outcome);
      }
      return res.status(200).json({
        id,
        start_time: p.hs_meeting_start_time || null,
        duration: minutes(p.hs_meeting_start_time, p.hs_meeting_end_time),
        host_email: OWNER_ID_TO_EMAIL[ownerOf(p)] || '',
        summary_title: p.hs_meeting_title || null,
        summary_overview: p.call_coaching_notes || null,
        summary_details: details,
        // Shown as a plain note, not an error: most meetings simply are not scored.
        note: p.call_scored_at ? null : 'This meeting has not been scored yet, so there are no coaching notes for it.',
        transcript_url: /^https:\/\//.test(p.call_transcript_url || '') ? p.call_transcript_url : null,
        hubspot_url: `https://app.hubspot.com/contacts/${PORTAL}/record/0-47/${id}`
      });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
