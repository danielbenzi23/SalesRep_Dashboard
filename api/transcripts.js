// /api/transcripts — combined list + insight (was 2 functions)
// GET  /api/transcripts                                → list Confluence transcripts
// POST /api/transcripts { confluence_page_id, force? } → analyze with Claude, cache in Confluence

import { verifyAuthCookie } from '../lib/auth.js';
import {
  listChildPages,
  transcriptsParentId,
  fetchPage,
  htmlToText,
  findInsightChildPage,
  findAllInsightPages,
  fetchPageBody,
  createInsightChildPage,
  updateInsightChildPage,
  addLabels,
  extractInsightJson,
  ANALYZED_LABEL
} from '../lib/confluence.js';

export const config = { maxDuration: 60 };

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
    "budget_range_mentioned": "string or null",
    "timeline_mentioned": "string or null",
    "decision_maker_engaged": boolean,
    "competitor_mentioned": "string or null",
    "objections": ["array of strings"],
    "next_step_committed": "string or null"
  },
  "action_items": [{"owner": "string", "task": "string", "due": "ISO date or null"}],
  "company_mentioned": "string or null",
  "attendees_prospect": ["array of names"],
  "attendees_internal": ["array of names"],
  "key_quotes": [{"speaker": "string", "quote": "string, max 25 words", "why_it_matters": "string"}],
  "risk_flags": ["only if present: 'price-pushback','champion-leaving','no-budget','long-procurement','ghosting-risk','competitor-leading','scope-creep','timeline-slipping'"]
}

# Sentiment rubric

- positive: 0.4 to 1.0 — buying signals, champion enthusiastic, next steps locked
- neutral: -0.2 to 0.3 — engaged but no strong directional signal
- at_risk: -0.6 to -0.3 — objections, hesitation, competitor preferred
- negative: -1.0 to -0.6 — disinterest, no-fit, going with competitor

# Rules

- Output JSON only. Start with {. No preamble.
- Unknown: null / [] / false. Never invent.
- Keywords: business topics, not generic words.
- key_quotes max 3. action_items only with explicit commitment.
- Always respond in English.`;

async function analyze({ title, date, rep_email, transcript_text }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const userMsg =
    `Meeting title: ${title || 'Unknown'}\nDate: ${date || 'Unknown'}\nRep: ${rep_email || 'Unknown'}\n\n` +
    `--- TRANSCRIPT ---\n${transcript_text}\n--- END TRANSCRIPT ---\n\nReturn the JSON now.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
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
  if (!token) return res.status(500).json({ error: 'DASHBOARD_TOKEN not set' });
  const cookies = req.headers.cookie || '';
  const cm = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = cm ? await verifyAuthCookie(cm[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  // GET → list transcripts OR analytics
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
    const action = url.searchParams.get('action');

    // ===== ANALYTICS: aggregate all Claude Insights =====
    if (action === 'analytics') {
      // Strategy: (1) list all transcripts, (2) filter to analyzed by label,
      // (3) for each, find its "Claude Insights" child page via findInsightChildPage,
      // (4) extract JSON, (5) aggregate.
      // This is more reliable than a single-space CQL because it uses the same lookup
      // path that createInsightChildPage/addLabels use.

      let transcripts;
      try { transcripts = await listChildPages(transcriptsParentId(), { limit: 200 }); }
      catch (e) { return res.status(502).json({ error: 'confluence_failed', detail: e.message }); }

      const analyzedTranscripts = transcripts.filter(t => (t.labels || []).includes(ANALYZED_LABEL));

      // Concurrent lookup
      async function pLimit(items, concurrency, fn) {
        const results = new Array(items.length);
        let idx = 0;
        async function worker() {
          while (true) {
            const i = idx++;
            if (i >= items.length) return;
            try { results[i] = await fn(items[i], i); } catch (e) { results[i] = null; }
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
        return results;
      }

      const insightPages = await pLimit(analyzedTranscripts, 8, async (t) => {
        try {
          const child = await findInsightChildPage(t.page_id);
          if (!child) return null;
          return {
            body_html: child.body?.storage?.value || null,
            createdDate: t.created_date || null,
            transcript_title: t.title,
            transcript_url: t.url
          };
        } catch { return null; }
      });

      const insights = insightPages
        .filter(Boolean)
        .map(p => {
          const parsed = extractInsightJson(p.body_html);
          if (!parsed) return null;
          // Fill in title/url from transcript if not present in the insight
          if (!parsed.meeting_title) parsed.meeting_title = p.transcript_title;
          if (!parsed.source_url) parsed.source_url = p.transcript_url;
          return { ...parsed, _createdAt: p.createdDate };
        })
        .filter(Boolean);

      const total = insights.length;
      const sentimentCounts = { positive: 0, neutral: 0, at_risk: 0, negative: 0 };
      const stageSignals = {};
      const keywordCounts = {};
      const riskCounts = {};
      const competitorCounts = {};
      const objectionCounts = {};
      let budgetDiscussedCount = 0, timelineCount = 0, decisionMakerCount = 0;
      let sentimentScoreSum = 0, sentimentScoreCount = 0;

      for (const i of insights) {
        if (sentimentCounts[i.sentiment] !== undefined) sentimentCounts[i.sentiment]++;
        if (typeof i.sentiment_score === 'number') { sentimentScoreSum += i.sentiment_score; sentimentScoreCount++; }
        if (i.stage_signal) stageSignals[i.stage_signal] = (stageSignals[i.stage_signal] || 0) + 1;
        (i.keywords || []).forEach(k => { const kk = String(k).trim().toLowerCase(); if (kk) keywordCounts[kk] = (keywordCounts[kk] || 0) + 1; });
        (i.risk_flags || []).forEach(r => { const rr = String(r).trim(); if (rr) riskCounts[rr] = (riskCounts[rr] || 0) + 1; });
        const c = i.deal_signals?.competitor_mentioned;
        if (c && c.trim()) competitorCounts[c.trim()] = (competitorCounts[c.trim()] || 0) + 1;
        (i.deal_signals?.objections || []).forEach(o => { const oo = String(o).trim(); if (oo) objectionCounts[oo] = (objectionCounts[oo] || 0) + 1; });
        if (i.deal_signals?.budget_discussed) budgetDiscussedCount++;
        if (i.deal_signals?.timeline_mentioned) timelineCount++;
        if (i.deal_signals?.decision_maker_engaged) decisionMakerCount++;
      }

      const topN = (obj, n = 20) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ label: k, count: v }));

      // At-risk / negative meetings for quick action list
      const atRisk = insights
        .filter(i => i.sentiment === 'at_risk' || i.sentiment === 'negative')
        .sort((a, b) => new Date(b._createdAt || b.analyzed_at || 0) - new Date(a._createdAt || a.analyzed_at || 0))
        .slice(0, 15)
        .map(i => ({
          title: i.meeting_title || null,
          date: i.meeting_date || null,
          sentiment: i.sentiment,
          sentiment_score: i.sentiment_score,
          summary: i.summary,
          source_url: i.source_url || null,
          risk_flags: i.risk_flags || [],
          next_step: i.deal_signals?.next_step_committed || null
        }));

      // Open action items across all analyzed meetings
      const allActionItems = insights.flatMap(i =>
        (i.action_items || []).map(a => ({ ...a, meeting_title: i.meeting_title, source_url: i.source_url }))
      ).slice(0, 30);

      return res.status(200).json({
        total_transcripts: transcripts.length,
        total_analyzed_by_label: analyzedTranscripts.length,
        total_analyzed: total,
        avg_sentiment_score: sentimentScoreCount > 0 ? sentimentScoreSum / sentimentScoreCount : 0,
        sentiment_distribution: sentimentCounts,
        stage_signals: stageSignals,
        deal_signals_pct: {
          budget_discussed: total > 0 ? budgetDiscussedCount / total : 0,
          timeline_mentioned: total > 0 ? timelineCount / total : 0,
          decision_maker_engaged: total > 0 ? decisionMakerCount / total : 0
        },
        top_keywords: topN(keywordCounts, 30),
        top_risks: topN(riskCounts, 15),
        top_competitors: topN(competitorCounts, 15),
        top_objections: topN(objectionCounts, 15),
        at_risk_meetings: atRisk,
        recent_action_items: allActionItems
      });
    }

    // ===== LIST transcripts (with pagination) =====
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
    let pages;
    try { pages = await listChildPages(transcriptsParentId(), { limit }); }
    catch (e) { return res.status(502).json({ error: 'confluence_failed', detail: e.message }); }
    return res.status(200).json({
      count: pages.length,
      results: pages.map(p => {
        const labels = p.labels || [];
        const has_insight = labels.includes('claude-analyzed');
        const sentimentLabel = labels.find(l => l.startsWith('sentiment-'));
        const sentiment = sentimentLabel ? sentimentLabel.replace(/^sentiment-/, '').replace(/-/g, '_') : null;
        return {
          page_id: p.page_id, title: p.title, created_date: p.created_date,
          last_modified: p.last_modified, url: p.url, labels, has_insight, sentiment
        };
      })
    });
  }

  // POST → analyze a transcript
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const { confluence_page_id, force = false } = body || {};
    if (!confluence_page_id) return res.status(400).json({ error: 'confluence_page_id is required' });

    // Cache check
    let existing = null;
    if (!force) {
      try { existing = await findInsightChildPage(confluence_page_id); } catch (e) {}
      if (existing) {
        const cached = extractInsightJson(existing.body?.storage?.value);
        if (cached) return res.status(200).json({ ...cached, _cached: true });
      }
    }

    // Fetch + analyze
    let page;
    try { page = await fetchPage(confluence_page_id); }
    catch (e) { return res.status(502).json({ error: 'confluence_fetch_failed', detail: e.message }); }
    const transcript_text = htmlToText(page.html);
    if (!transcript_text || transcript_text.length < 100) {
      return res.status(422).json({ error: 'transcript_too_short', char_count: transcript_text.length });
    }
    let insight;
    try { insight = await analyze({ title: page.title, date: page.created, rep_email: user.email, transcript_text }); }
    catch (e) { return res.status(502).json({ error: 'analysis_failed', detail: e.message }); }

    const full = {
      page_id: page.page_id, meeting_title: page.title, meeting_date: page.created,
      source_url: page.url, model_used: 'claude-haiku-4-5',
      analyzed_at: new Date().toISOString(), analyzed_by: user.email, ...insight
    };
    try {
      if (existing && force) {
        await updateInsightChildPage(existing.id, existing.version?.number || 1, full);
      } else {
        await createInsightChildPage(confluence_page_id, full);
      }
      const labels = [ANALYZED_LABEL];
      if (insight.sentiment) labels.push(`sentiment-${insight.sentiment.replace(/_/g, '-')}`);
      await addLabels(confluence_page_id, labels);
    } catch (e) { full._save_error = e.message; }
    return res.status(200).json({ ...full, _cached: false });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
