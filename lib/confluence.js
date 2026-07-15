// Shared Confluence client. Reads CONFLUENCE_* env vars.

const BASE_URL    = process.env.CONFLUENCE_BASE_URL || 'https://degreesight.atlassian.net/wiki';
const EMAIL       = process.env.CONFLUENCE_EMAIL;
const API_TOKEN   = process.env.CONFLUENCE_API_TOKEN;
const PARENT_ID   = process.env.CONFLUENCE_TRANSCRIPTS_PARENT_ID || '1461846041';
const SPACE_KEY   = process.env.CONFLUENCE_SPACE_KEY || 'DEGREESITE';

// Confluence Cloud enforces UNIQUE page titles per space. To avoid every new
// transcript colliding with the first "Claude Insights" page, we suffix the
// title with the parent transcript's page ID → each transcript gets its own.
// LEGACY: Roosevelt (and any pre-fix transcript) has a page titled just
// "Claude Insights" — we still read/update those in place using the legacy name.
const INSIGHT_TITLE_LEGACY = 'Claude Insights';
export const INSIGHT_PAGE_TITLE = INSIGHT_TITLE_LEGACY; // legacy export, still referenced elsewhere
export function insightPageTitle(parentPageId) {
  return `${INSIGHT_TITLE_LEGACY} - ${parentPageId}`;
}
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

// Find ALL insight pages in the space (for analytics aggregation).
// Strategy: CQL `title ~ "Claude Insights"` matches BOTH the exact legacy title
// and the new "Claude Insights - <parentId>" pattern (fuzzy match on the two
// words). Client-side filter narrows to only real insight pages.
// Note: Lucene wildcards (*) don't work inside quoted phrases in CQL — must
// rely on the token-based fuzzy match instead.
export async function findAllInsightPages(limit = 200) {
  const cql = encodeURIComponent(`ancestor="${PARENT_ID}" AND title ~ "Claude Insights" AND type=page`);
  const url = `${BASE_URL}/rest/api/content/search?cql=${cql}&expand=body.storage,ancestors,history&limit=${Math.min(limit, 200)}`;
  const r = await fetch(url, { headers: authHeader() });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Confluence findAllInsightPages ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  // Client-side filter: keep only pages whose title is either exact "Claude Insights"
  // (legacy Roosevelt) or starts with "Claude Insights -" (new per-transcript pattern).
  const results = (data.results || []).filter(p => {
    const t = p.title || '';
    return t === INSIGHT_TITLE_LEGACY || t.startsWith(INSIGHT_TITLE_LEGACY + ' - ') || t.startsWith(INSIGHT_TITLE_LEGACY + '-');
  });
  return results;
}

// Given a page ID, fetch its body content (used for reading insight JSON)
export async function fetchPageBody(pageId) {
  const url = `${BASE_URL}/rest/api/content/${pageId}?expand=body.storage,version`;
  const r = await fetch(url, { headers: authHeader() });
  if (!r.ok) return null;
  return r.json();
}

// Find the insight child page of a transcript. Looks for BOTH the new unique
// title ("Claude Insights - <parentId>") AND the legacy title ("Claude Insights")
// so Roosevelt (which pre-dates the fix) still resolves. Returns page with body.
export async function findInsightChildPage(parentPageId) {
  const newTitle = insightPageTitle(parentPageId);

  const tryCql = async (title) => {
    const cql = encodeURIComponent(`parent="${parentPageId}" AND title="${title}" AND type=page`);
    const url = `${BASE_URL}/rest/api/content/search?cql=${cql}&expand=body.storage,version&limit=5`;
    try {
      const r = await fetch(url, { headers: authHeader() });
      if (r.ok) {
        const data = await r.json();
        if (data.results && data.results[0]) return data.results[0];
      }
    } catch {}
    return null;
  };

  const foundNew = await tryCql(newTitle);
  if (foundNew) return foundNew;
  const foundLegacy = await tryCql(INSIGHT_TITLE_LEGACY);
  if (foundLegacy) return foundLegacy;

  // Fallback: list children directly (bypasses CQL indexing lag)
  try {
    const children = await listChildPages(parentPageId, { limit: 50 });
    const found = children.find(c => c.title === newTitle || c.title === INSIGHT_TITLE_LEGACY);
    if (!found) return null;
    return await fetchPage(found.page_id);
  } catch {
    return null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Create the "Claude Insights" child page with JSON payload inside a code macro.
// Retries on 429 (Confluence rate limit) and 5xx transient errors.
export async function createInsightChildPage(parentPageId, insightJson, attempt = 0) {
  const payload = JSON.stringify(insightJson, null, 2).replace(/]]>/g, ']]]]><![CDATA[>');
  const storage =
    '<p>Auto-generated Claude analysis. Do not edit by hand.</p>' +
    '<ac:structured-macro ac:name="code" ac:schema-version="1">' +
    '<ac:parameter ac:name="language">json</ac:parameter>' +
    `<ac:plain-text-body><![CDATA[${payload}]]></ac:plain-text-body>` +
    '</ac:structured-macro>';

  const body = {
    type: 'page',
    // Unique title per parent to avoid the Confluence space-wide "duplicate title" 400
    title: insightPageTitle(parentPageId),
    space: { key: SPACE_KEY },
    ancestors: [{ id: String(parentPageId) }],
    body: { storage: { value: storage, representation: 'storage' } }
  };
  const r = await fetch(`${BASE_URL}/rest/api/content`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 4) {
    const retryAfter = parseInt(r.headers.get('retry-after') || '0', 10) * 1000;
    const wait = retryAfter || Math.min(8000, 1000 * Math.pow(2, attempt) + Math.random() * 500);
    await sleep(wait);
    return createInsightChildPage(parentPageId, insightJson, attempt + 1);
  }
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Confluence createInsight ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.json();
}

// Update an existing insight child page with new JSON.
// Preserves the current title (legacy "Claude Insights" or new "Claude Insights - <parentId>")
// to avoid triggering the space-wide duplicate check on rename.
export async function updateInsightChildPage(insightPageId, currentVersion, insightJson, currentTitle) {
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
    title: currentTitle || INSIGHT_TITLE_LEGACY,
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
// Retries on 429/5xx.
export async function addLabels(pageId, labels, attempt = 0) {
  const body = (Array.isArray(labels) ? labels : [labels])
    .filter(Boolean)
    .map(name => ({ prefix: 'global', name }));
  if (!body.length) return null;
  const r = await fetch(`${BASE_URL}/rest/api/content/${pageId}/label`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 4) {
    const retryAfter = parseInt(r.headers.get('retry-after') || '0', 10) * 1000;
    const wait = retryAfter || Math.min(8000, 1000 * Math.pow(2, attempt) + Math.random() * 500);
    await sleep(wait);
    return addLabels(pageId, labels, attempt + 1);
  }
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
