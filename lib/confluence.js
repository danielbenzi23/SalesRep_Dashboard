// Shared Confluence client. Reads CONFLUENCE_* env vars.

const BASE_URL    = process.env.CONFLUENCE_BASE_URL || 'https://degreesight.atlassian.net/wiki';
const EMAIL       = process.env.CONFLUENCE_EMAIL;
const API_TOKEN   = process.env.CONFLUENCE_API_TOKEN;
const PARENT_ID   = process.env.CONFLUENCE_TRANSCRIPTS_PARENT_ID || '1461846041';

function authHeader() {
  if (!EMAIL || !API_TOKEN) {
    throw new Error('CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN must be set');
  }
  const b64 = Buffer.from(`${EMAIL}:${API_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${b64}`, Accept: 'application/json' };
}

export function transcriptsParentId() {
  return PARENT_ID;
}

export function pageUrl(pageId) {
  return `${BASE_URL}/spaces/DEGREESITE/pages/${pageId}`;
}

// List child pages of a parent. Handles pagination internally up to a soft cap.
export async function listChildPages(parentId = PARENT_ID, { limit = 100 } = {}) {
  const all = [];
  let start = 0;
  const pageSize = Math.min(limit, 100);
  while (all.length < limit) {
    const url =
      `${BASE_URL}/rest/api/content/${parentId}/child/page` +
      `?limit=${pageSize}&start=${start}&expand=history,metadata.labels,version`;
    const r = await fetch(url, { headers: authHeader() });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Confluence listChildPages ${r.status}: ${txt.slice(0, 300)}`);
    }
    const data = await r.json();
    const results = data.results || [];
    for (const p of results) {
      all.push({
        page_id: p.id,
        title: p.title,
        created_date: p.history?.createdDate || null,
        last_modified: p.version?.when || p.history?.createdDate || null,
        labels: (p.metadata?.labels?.results || []).map(l => l.name),
        url: pageUrl(p.id)
      });
      if (all.length >= limit) break;
    }
    if (results.length < pageSize) break;
    start += pageSize;
  }
  return all;
}

// Fetch a single page's body in storage format. Returns { title, html, created, modified }.
export async function fetchPage(pageId) {
  const url =
    `${BASE_URL}/rest/api/content/${pageId}` +
    `?expand=body.storage,history,version`;
  const r = await fetch(url, { headers: authHeader() });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Confluence fetchPage ${r.status}: ${txt.slice(0, 300)}`);
  }
  const data = await r.json();
  return {
    page_id: data.id,
    title: data.title,
    html: data.body?.storage?.value || '',
    created: data.history?.createdDate || null,
    modified: data.version?.when || null,
    url: pageUrl(data.id)
  };
}

// Strip Confluence/HTML storage markup to plain text suitable for an LLM.
export function htmlToText(html) {
  if (!html) return '';
  return html
    // Confluence macros - drop their wrappers but keep inner text
    .replace(/<ac:structured-macro[^>]*>/gi, '')
    .replace(/<\/ac:structured-macro>/gi, '')
    .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, '')
    .replace(/<ac:rich-text-body[^>]*>/gi, '')
    .replace(/<\/ac:rich-text-body>/gi, '')
    .replace(/<ac:[^>]+>/gi, '')
    .replace(/<\/ac:[^>]+>/gi, '')
    .replace(/<ri:[^>]+>/gi, '')
    // Common HTML
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    // Entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '...')
    // Whitespace cleanup
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
