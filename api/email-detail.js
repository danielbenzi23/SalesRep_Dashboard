// /api/email-detail?thread_id=X — returns all emails in a thread with full bodies
// Used when user clicks a thread in the Emails tab.

import { verifyAuthCookie } from '../lib/auth.js';

async function hsSearch(token, body) {
  const r = await fetch('https://api.hubapi.com/crm/v3/objects/emails/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HubSpot emails ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function hsGet(token, id) {
  const url = `https://api.hubapi.com/crm/v3/objects/emails/${id}?properties=hs_email_subject,hs_email_status,hs_email_direction,hs_email_from_email,hs_email_to_email,hs_email_thread_id,hs_email_text,hs_email_html,hs_email_open_count,hs_email_click_count,hs_email_bounce_error_detail_message,hs_timestamp`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HubSpot email get ${r.status}: ${t.slice(0, 200)}`);
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
  const thread_id = url.searchParams.get('thread_id');
  const single_id = url.searchParams.get('id');

  if (!thread_id && !single_id) {
    return res.status(400).json({ error: 'thread_id or id required' });
  }

  // If single id, just fetch that one
  if (single_id) {
    try {
      const e = await hsGet(hsToken, single_id);
      return res.status(200).json({
        id: e.id,
        properties: e.properties
      });
    } catch (err) {
      return res.status(502).json({ error: 'hubspot_failed', detail: err.message });
    }
  }

  // Search emails with that thread_id
  try {
    const r = await hsSearch(hsToken, {
      filterGroups: [{ filters: [
        { propertyName: 'hs_email_thread_id', operator: 'EQ', value: thread_id }
      ]}],
      properties: [
        'hs_email_subject', 'hs_email_status', 'hs_email_direction',
        'hs_email_from_email', 'hs_email_to_email', 'hs_email_thread_id',
        'hs_email_text', 'hs_email_html',
        'hs_email_open_count', 'hs_email_click_count', 'hs_email_bounce_error_detail_message',
        'hs_timestamp'
      ],
      sorts: [{ propertyName: 'hs_timestamp', direction: 'ASCENDING' }],
      limit: 50
    });
    const emails = (r.results || []).map(e => ({
      id: e.id,
      subject: e.properties.hs_email_subject || '(no subject)',
      direction: e.properties.hs_email_direction || null,
      status: e.properties.hs_email_status || null,
      from: e.properties.hs_email_from_email || null,
      to: e.properties.hs_email_to_email || null,
      text: e.properties.hs_email_text || null,
      html: e.properties.hs_email_html || null,
      opens: parseInt(e.properties.hs_email_open_count || '0', 10),
      clicks: parseInt(e.properties.hs_email_click_count || '0', 10),
      when: e.properties.hs_timestamp || null,
      is_incoming: (e.properties.hs_email_direction || '').toUpperCase().includes('INCOMING')
    }));
    return res.status(200).json({ thread_id, emails });
  } catch (err) {
    return res.status(502).json({ error: 'hubspot_failed', detail: err.message });
  }
}
