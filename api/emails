// /api/emails — list of email engagements for the rep (last 30d)
// Grouped client-side. Returns metadata only (no body — body via /api/email-detail).

import { verifyAuthCookie, EMAIL_TO_OWNER_ID, OWNER_ID_TO_NAME } from '../lib/auth.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hsSearch(token, body, attempt = 0) {
  const r = await fetch('https://api.hubapi.com/crm/v3/objects/emails/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status === 429 && attempt < 6) {
    await sleep(Math.min(6000, 600 * Math.pow(1.5, attempt)));
    return hsSearch(token, body, attempt + 1);
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HubSpot emails ${r.status}: ${t.slice(0, 200)}`);
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

  // Resolve owner
  let ownerId;
  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  if (user.role === 'sales') {
    ownerId = EMAIL_TO_OWNER_ID[user.email];
    if (!ownerId) return res.status(403).json({ error: 'Your email is not mapped to a HubSpot owner' });
  } else {
    const requested = url.searchParams.get('ownerId');
    ownerId = (requested && OWNER_ID_TO_NAME[requested]) ? requested : '80532547';
  }

  const days = Math.min(parseInt(url.searchParams.get('days') || '30', 10), 90);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 200);
  const fromISO = new Date(Date.now() - days * 86400000).toISOString();

  const props = [
    'hs_email_subject', 'hs_email_status', 'hs_email_direction',
    'hs_email_from_email', 'hs_email_to_email', 'hs_email_thread_id',
    'hs_email_open_count', 'hs_email_click_count', 'hs_email_bounce_error_detail_message',
    'hs_email_post_send_status', 'hs_timestamp'
  ];

  // Fetch all email engagements for the rep in window
  const all = [];
  let after;
  for (let page = 0; page < 5 && all.length < limit; page++) {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerId },
        { propertyName: 'hs_timestamp', operator: 'GTE', value: fromISO }
      ]}],
      properties: props,
      sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
      limit: 100
    };
    if (after) body.after = after;
    const r = await hsSearch(hsToken, body);
    for (const it of (r.results || [])) all.push(it);
    if (!r.paging?.next?.after || all.length >= limit) break;
    after = r.paging.next.after;
  }

  // Group by thread for the UI
  const byThread = {};
  for (const e of all) {
    const p = e.properties || {};
    const tid = p.hs_email_thread_id || `single-${e.id}`;
    if (!byThread[tid]) {
      byThread[tid] = {
        thread_id: tid,
        emails: [],
        latest_when: null,
        latest_subject: '',
        sent_count: 0,
        reply_count: 0,
        open_count: 0,
        click_count: 0,
        bounce_count: 0,
        latest_status: null,
        recipients: new Set(),
        senders: new Set()
      };
    }
    const t = byThread[tid];
    const isIncoming = (p.hs_email_direction || '').toUpperCase().includes('INCOMING');
    t.emails.push({
      id: e.id,
      subject: p.hs_email_subject || '(no subject)',
      direction: p.hs_email_direction || null,
      status: p.hs_email_status || null,
      from: p.hs_email_from_email || null,
      to: p.hs_email_to_email || null,
      opens: parseInt(p.hs_email_open_count || '0', 10),
      clicks: parseInt(p.hs_email_click_count || '0', 10),
      bounced: !!p.hs_email_bounce_error_detail_message,
      when: p.hs_timestamp || null,
      is_incoming: isIncoming
    });
    if (isIncoming) {
      t.reply_count++;
      if (p.hs_email_from_email) t.senders.add(p.hs_email_from_email);
    } else {
      t.sent_count++;
      if (p.hs_email_to_email) t.recipients.add(p.hs_email_to_email);
    }
    t.open_count += parseInt(p.hs_email_open_count || '0', 10);
    t.click_count += parseInt(p.hs_email_click_count || '0', 10);
    if (p.hs_email_bounce_error_detail_message) t.bounce_count++;
    if (!t.latest_when || new Date(p.hs_timestamp) > new Date(t.latest_when)) {
      t.latest_when = p.hs_timestamp;
      t.latest_subject = p.hs_email_subject || t.latest_subject;
      t.latest_status = p.hs_email_status || t.latest_status;
    }
  }

  const threads = Object.values(byThread)
    .map(t => ({
      ...t,
      recipients: Array.from(t.recipients),
      senders: Array.from(t.senders)
    }))
    .sort((a, b) => new Date(b.latest_when || 0) - new Date(a.latest_when || 0));

  return res.status(200).json({
    count_emails: all.length,
    count_threads: threads.length,
    days,
    threads
  });
}
