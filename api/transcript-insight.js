// /api/transcript-insight
// POST { confluence_page_id }
// Fetches the page from Confluence, analyzes with Claude, returns the JSON.
// No database. No cache. Pure Confluence → Claude → response.

import { verifyAuthCookie } from '../lib/auth.js';
import {
  fetchPage,
  htmlToText,
  findInsightChildPage,
  createInsightChildPage,
  updateInsightChildPage,
  addLabels,
  extractInsightJson,
  ANALYZED_LABEL
} from '../lib/confluence.js';

const SYSTEM_PROMPT = `You are an expert sales-call analyst for DegreeSight, a B2B SaaS company that sells online learning infrastructure to universities, bootcamps, and continuing-education programs.

You will receive the full transcript of a sales call between a DegreeSight sales rep and one or more prospects/customers. Your job is to extract structured insights as valid JSON only — no preamble, no markdown fences, no commentary outside the JSON.

# Output schema (return EXACTLY this shape)

{
  "summary": "string, 2 sentences, what happened in the call",
  "sentiment": "positive" | "neutral" | "at_risk" | "negative",
  "sentiment_reason": "string, 1 sentence justifying the label",
  "sentiment_score": number from -1.0 (very negative) to 1.0 (very positive),
  "keywords": ["3 to 7 short topical tags, lowercase, hyphenated when multi-word"],
  "stage_signal": "exploring" | "evaluating" | "negotiating" | "closing" | "stalled" | "lost-signal",
  "deal_signals": {
    "budget_discussed": boolean,
    "budget_range_mentioned": "string or null, e.g. '50-80k'",
    "timeline_mentioned": "string or null, e.g. 'Q3 2026' or 'before fall semester'",
    "decision_maker_engaged": boolean,
    "competitor_mentioned": "string or null, name of competitor if any was discussed",
    "objections": ["array of strings, each one concrete objection raised"],
    "next_step_committed": "string or null, the explicit next action agreed on the call"
  },
  "action_items": [
    {"owner": "string", "task": "string", "due": "ISO date YYYY-MM-DD or null"}
  ],
  "company_mentioned": "string or null",
  "attendees_prospect": ["array of full names of prospect-side attendees"],
  "attendees_internal": ["array of full names of DegreeSight-side attendees"],
  "key_quotes": [
    {"speaker": "string", "quote": "string, verbatim, max 25 words", "why_it_matters": "string"}
  ],
  "risk_flags": ["only include if present: 'price-pushback','champion-leaving','no-budget','long-procurement','ghosting-risk','competitor-leading','scope-creep','timeline-slipping'"]
}

# Sentiment rubric (be conservative — do not inflate)

- "positive": clear buying signals, champion enthusiastic, next steps locked, no major objections
- "neutral": engaged conversation but no strong directional signal either way
- "at_risk": objections raised, hesitation, timeline pushed, competitor preferred, decision maker absent
- "negative": prospect signaled disinterest, no-fit, going with competitor, or explicit pushback on multiple fronts

sentiment_score ranges:
- positive: 0.4 to 1.0
- neutral: -0.2 to 0.3
- at_risk: -0.6 to -0.3
- negative: -1.0 to -0.6

# Rules

- Output JSON only. Start with {. No preamble, no markdown fences.
- Unknown fields: null for strings, [] for arrays, false for booleans. Never invent.
- Keywords are product/business topics, not generic words. Good: "pricing","lms-integration","fall-launch","competitor-coursera". Bad: "meeting","discussion","call".
- key_quotes: max 3, only the most decision-relevant. Skip if nothing stands out.
- action_items: only items with explicit commitment ("I'll send you X by Friday"). Don't fabricate.
- risk_flags empty if nothing observed. Don't pad.
- Always respond in English regardless of transcript language.`;

async function analyze({ title, date, rep_email, transcript_text }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const userMsg =
    `Meeting title: ${title || 'Unknown'}\n` +
    `Date: ${date || 'Unknown'}\n` +
    `Rep: ${rep_email || 'Unknown'}\n\n` +
    `--- TRANSCRIPT ---\n${transcript_text}\n--- END TRANSCRIPT ---\n\n` +
    `Return the JSON now.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }]
    })
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Anthropic ${r.status}: ${err.slice(0, 300)}`);
  }
  const data = await r.json();
  const text = data.content?.[0]?.text || '';
  const clean = text.replace(/^```json\s*|\s*```$/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not return JSON: ' + text.slice(0, 200));
  return JSON.parse(m[0]);
}

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return res.status(500).json({ error: 'DASHBOARD_TOKEN not set' });
  const cookies = req.headers.cookie || '';
  const cm = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = cm ? await verifyAuthCookie(cm[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { confluence_page_id, force = false } = body || {};
  if (!confluence_page_id) {
    return res.status(400).json({ error: 'confluence_page_id is required' });
  }

  // 1) Check Confluence for an existing "Claude Insights" child page (cache)
  let existingInsightPage = null;
  if (!force) {
    try {
      existingInsightPage = await findInsightChildPage(confluence_page_id);
    } catch (e) {
      console.error('[transcript-insight] cache lookup failed:', e.message);
    }
    if (existingInsightPage) {
      const cached = extractInsightJson(existingInsightPage.body?.storage?.value);
      if (cached) {
        return res.status(200).json({ ...cached, _cached: true });
      }
    }
  }

  // 2) Cache miss — fetch the actual transcript and analyze
  let page;
  try {
    page = await fetchPage(confluence_page_id);
  } catch (e) {
    return res.status(502).json({ error: 'confluence_fetch_failed', detail: e.message });
  }

  const transcript_text = htmlToText(page.html);
  if (!transcript_text || transcript_text.length < 100) {
    return res.status(422).json({ error: 'transcript_too_short', char_count: transcript_text.length });
  }

  let insight;
  try {
    insight = await analyze({
      title: page.title,
      date: page.created,
      rep_email: user.email,
      transcript_text
    });
  } catch (e) {
    return res.status(502).json({ error: 'analysis_failed', detail: e.message });
  }

  const fullInsight = {
    page_id: page.page_id,
    meeting_title: page.title,
    meeting_date: page.created,
    source_url: page.url,
    model_used: 'claude-haiku-4-5',
    analyzed_at: new Date().toISOString(),
    analyzed_by: user.email,
    ...insight
  };

  // 3) Save back to Confluence as child page + labels (don't fail the request if save fails)
  try {
    if (existingInsightPage && force) {
      // Update existing insight page
      const versionNum = existingInsightPage.version?.number || 1;
      await updateInsightChildPage(existingInsightPage.id, versionNum, fullInsight);
    } else {
      await createInsightChildPage(confluence_page_id, fullInsight);
    }
    const labels = [ANALYZED_LABEL];
    if (insight.sentiment) labels.push(`sentiment-${insight.sentiment.replace(/_/g, '-')}`);
    await addLabels(confluence_page_id, labels);
  } catch (e) {
    console.error('[transcript-insight] save to Confluence failed:', e.message);
    fullInsight._save_error = e.message;
  }

  return res.status(200).json({ ...fullInsight, _cached: false });
}
