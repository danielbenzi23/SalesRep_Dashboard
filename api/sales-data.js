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

  // Rolling windows for activity counts
  const sevenDaysAgo  = new Date(now.getTime() - 7  * 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

  const ownerFilter = { propertyName: 'hubspot_owner_id', operator: 'EQ', value: ownerId };
  const pipelineFilter = { propertyName: 'pipeline', operator: 'EQ', value: DS_PIPELINE };

  // Helper: count of an engagement object in a date window
  const countEng = async (obj, dateProp, fromISO, toISO) =>
    (await hsSearch(hsToken, obj, {
      filterGroups: [{ filters: [
        ownerFilter,
        { propertyName: dateProp, operator: 'BETWEEN', value: fromISO, highValue: toISO }
      ]}],
      limit: 1, properties: []
    })).total || 0;

  // ---- Parallel data fetches ----
  const [
    openDealsResp,
    wonYtdResp,
    wonQuarterResp,
    tasksDueTodayResp,
    meetingsThisWeekResp,
    recentWonResp,
    recentLostResp,
    lostYtdResp,
    // Activity counts (rolling 7d)
    callsWeek,
    emailsWeek,
    meetingsWeek,
    tasksWeek,
    // Activity counts (rolling 30d)
    calls30d,
    emails30d,
    meetings30d,
    tasks30d,
    // Recent activity feed (top 10 of each type)
    recentCallsResp,
    recentEmailsResp,
    recentMeetingsResp,
    recentTasksResp,
    // Full email engagement (30d) for metrics
    allEmailsResp
  ] = await Promise.all([
    // Open deals owned by rep, in DS pipeline, not closed
    fetchAll(hsToken, 'deals', [
      pipelineFilter,
      ownerFilter,
      { propertyName: 'dealstage', operator: 'NOT_IN', values: [...WON_STAGE_IDS, ...LOST_STAGE_IDS] }
    ], ['dealname', 'amount', 'dealstage', 'pipeline', 'hubspot_owner_id', 'notes_last_contacted', 'notes_last_updated', 'hs_lastmodifieddate', 'closedate', 'createdate'], [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }], 10),

    // Closed-won YTD (with createdate for cycle time)
    fetchAll(hsToken, 'deals', [
      pipelineFilter, ownerFilter,
      { propertyName: 'dealstage', operator: 'IN', values: WON_STAGE_IDS },
      { propertyName: 'closedate', operator: 'GTE', value: yStart.toISOString() }
    ], ['dealname', 'amount', 'closedate', 'createdate', 'hs_arr', 'hs_acv'], null, 10),

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
      [{ propertyName: 'closedate', direction: 'DESCENDING' }], 1),

    // All lost YTD (for win rate)
    fetchAll(hsToken, 'deals', [
      pipelineFilter, ownerFilter,
      { propertyName: 'dealstage', operator: 'IN', values: LOST_STAGE_IDS },
      { propertyName: 'closedate', operator: 'GTE', value: yStart.toISOString() }
    ], ['amount', 'closedate'], null, 10),

    // ---- Activity counts (last 7 days) ----
    countEng('calls',    'hs_timestamp',           sevenDaysAgo.toISOString(), now.toISOString()),
    countEng('emails',   'hs_timestamp',           sevenDaysAgo.toISOString(), now.toISOString()),
    countEng('meetings', 'hs_meeting_start_time',  sevenDaysAgo.toISOString(), now.toISOString()),
    countEng('tasks',    'hs_timestamp',           sevenDaysAgo.toISOString(), now.toISOString()),

    // ---- Activity counts (last 30 days) ----
    countEng('calls',    'hs_timestamp',           thirtyDaysAgo.toISOString(), now.toISOString()),
    countEng('emails',   'hs_timestamp',           thirtyDaysAgo.toISOString(), now.toISOString()),
    countEng('meetings', 'hs_meeting_start_time',  thirtyDaysAgo.toISOString(), now.toISOString()),
    countEng('tasks',    'hs_timestamp',           thirtyDaysAgo.toISOString(), now.toISOString()),

    // ---- Recent activity feed (last 10 of each type) ----
    fetchAll(hsToken, 'calls',    [ownerFilter, { propertyName: 'hs_timestamp', operator: 'GTE', value: thirtyDaysAgo.toISOString() }],
      ['hs_call_title', 'hs_call_body', 'hs_call_direction', 'hs_call_duration', 'hs_timestamp'],
      [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }], 1),
    fetchAll(hsToken, 'emails',   [ownerFilter, { propertyName: 'hs_timestamp', operator: 'GTE', value: thirtyDaysAgo.toISOString() }],
      ['hs_email_subject', 'hs_email_direction', 'hs_email_status', 'hs_timestamp'],
      [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }], 1),
    fetchAll(hsToken, 'meetings', [ownerFilter, { propertyName: 'hs_meeting_start_time', operator: 'GTE', value: thirtyDaysAgo.toISOString() }],
      ['hs_meeting_title', 'hs_meeting_outcome', 'hs_meeting_start_time'],
      [{ propertyName: 'hs_meeting_start_time', direction: 'DESCENDING' }], 1),
    fetchAll(hsToken, 'tasks',    [ownerFilter, { propertyName: 'hs_timestamp', operator: 'GTE', value: thirtyDaysAgo.toISOString() }],
      ['hs_task_subject', 'hs_task_status', 'hs_task_type', 'hs_timestamp'],
      [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }], 1),

    // ---- Full email engagement (30d) for open / click / reply / bounce metrics ----
    fetchAll(hsToken, 'emails', [
      ownerFilter,
      { propertyName: 'hs_timestamp', operator: 'GTE', value: thirtyDaysAgo.toISOString() }
    ], ['hs_email_subject', 'hs_email_status', 'hs_email_direction',
        'hs_email_open_count', 'hs_email_click_count', 'hs_email_bounce_error_detail_message',
        'hs_email_thread_id', 'hs_timestamp'],
      [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }], 10)
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
    .map(d => {
      const created = d.createdate ? new Date(d.createdate) : null;
      const closeAt = d.closedate ? new Date(d.closedate) : null;
      return {
        dealname: d.dealname || '(no name)',
        stage: STAGE_NAMES[d.dealstage] || d.dealstage,
        stage_id: d.dealstage,
        amount: parseFloat(d.amount) || 0,
        probability: STAGE_PROBABILITY[d.dealstage] ?? 0,
        weighted: (parseFloat(d.amount) || 0) * (STAGE_PROBABILITY[d.dealstage] ?? 0),
        create_date: d.createdate || null,
        close_date: d.closedate || null,
        last_modified: d.hs_lastmodifieddate || null,
        last_activity: d.notes_last_contacted || d.notes_last_updated || d.hs_lastmodifieddate || null,
        age_days:  created ? daysBetween(created, now) : null,
        days_to_close: closeAt ? daysBetween(now, closeAt) : null
      };
    })
    .sort((a, b) => b.amount - a.amount);

  // ---- Pipeline metrics (YTD) ----
  const wonYtdArr = wonYtdResp.map(d => d.properties);
  const lostYtdArr = lostYtdResp.map(d => d.properties);

  const wonCount = wonYtdArr.length;
  const lostCount = lostYtdArr.length;
  const totalClosed = wonCount + lostCount;
  const winRate = totalClosed > 0 ? wonCount / totalClosed : 0;

  const wonAmounts = wonYtdArr.map(d => parseFloat(d.amount) || 0).filter(v => v > 0);
  const avgDealSize = wonAmounts.length ? wonAmounts.reduce((s, v) => s + v, 0) / wonAmounts.length : 0;
  const sortedWon = wonAmounts.slice().sort((a, b) => a - b);
  const medianDealSize = sortedWon.length
    ? (sortedWon.length % 2 === 0
        ? (sortedWon[sortedWon.length / 2 - 1] + sortedWon[sortedWon.length / 2]) / 2
        : sortedWon[Math.floor(sortedWon.length / 2)])
    : 0;

  // ACV / FYCV: prefer hs_arr or hs_acv if populated, else fall back to amount
  const wonAcvs = wonYtdArr
    .map(d => parseFloat(d.hs_arr || d.hs_acv || d.amount) || 0)
    .filter(v => v > 0);
  const avgAcv = wonAcvs.length ? wonAcvs.reduce((s, v) => s + v, 0) / wonAcvs.length : 0;

  // Sales cycle: closedate - createdate for won deals
  const cycleDaysList = wonYtdArr.map(d => {
    if (!d.createdate || !d.closedate) return null;
    const created = new Date(d.createdate);
    const closed = new Date(d.closedate);
    return Math.max(0, Math.round((closed - created) / 86400000));
  }).filter(v => v != null);
  const avgCycleDays = cycleDaysList.length
    ? Math.round(cycleDaysList.reduce((s, v) => s + v, 0) / cycleDaysList.length)
    : 0;

  const pipelineMetrics = {
    win_rate: winRate,
    won_count: wonCount,
    lost_count: lostCount,
    avg_cycle_days: avgCycleDays,
    avg_deal_size: avgDealSize,
    median_deal_size: medianDealSize,
    avg_acv: avgAcv
  };

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

  // ---- Recent activity feed (merge + sort top 20) ----
  const feed = [];
  for (const c of recentCallsResp) {
    feed.push({
      type: 'call',
      subject: c.properties.hs_call_title || '(no title)',
      direction: c.properties.hs_call_direction || null,
      duration_sec: c.properties.hs_call_duration ? Math.round(+c.properties.hs_call_duration / 1000) : null,
      when: c.properties.hs_timestamp || null
    });
  }
  for (const e of recentEmailsResp) {
    feed.push({
      type: 'email',
      subject: e.properties.hs_email_subject || '(no subject)',
      direction: e.properties.hs_email_direction || null,
      status: e.properties.hs_email_status || null,
      when: e.properties.hs_timestamp || null
    });
  }
  for (const m2 of recentMeetingsResp) {
    feed.push({
      type: 'meeting',
      subject: m2.properties.hs_meeting_title || '(no title)',
      outcome: m2.properties.hs_meeting_outcome || null,
      when: m2.properties.hs_meeting_start_time || null
    });
  }
  for (const t of recentTasksResp) {
    feed.push({
      type: 'task',
      subject: t.properties.hs_task_subject || '(no subject)',
      status: t.properties.hs_task_status || null,
      task_type: t.properties.hs_task_type || null,
      when: t.properties.hs_timestamp || null
    });
  }
  feed.sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0));
  const recentActivityFeed = feed.slice(0, 20);

  // ---- Email performance (30d) ----
  // Counts: total outgoing (sent), opened (open_count>0 OR status OPEN/REPLIED), replied (status REPLIED OR thread has incoming reply), bounced (status BOUNCED)
  const emailObjs = (allEmailsResp || []).map(e => e.properties || {});
  const outgoing = emailObjs.filter(e => {
    const dir = (e.hs_email_direction || '').toUpperCase();
    return dir === 'EMAIL' || dir === 'OUTGOING' || dir === 'OUTGOING_EMAIL' || dir === '';
  });
  const incoming = emailObjs.filter(e => {
    const dir = (e.hs_email_direction || '').toUpperCase();
    return dir === 'INCOMING_EMAIL' || dir === 'INCOMING';
  });
  const sentCount = outgoing.length;
  const openedCount = outgoing.filter(e => {
    const status = (e.hs_email_status || '').toUpperCase();
    const opens = parseInt(e.hs_email_open_count || '0', 10) || 0;
    return opens > 0 || status === 'OPEN' || status === 'OPENED' || status === 'REPLIED';
  }).length;
  const clickedCount = outgoing.filter(e => (parseInt(e.hs_email_click_count || '0', 10) || 0) > 0).length;
  const repliedThreadIds = new Set(incoming.map(e => e.hs_email_thread_id).filter(Boolean));
  const repliedCount = outgoing.filter(e => {
    const status = (e.hs_email_status || '').toUpperCase();
    return status === 'REPLIED' || (e.hs_email_thread_id && repliedThreadIds.has(e.hs_email_thread_id));
  }).length;
  const bouncedCount = outgoing.filter(e => {
    const status = (e.hs_email_status || '').toUpperCase();
    return status === 'BOUNCED' || status === 'DROPPED' || !!e.hs_email_bounce_error_detail_message;
  }).length;
  const rate = (n) => sentCount > 0 ? n / sentCount : 0;

  const emailPerformance = {
    sent: sentCount,
    opened: openedCount,
    clicked: clickedCount,
    replied: repliedCount,
    bounced: bouncedCount,
    open_rate: rate(openedCount),
    click_rate: rate(clickedCount),
    reply_rate: rate(repliedCount),
    bounce_rate: rate(bouncedCount)
  };

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
    activity: {
      week:  { calls: callsWeek,  emails: emailsWeek,  meetings: meetingsWeek,  tasks: tasksWeek  },
      month: { calls: calls30d,   emails: emails30d,   meetings: meetings30d,   tasks: tasks30d   },
      email_performance: emailPerformance,
      recent_feed: recentActivityFeed
    },
    pipeline: { funnel, open_deals: openDealsTable, metrics: pipelineMetrics },
    recent: { won: recentWon, lost: recentLost },
    // Available reps for admin/manager dropdown
    available_reps: (user.role === 'admin' || user.role === 'manager')
      ? Object.entries(OWNER_ID_TO_NAME).map(([id, name]) => ({ ownerId: id, name }))
      : null
  });
}
