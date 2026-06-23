// Shared auth helpers for middleware and API routes
// User → role mapping; role → allowed tabs

export const USERS = {
  'cody.bennett@degreesight.com': 'sales',
  'jay.fedje@degreesight.com': 'sales',
  'michael.cronin@degreesight.com': 'sales',
  'charles.ramos@degreesight.com': 'sales',
  'drew.melendres@degreesight.com': 'admin',
  'daniel.benzi@degreesight.com': 'admin',
  'beto.cervantes@degreesight.com': 'admin',
  'pedro.vitor@degreesight.com': 'admin',
  'david.cook@degreesight.com': 'manager'
};

// Tabs each role can see
export const ROLE_TABS = {
  admin:   ['overview', 'forecast', 'deals', 'activities', 'sources', 'ads', 'whatif'],
  sales:   ['overview', 'forecast', 'deals', 'activities', 'sources', 'whatif'],          // no ads
  manager: ['overview', 'forecast', 'deals', 'activities', 'sources', 'ads']               // no whatif
};

// Map sales-rep email → HubSpot owner ID (DS Sales Team)
export const EMAIL_TO_OWNER_ID = {
  'cody.bennett@degreesight.com':    '80532547',
  'jay.fedje@degreesight.com':       '118972528',
  'michael.cronin@degreesight.com':  '84179396',
  'charles.ramos@degreesight.com':   '90988586',
  'drew.melendres@degreesight.com':  '30458491'
};

// Reverse map for the sales-workspace dropdown (admins choose which rep to view)
export const OWNER_ID_TO_NAME = {
  '80532547':  'Cody Bennett',
  '118972528': 'Jay Fedje',
  '84179396':  'Michael Cronin',
  '90988586':  'Charles Ramos',
  '30458491':  'Drew Melendres'
};

// Per-rep annual quota (USD). Override later from env if you want different targets per rep.
export const REP_ANNUAL_QUOTA = {
  '80532547':  646880,
  '118972528': 646880,
  '84179396':  646880,
  '90988586':  646880,
  '30458491':  646880
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function hex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function signEmail(email, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(email));
  return hex(sig);
}

export async function verifyAuthCookie(cookieValue, secret) {
  if (!cookieValue) return null;
  const idx = cookieValue.lastIndexOf(':');
  if (idx < 0) return null;
  const email = cookieValue.slice(0, idx);
  const sig = cookieValue.slice(idx + 1);
  const expected = await signEmail(email, secret);
  // Constant-time compare (best effort in edge)
  if (sig.length !== expected.length) return null;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) mismatch |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch !== 0) return null;
  if (!USERS[email]) return null;
  return { email, role: USERS[email], tabs: ROLE_TABS[USERS[email]] || [] };
}

export function getRoleInfo(email) {
  const role = USERS[email];
  if (!role) return null;
  return { email, role, tabs: ROLE_TABS[role] || [] };
}
