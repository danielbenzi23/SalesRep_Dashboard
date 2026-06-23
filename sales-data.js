// /api/sales-data — returns Today-tab data for one rep
// Query: ?ownerId=X (admin/manager only; sales role is forced to their own owner)
// Auth: cookie via lib/auth

import {
  verifyAuthCookie,
  EMAIL_TO_OWNER_ID,
  OWNER_ID_TO_NAME,
  REP_ANNUAL_QUOTA
} from '../lib/auth.js';

const DS_PIPELINE = '23928898';

const STAGE_PROBABILITY = {
  '56188255': 0.05, '56188256': 0.25, '56188257': 0.50,
  '1301242997': 0.20, '85090957': 0.90, '56188260': 1.00, '70398793': 0.01, '56188261': 0.00
};
const STAGE_NAMES = {
  '56188255': 'Qualify', '56188256': 'Discovery', '56188257': 'Quote',
  '1301242997': 'Driving to Close', '85090957': 'Contract',
  '56188260': 'Closed won', '70398793': 'Go to Green House', '56188261': 'Closed lost'
};
const WON_STAGE_IDS = ['56188260'];
const LOST_STAGE_IDS = ['56188261'];
const STALE_DAYS = 14;            // deal hasn't been touched in N days
const HOT_PROB_THRESHOLD = 0.85;  // Contract stage

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hsSearch(token, objectType, body, attempt = 0) {
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status === 429 && attempt < 6) {
    await sleep(Math.min(6000, 600 * Math.pow(1.5, attempt)) + Math.random() * 300);
    return hsSearch(token, objectType, body, attempt + 1);
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HubSpot ${objectType} ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchAll(token, objectType, filters, properties, sorts = null, maxPages = 5) {
  const out = [];
  let after;
  for (let p = 0; p < maxPages; p++) {
    const body = { filterGroups: [{ filters }], properties, limit: 100 };
    if (sorts) body.sorts = sorts;
    if (after) body.after = after;
    const r = await hsSearch(token, objectType, body);
    for (const it of (r.results || [])) out.push(it);
    if (!r.paging?.next?.after) break;
    after = r.paging.next.after;
  }
  return out;
}

function quarterRange(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const qStartMonth = Math.floor(m / 3) * 3;
  const start = new Date(Date.UTC(y, qStartMonth, 1));
  const end = new Date(Date.UTC(y, qStartMonth + 3, 0, 23, 59, 59));
  const qName = `Q${Math.floor(m / 3) + 1} ${y}`;
  return { start, end, name: qName };
}
function yearStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}
function startOfDayUTC(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function endOfDayUTC(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59));
}
function endOfWeekUTC(d = new Date()) {
  // Week ends Saturday
  const day = d.getUTCDay();
  const add = 6 - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 23, 59, 59));
}
function daysBetween(a, b) {
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  const hsToken = process.env.HUBSPOT_TOKEN;
  if (!token || !hsToken) {
    return res.status(500).json({ error: 'DASHBOARD_TOKEN or HUBSPOT_TOKEN not set' });
  }

  // Auth
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  // Resolve owner
  let ownerId;
  if (user.role === 'sales') {
    ownerId = EMAIL_TO_OWNER_ID[user.email];
    if (!ownerId) return res.status(403).json({ error: 'Your email is not mapped to a HubSpot owner' });
  } else {
    // admin/manager — can pass ?ownerId; default to first rep
    const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
    const requested = url.searchParams.get('ownerId');
    ownerId = (requested && OWNER_ID_TO_NAME[requested]) ? requested : '80532547';
  }

  const ownerName = OWNER_ID_TO_NAME[ownerId] || 'Unknown';
  const annualQuota = REP_ANNUAL_QUOTA[ownerId] || 0;

  const now = new Date();
  const todayStart = startOfDayUTC(now);
  const todayEnd = endOfDayUTC(now);
  const weekEnd = endOfWeekUTC(now);
  const { start: qStart, end: qEnd, name: qName } = quarterRange(now);
  const yStart = yearStart(now);

  const ownerFilter = { propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerId };
  const pipelineFilter = { propertyName: 'pipeline', operator: 'EQ', value: DS_PIPELINE };

  // ---- Parallel data fetches ----
  const [
    openDealsResp,
    wonYtdResp,
    wonQuarterResp,
    tasksDueTodayResp,
    meetingsThisWeekResp,
    recentWonResp,
    recentLostResp
  ] = await Promise.all([
    // Open deals owned by rep, in DS pipeline, not closed
    fetchAll(hsToken, 'deals', [
      pipelineFilter,
      ownerFilter,
      { propertyName: 'dealstage', operator: 'NOT_IN', values: [...WON_STAGE_IDS, ...LOST_STAGE_IDS] }
    ], ['dealname', 'amount', 'dealstage', 'pipeline', 'hubspot_owner_id', 'notes_last_contacted', 'notes_last_updated', 'hs_lastmodifieddate', 'closedate'], [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }], 10),

    // Closed-won YTD
    fetchAll(hsToken, 'deals', [
      pipelineFilter, ownerFilter,
      { propertyName: 'dealstage', operator: 'IN', values: WON_STAGE_IDS },
      { propertyName: 'closedate', operator: 'GTE', value: yStart.toISOString() }
    ], ['dealname', 'amount', 'closedate'], null, 10),

    // Closed-won this quarter
    fetchAll(hsToken, 'deals', [
      pipelineFilter, ownerFilter,
      { propertyName: 'dealstage', operator: 'IN', values: WON_STAGE_IDS },
      { propertyName: 'closedate', operator: 'BETWEEN', value: qStart.toISOString(), highValue: qEnd.toISOString() }
    ], ['dealname', 'amount', 'closedate'], null, 5),

    // Tasks due today (or overdue, not completed)
    fetchAll(hsToken, 'tasks', [
      ownerFilter,
      { propertyName: 'hs_task_status', operator: 'NEQ', value: 'COMPLETED' },
      { propertyName: 'hs_timestamp', operator: 'LTE', value: todayEnd.toISOString() }
    ], ['hs_task_subject', 'hs_task_priority', 'hs_task_status', 'hs_timestamp', 'hs_task_type'],
      [{ propertyName: 'hs_timestamp', direction: 'ASCENDING' }], 3),

    // Meetings this week (start..endOfWeek)
    fetchAll(hsToken, 'meetings', [
      ownerFilter,
      { propertyName: 'hs_meeting_start_time', operator: 'BETWEEN', value: startOfDayUTC(new Date(now.getTime() - 7 * 86400000)).toISOString(), highValue: weekEnd.toISOString() }
    ], ['hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_outcome'],
      [{ propertyName: 'hs_meeting_start_time', direction: 'DESCENDING' }], 3),

    // 5 most recent won
    fetchAll(hsToken, 'deals', [
      pipelineFilter, ownerFilter,
      { propertyName: 'dealstage', operator: 'IN', values: WON_STAGE_IDS }
    ], ['dealname', 'amount', 'closedate'],
      [{ propertyName: 'closedate', direction: 'DESCENDING' }], 1),

    // 5 most recent lost
    fetchAll(hsToken, 'deals', [
      pipelineFilter, ownerFilter,
      { propertyName: 'dealstage', operator: 'IN', values: LOST_STAGE_IDS }
    ], ['dealname', 'amount', 'closedate', 'closed_lost_reason'],
      [{ propertyName: 'closedate', direction: 'DESCENDING' }], 1)
  ]);

  // ---- Compute Today tab ----
  const openDeals = openDealsResp.map(d => d.properties);

  const openPipelineSum = openDeals.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
  const weightedForecast = openDeals.reduce((s, d) => {
    const a = parseFloat(d.amount) || 0;
    const p = STAGE_PROBABILITY[d.dealstage] ?? 0;
    return s + a * p;
  }, 0);

  const tasksList = tasksDueTodayResp.map(t => {
    const p = t.properties;
    const due = p.hs_timestamp ? new Date(p.hs_timestamp) : null;
    const overdue = due && due < todayStart;
    return {
      id: t.id,
      subject: p.hs_task_subject || '(no subject)',
      due_iso: p.hs_timestamp || null,
      due_label: due ? (overdue ? 'overdue' : due.toISOString().slice(11, 16) + ' UTC') : 'no due',
      priority: p.hs_task_priority || null,
      type: p.hs_task_type || null
    };
  });

  const meetingsThisWeekCount = meetingsThisWeekResp.length;

  // Needs attention: stale (>14d no activity) + hot (Contract or prob>=0.85)
  const needsAttention = openDeals
    .map(d => {
      const lastTouch = d.notes_last_contacted || d.notes_last_updated || d.hs_lastmodifieddate;
      const lastTouchDate = lastTouch ? new Date(lastTouch) : null;
      const days = lastTouchDate ? daysBetween(lastTouchDate, now) : null;
      const prob = STAGE_PROBABILITY[d.dealstage] ?? 0;
      const stale = days !== null && days >= STALE_DAYS;
      const hot = prob >= HOT_PROB_THRESHOLD;
      return {
        dealname: d.dealname || '(no name)',
        stage: STAGE_NAMES[d.dealstage] || d.dealstage,
        amount: parseFloat(d.amount) || 0,
        last_activity_iso: lastTouch || null,
        days_stale: days,
        probability: prob,
        flag: hot ? 'hot' : (stale ? 'stale' : null)
      };
    })
    .filter(d => d.flag)
    .sort((a, b) => {
      // Hot first, then most stale
      if (a.flag === 'hot' && b.flag !== 'hot') return -1;
      if (a.flag !== 'hot' && b.flag === 'hot') return 1;
      return (b.days_stale || 0) - (a.days_stale || 0);
    })
    .slice(0, 8);

  // Goal tracker
  const closedYtd = wonYtdResp.reduce((s, d) => s + (parseFloat(d.properties.amount) || 0), 0);
  const closedQuarter = wonQuarterResp.reduce((s, d) => s + (parseFloat(d.properties.amount) || 0), 0);
  const quarterQuota = annualQuota / 4;
  const daysLeftQuarter = Math.max(0, daysBetween(now, qEnd));

  // Recent won/lost
  const recentWon = recentWonResp.slice(0, 5).map(d => ({
    dealname: d.properties.dealname || '(no name)',
    amount: parseFloat(d.properties.amount) || 0,
    close_date: d.properties.closedate || null
  }));
  const recentLost = recentLostResp.slice(0, 5).map(d => ({
    dealname: d.properties.dealname || '(no name)',
    amount: parseFloat(d.properties.amount) || 0,
    close_date: d.properties.closedate || null,
    reason: d.properties.closed_lost_reason || null
  }));

  // Open deals table (for My pipeline tab)
  const openDealsTable = openDeals
    .map(d => ({
      dealname: d.dealname || '(no name)',
      stage: STAGE_NAMES[d.dealstage] || d.dealstage,
      stage_id: d.dealstage,
      amount: parseFloat(d.amount) || 0,
      probability: STAGE_PROBABILITY[d.dealstage] ?? 0,
      weighted: (parseFloat(d.amount) || 0) * (STAGE_PROBABILITY[d.dealstage] ?? 0),
      close_date: d.closedate || null,
      last_modified: d.hs_lastmodifieddate || null,
      last_activity: d.notes_last_contacted || d.notes_last_updated || d.hs_lastmodifieddate || null
    }))
    .sort((a, b) => b.amount - a.amount);

  // Funnel by stage
  const funnelOrder = ['56188255', '56188256', '56188257', '1301242997', '85090957'];
  const funnel = funnelOrder.map(sid => {
    const deals = openDeals.filter(d => d.dealstage === sid);
    return {
      stage: STAGE_NAMES[sid],
      count: deals.length,
      amount: deals.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0)
    };
  });

  return res.status(200).json({
    rep: { ownerId, name: ownerName, email: user.email, role: user.role, annualQuota },
    asOf: now.toISOString(),
    quarter: { name: qName, start: qStart.toISOString(), end: qEnd.toISOString(), days_left: daysLeftQuarter, quota: quarterQuota, closed: closedQuarter },
    today: {
      tasks_due_today: tasksList.length,
      meetings_this_week: meetingsThisWeekCount,
      open_pipeline: openPipelineSum,
      weighted_forecast: weightedForecast
    },
    tasks_for_today: tasksList.slice(0, 10),
    needs_attention: needsAttention,
    goal: {
      closed_ytd: closedYtd,
      annual_quota: annualQuota,
      percent_to_quota: annualQuota > 0 ? closedYtd / annualQuota : 0,
      gap: Math.max(0, annualQuota - closedYtd)
    },
    pipeline: { funnel, open_deals: openDealsTable },
    recent: { won: recentWon, lost: recentLost },
    // Available reps for admin/manager dropdown
    available_reps: (user.role === 'admin' || user.role === 'manager')
      ? Object.entries(OWNER_ID_TO_NAME).map(([id, name]) => ({ ownerId: id, name }))
      : null
  });
}
