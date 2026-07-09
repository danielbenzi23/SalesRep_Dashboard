// Shared Confluence client. Reads CONFLUENCE_* env vars.

const BASE_URL    = process.env.CONFLUENCE_BASE_URL || 'https://degreesight.atlassian.net/wiki';
const EMAIL       = process.env.CONFLUENCE_EMAIL;
const API_TOKEN   = process.env.CONFLUENCE_API_TOKEN;
const PARENT_ID   = process.env.CONFLUENCE_TRANSCRIPTS_PARENT_ID || '1461846041';
const SPACE_KEY   = process.env.CONFLUENCE_SPACE_KEY || 'DEGREESITE';

export const INSIGHT_PAGE_TITLE = 'Claude Insights';
export const ANALYZED_LABEL = 'claude-analyzed';

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

// Find ALL "Claude Insights" pages in the space (for analytics aggregation)
export async function findAllInsightPages(limit = 200) {
  const cql = encodeURIComponent(`title="${INSIGHT_PAGE_TITLE}" AND type=page AND space="${SPACE_KEY}"`);
  const url = `${BASE_URL}/rest/api/content/search?cql=${cql}&expand=body.storage,ancestors,history&limit=${Math.min(limit, 200)}`;
  const r = await fetch(url, { headers: authHeader() });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Confluence findAllInsightPages ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  return data.results || [];
}

// Find the "Claude Insights" child page of a transcript page. Returns the page with body.storage, or null.
export async function findInsightChildPage(parentPageId) {
  // Try CQL first (single call, includes body)
  const cql = encodeURIComponent(`parent="${parentPageId}" AND title="${INSIGHT_PAGE_TITLE}" AND type=page`);
  const cqlUrl = `${BASE_URL}/rest/api/content/search?cql=${cql}&expand=body.storage&limit=5`;
  try {
    const r = await fetch(cqlUrl, { headers: authHeader() });
    if (r.ok) {
      const data = await r.json();
      if (data.results && data.results[0]) return data.results[0];
    }
  } catch {}
  // Fallback: list children and fetch the matching one
  try {
    const children = await listChildPages(parentPageId, { limit: 50 });
    const found = children.find(c => c.title === INSIGHT_PAGE_TITLE);
    if (!found) return null;
    return await fetchPage(found.page_id);
  } catch {
    return null;
  }
}

// Create the "Claude Insights" child page with JSON payload inside a code macro.
export async function createInsightChildPage(parentPageId, insightJson) {
  const payload = JSON.stringify(insightJson, null, 2).replace(/]]>/g, ']]]]><![CDATA[>');
  const storage =
    '<p>Auto-generated Claude analysis. Do not edit by hand.</p>' +
    '<ac:structured-macro ac:name="code" ac:schema-version="1">' +
    '<ac:parameter ac:name="language">json</ac:parameter>' +
    `<ac:plain-text-body><![CDATA[${payload}]]></ac:plain-text-body>` +
    '</ac:structured-macro>';

  const body = {
    type: 'page',
    title: INSIGHT_PAGE_TITLE,
    space: { key: SPACE_KEY },
    ancestors: [{ id: String(parentPageId) }],
    body: { storage: { value: storage, representation: 'storage' } }
  };
  const r = await fetch(`${BASE_URL}/rest/api/content`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Confluence createInsight ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.json();
}

// Update an existing insight child page with new JSON (used by ?force=true).
export async function updateInsightChildPage(insightPageId, currentVersion, insightJson) {
  const payload = JSON.stringify(insightJson, null, 2).replace(/]]>/g, ']]]]><![CDATA[>');
  const storage =
    '<p>Auto-generated Claude analysis. Do not edit by hand.</p>' +
    '<ac:structured-macro ac:name="code" ac:schema-version="1">' +
    '<ac:parameter ac:name="language">json</ac:parameter>' +
    `<ac:plain-text-body><![CDATA[${payload}]]></ac:plain-text-body>` +
    '</ac:structured-macro>';

  const body = {
    version: { number: (currentVersion || 1) + 1 },
    type: 'page',
    title: INSIGHT_PAGE_TITLE,
    body: { storage: { value: storage, representation: 'storage' } }
  };
  const r = await fetch(`${BASE_URL}/rest/api/content/${insightPageId}`, {
    method: 'PUT',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Confluence updateInsight ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.json();
}

// Add one or more labels to a page. Safe if labels already exist.
export async function addLabels(pageId, labels) {
  const body = (Array.isArray(labels) ? labels : [labels])
    .filter(Boolean)
    .map(name => ({ prefix: 'global', name }));
  if (!body.length) return null;
  const r = await fetch(`${BASE_URL}/rest/api/content/${pageId}/label`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Confluence addLabels ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.json();
}

// Extract the JSON payload from an insight child page body.
export function extractInsightJson(pageBodyHtml) {
  if (!pageBodyHtml) return null;
  const m = pageBodyHtml.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
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
