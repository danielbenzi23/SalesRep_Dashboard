// /api/playbook — historical marketing playbook synthesized from campaign performance
// Uses Postgres (ad_spend) + HubSpot (UTM contacts + deals) + Claude Haiku for narrative synthesis.

import pg from 'pg';
import { verifyAuthCookie } from '../lib/auth.js';

export const config = { maxDuration: 60 };

let pgPool = null;
function getPool() {
  if (!pgPool && process.env.DATABASE_URL) {
    pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3, idleTimeoutMillis: 30000
    });
  }
  return pgPool;
}
async function queryPg(sql, params) {
  const pool = getPool();
  if (!pool) return null;
  try { const r = await pool.query(sql, params); return r.rows; }
  catch (err) { console.error('[pg]', err.message); return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function hsSearch(token, obj, body, attempt = 0) {
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${obj}/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status === 429 && attempt < 5) {
    await sleep(Math.min(6000, 600 * Math.pow(1.5, attempt)));
    return hsSearch(token, obj, body, attempt + 1);
  }
  if (!r.ok) throw new Error(`HubSpot ${obj} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function fetchPaidContacts(token, fromISO) {
  const out = [];
  let after;
  for (let page = 0; page < 15 && out.length < 3000; page++) {
    const body = {
      filterGroups: [
        { filters: [
          { propertyName: 'createdate', operator: 'GTE', value: fromISO },
          { propertyName: 'utm_source', operator: 'HAS_PROPERTY' }
        ]},
        { filters: [
          { propertyName: 'createdate', operator: 'GTE', value: fromISO },
          { propertyName: 'hs_analytics_source', operator: 'IN', values: ['PAID_SEARCH', 'PAID_SOCIAL'] }
        ]}
      ],
      properties: ['utm_source', 'utm_medium', 'utm_campaign', 'hs_analytics_source', 'createdate', 'hs_object_id'],
      limit: 100
    };
    if (after) body.after = after;
    const r = await hsSearch(token, 'contacts', body);
    for (const c of (r.results || [])) out.push({ id: c.id, ...c.properties });
    if (!r.paging?.next?.after) break;
    after = r.paging.next.after;
  }
  return out;
}

function classifyPlatform(c) {
  const utmSource = (c.utm_source || '').toLowerCase();
  const utmMedium = (c.utm_medium || '').toLowerCase();
  const src = (c.hs_analytics_source || '').toUpperCase();
  const isPaid = ['cpc','ppc','paid','paidsocial','paid_social','cpm'].some(m => utmMedium.includes(m))
    || src === 'PAID_SEARCH' || src === 'PAID_SOCIAL';
  if (!isPaid) return null;
  if (utmSource === 'google' || utmSource === 'adwords') return 'google';
  if (utmSource === 'linkedin') return 'linkedin';
  if (['facebook','meta','instagram','fb','ig'].includes(utmSource)) return 'meta';
  if (src === 'PAID_SEARCH') return 'google';
  return 'other';
}

// Theme extractor: pulls a normalized theme from campaign names
function themeOf(campaignName) {
  if (!campaignName) return 'unknown';
  const n = campaignName.toLowerCase();
  if (n.includes('awareness')) return 'awareness';
  if (n.includes('retargeting') || n.includes('retarget')) return 'retargeting';
  if (n.includes('conversion') || n.includes('booking')) return 'conversion';
  if (n.includes('engagement')) return 'engagement';
  if (n.includes('follower')) return 'follower_growth';
  if (n.includes('videoviewwebinar') || n.includes('webinar')) return 'webinar';
  if (n.includes('hacks')) return 'topical_hacks';
  if (n.includes('naccap') || n.includes('event')) return 'events';
  if (n.includes('videohook') || n.includes('creatives') || n.includes('videos')) return 'creative_test';
  if (n.includes('[search]') || n.startsWith('[aw]')) {
    if (n.includes('core')) return 'search_core';
    if (n.includes('brand')) return 'search_brand';
    if (n.includes('competitor')) return 'search_competitor';
    return 'search_other';
  }
  if (n.includes('traffic')) return 'traffic';
  if (n.includes('lead')) return 'lead_gen';
  return 'other';
}

async function callClaude(payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const SYSTEM_PROMPT = `You are a senior growth marketing analyst for DegreeSight, a B2B SaaS company that sells online learning infrastructure to universities and continuing-education programs.

You will receive structured campaign performance data. Generate a HISTORICAL PLAYBOOK — a synthesis of what to do (and avoid) in future campaigns based on evidence in the data.

Return VALID JSON only, no preamble. Structure:

{
  "executive_summary": "2 sentence overview of the period's overall performance and biggest takeaway",
  "playbook_entries": [
    {
      "title": "string, name of the theme/pattern (e.g. 'LinkedIn Awareness campaigns', 'Google Search - Core keywords', 'Retargeting')",
      "period_analyzed": "string, e.g. 'Feb-Jun 2026'",
      "hypothesis": "string, 1-2 sentences: what were we trying to prove or achieve with this cluster of campaigns?",
      "key_metrics": [
        {"label": "Total spend", "value": "string with $"},
        {"label": "Impressions", "value": "string"},
        {"label": "Clicks", "value": "string"},
        {"label": "CTR", "value": "string %"},
        {"label": "CPC", "value": "string $"},
        {"label": "UTM contacts", "value": "string"},
        {"label": "CPL", "value": "string $ (or N/A)"}
      ],
      "what_worked": [
        {"campaign": "specific campaign name", "why": "1 sentence explanation of what worked"}
      ],
      "what_didnt_work": [
        {"campaign": "specific campaign name", "why": "1 sentence explanation of what didn't work"}
      ],
      "learnings": [
        "concrete learning 1",
        "concrete learning 2",
        "concrete learning 3"
      ],
      "recommended_next_step": "string, 1-2 sentences of concrete action for next quarter"
    }
  ]
}

Rules:
- Return 3 to 5 playbook entries covering the biggest themes in the data.
- Each entry must cite REAL campaign names from the data — never invent.
- Numbers must come from the data, not made up.
- what_worked / what_didnt_work: 2-4 items each. If no clear examples, use empty array.
- learnings: 2-4 items. Actionable and specific.
- recommended_next_step: concrete tactic + rationale.
- Be evidence-driven. If data is thin, say so in the entry.
- Focus on higher-education marketing context. DegreeSight sells LMS/SIS integration + transfer credit tools.`;

  const userMsg = `Analyze this campaign performance data and generate the historical playbook JSON:\n\n${JSON.stringify(payload, null, 2)}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const text = data.content?.[0]?.text || '';
  const clean = text.replace(/^```json\s*|\s*```$/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not return JSON: ' + text.slice(0, 200));
  return JSON.parse(m[0]);
}

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  const hsToken = process.env.HUBSPOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'DASHBOARD_TOKEN not set' });

  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const months = Math.min(parseInt(url.searchParams.get('months') || '12', 10), 24);
  const start = new Date();
  start.setUTCMonth(start.getUTCMonth() - months);
  const startISO = start.toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);

  // 1) Campaign-level performance
  const campaigns = await queryPg(`
    SELECT platform,
           COALESCE(campaign_name, campaign_id) AS campaign_name,
           SUM(spend)::numeric AS spend,
           SUM(impressions)::bigint AS impressions,
           SUM(clicks)::bigint AS clicks,
           SUM(conversions)::numeric AS conversions
    FROM public.vw_ad_spend
    WHERE date BETWEEN $1::date AND $2::date
    GROUP BY platform, campaign_name
    HAVING SUM(spend) > 0
    ORDER BY SUM(spend) DESC
    LIMIT 40`, [startISO, end]);

  // 2) Monthly totals per platform
  const monthly = await queryPg(`
    SELECT TO_CHAR(date_trunc('month', date), 'YYYY-MM') AS month,
           platform,
           SUM(spend)::numeric AS spend,
           SUM(impressions)::bigint AS impressions,
           SUM(clicks)::bigint AS clicks
    FROM public.vw_ad_spend
    WHERE date BETWEEN $1::date AND $2::date
    GROUP BY month, platform
    ORDER BY month, platform`, [startISO, end]);

  // 3) UTM contacts (only if HubSpot token available)
  let paidContacts = [];
  if (hsToken) {
    try { paidContacts = await fetchPaidContacts(hsToken, startISO); }
    catch (e) { console.error('[playbook] paid contacts fetch failed:', e.message); }
  }

  // Bucket UTM contacts per campaign + platform
  const utmByCampaign = {}; // `${platform}|${campaignLower}`
  const utmByPlatform = { google: 0, meta: 0, linkedin: 0, other: 0 };
  for (const c of paidContacts) {
    const platform = classifyPlatform(c);
    if (!platform) continue;
    utmByPlatform[platform] = (utmByPlatform[platform] || 0) + 1;
    const camp = (c.utm_campaign || '').trim().toLowerCase();
    if (camp) {
      const k = `${platform}|${camp}`;
      utmByCampaign[k] = (utmByCampaign[k] || 0) + 1;
    }
  }

  // Enrich campaigns with UTM contacts + derived metrics + theme
  const enriched = (campaigns || []).map(c => {
    const utm = utmByCampaign[`${c.platform}|${(c.campaign_name || '').toLowerCase()}`] || 0;
    const spend = parseFloat(c.spend) || 0;
    const impressions = parseInt(c.impressions) || 0;
    const clicks = parseInt(c.clicks) || 0;
    return {
      platform: c.platform,
      campaign: c.campaign_name,
      theme: themeOf(c.campaign_name),
      spend: +spend.toFixed(2),
      impressions,
      clicks,
      ctr_pct: impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : null,
      cpc: clicks > 0 ? +(spend / clicks).toFixed(2) : null,
      utm_contacts: utm,
      cpl: utm > 0 ? +(spend / utm).toFixed(2) : null,
      cvr_pct: clicks > 0 && utm > 0 ? +((utm / clicks) * 100).toFixed(2) : null,
      platform_conversions: parseFloat(c.conversions) || 0
    };
  });

  // Group by theme
  const byTheme = {};
  for (const c of enriched) {
    if (!byTheme[c.theme]) byTheme[c.theme] = { theme: c.theme, campaigns: [], spend: 0, clicks: 0, utm: 0, impressions: 0 };
    const t = byTheme[c.theme];
    t.campaigns.push(c);
    t.spend += c.spend;
    t.clicks += c.clicks;
    t.utm += c.utm_contacts;
    t.impressions += c.impressions;
  }
  const themes = Object.values(byTheme).map(t => ({
    ...t,
    spend: +t.spend.toFixed(2),
    ctr_pct: t.impressions > 0 ? +((t.clicks / t.impressions) * 100).toFixed(2) : null,
    cpc: t.clicks > 0 ? +(t.spend / t.clicks).toFixed(2) : null,
    cpl: t.utm > 0 ? +(t.spend / t.utm).toFixed(2) : null,
    cvr_pct: t.clicks > 0 && t.utm > 0 ? +((t.utm / t.clicks) * 100).toFixed(2) : null
  })).sort((a, b) => b.spend - a.spend);

  // Platform totals
  const platformTotals = {};
  for (const c of enriched) {
    if (!platformTotals[c.platform]) platformTotals[c.platform] = { platform: c.platform, spend: 0, clicks: 0, impressions: 0, utm: 0 };
    const p = platformTotals[c.platform];
    p.spend += c.spend; p.clicks += c.clicks; p.impressions += c.impressions; p.utm += c.utm_contacts;
  }

  const payload = {
    period: { start: startISO, end, months },
    totals: {
      spend: enriched.reduce((s, c) => s + c.spend, 0),
      impressions: enriched.reduce((s, c) => s + c.impressions, 0),
      clicks: enriched.reduce((s, c) => s + c.clicks, 0),
      utm_contacts: enriched.reduce((s, c) => s + c.utm_contacts, 0)
    },
    platform_totals: Object.values(platformTotals),
    utm_contacts_by_platform: utmByPlatform,
    campaigns_by_spend_desc: enriched.slice(0, 30),
    themes,
    monthly_trend: monthly || []
  };

  // Call Claude to generate playbook
  let playbook;
  try {
    playbook = await callClaude(payload);
  } catch (e) {
    return res.status(502).json({ error: 'claude_failed', detail: e.message, raw_data: payload });
  }

  return res.status(200).json({
    generated_at: new Date().toISOString(),
    period: payload.period,
    totals: payload.totals,
    ...playbook,
    // Include the raw underlying data so the frontend can also show quick stats
    _data: {
      themes: themes.map(t => ({ theme: t.theme, spend: t.spend, utm: t.utm, campaigns_count: t.campaigns.length, cpl: t.cpl, cvr_pct: t.cvr_pct })),
      platform_totals: Object.values(platformTotals),
      top_campaigns_by_spend: enriched.slice(0, 10)
    }
  });
}
