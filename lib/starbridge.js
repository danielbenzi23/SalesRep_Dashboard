// Starbridge REST API client
// Env: STARBRIDGE_API_KEY (generate at https://dashboard.starbridge.ai/settings/api-keys)
// Docs: https://hc.starbridge.ai/api-reference/rest/overview

const BASE = 'https://dashboard.starbridge.ai';

function getApiKey() {
  const key = process.env.STARBRIDGE_API_KEY;
  if (!key) throw new Error('STARBRIDGE_API_KEY not set');
  return key;
}

async function sb(path, { method = 'GET', query, body } = {}) {
  let url = `${BASE}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach(x => params.append(k, x));
      else params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error(`Starbridge ${r.status}: ${t.slice(0, 300)}`);
    err.status = r.status;
    err.body = t;
    throw err;
  }
  return r.json();
}

// Top recent signals across the org
export async function listTopRecentSignals({
  pageNumber = 1,
  pageSize = 50,
  sort = 'Hotness',                                // Hotness | Date
  filterType,                                      // array of RFP/Meeting/Purchase/Buyer/Contact/Signal/Conference/JobChange/Sequence*
  status,                                          // array of New/Actioned/Saved/Attending/Sponsoring/NotInterested
  relativeDatePeriodFrom = 'LastThirtyDays'
} = {}) {
  return sb('/api/external/feed/all/top-signals', {
    query: { pageNumber, pageSize, sort, filterType, status, relativeDatePeriodFrom }
  });
}

// Search buyer institutions by name
export async function searchBuyers(buyerName, { stateCode, limit = 10 } = {}) {
  return sb('/api/external/buyer/quick/search', {
    query: { buyerName, buyerStateCode: stateCode, limit }
  });
}

// Get the 3-section AI summary about a buyer
export async function getBuyerSummary(buyerId) {
  return sb(`/api/external/buyer/${encodeURIComponent(buyerId)}/summary`);
}

// List recent signals for a specific buyer
export async function listRecentBuyerSignals(buyerId, {
  pageNumber = 1,
  pageSize = 30,
  sort = 'Date',
  filterType,
  status,
  relativeDatePeriodFrom = 'LastSixMonths'
} = {}) {
  return sb(`/api/external/feed/buyer/${encodeURIComponent(buyerId)}/recent-signals`, {
    query: { pageNumber, pageSize, sort, filterType, status, relativeDatePeriodFrom }
  });
}
