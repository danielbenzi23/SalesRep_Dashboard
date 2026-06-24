// /api/transcripts — list meeting transcripts from Confluence
// No DB. Just lists the child pages of the Transcriptions parent page.

import { verifyAuthCookie } from '../lib/auth.js';
import { listChildPages, transcriptsParentId } from '../lib/confluence.js';

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return res.status(500).json({ error: 'DASHBOARD_TOKEN not set' });
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  const user = m ? await verifyAuthCookie(m[1], token) : null;
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  let pages;
  try {
    pages = await listChildPages(transcriptsParentId(), { limit });
  } catch (e) {
    return res.status(502).json({ error: 'confluence_failed', detail: e.message });
  }

  return res.status(200).json({
    count: pages.length,
    results: pages.map(p => {
      const labels = p.labels || [];
      const has_insight = labels.includes('claude-analyzed');
      const sentimentLabel = labels.find(l => l.startsWith('sentiment-'));
      const sentiment = sentimentLabel
        ? sentimentLabel.replace(/^sentiment-/, '').replace(/-/g, '_')
        : null;
      return {
        page_id:        p.page_id,
        title:          p.title,
        created_date:   p.created_date,
        last_modified:  p.last_modified,
        url:            p.url,
        labels,
        has_insight,
        sentiment
      };
    })
  });
}
