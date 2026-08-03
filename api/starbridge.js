// /api/starbridge — combined signals + buyer-search + buyer-summary (was 3 functions)
// GET /api/starbridge?action=signals  → top recent signals across org
// GET /api/starbridge?action=search&q=X → search buyers by name
// GET /api/starbridge?action=summary&buyerId=X → buyer AI summary + recent signals
// GET /api/starbridge?action=dossier&buyerId=X&buyerName=Y → full account dossier JSON
//   (Starbridge + HubSpot + Claude synthesis, follows Weekly Signal Dossiers rules)

import { verifyAuthCookie, OWNER_ID_TO_NAME } from '../lib/auth.js';
import {
  listTopRecentSignals,
  searchBuyers,
  getBuyerSummary,
  listRecentBuyerSignals,
  getBuyerAttributes
} from '../lib/starbridge.js';

export const config = { maxDuration: 60 };

// ---------- Google Drive client (service account, zero deps) ----------
// Env: GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY (keep \n escapes), DRIVE_FOLDER_ID
import crypto from 'node:crypto';

let _gdToken = null; // { token, exp }
function _b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function driveToken() {
  const email = process.env.GOOGLE_SA_EMAIL;
  let key = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !key) throw new Error('GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY not set');
  key = key.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  if (_gdToken && _gdToken.exp > now + 60) return _gdToken.token;
  const header = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = _b64url(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${_b64url(signer.sign(key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`
  });
  if (!r.ok) throw new Error(`Google token ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  _gdToken = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return _gdToken.token;
}
async function driveFetch(path, opts = {}) {
  const token = await driveToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
  });
  if (!r.ok) throw new Error(`Drive ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}
function _gdEsc(name) { return name.replace(/'/g, "\\'"); }
function rootFolderId() {
  const id = process.env.DRIVE_FOLDER_ID;
  if (!id) throw new Error('DRIVE_FOLDER_ID not set');
  return id;
}
async function findChild(parentId, name, { folderOnly = false } = {}) {
  const q = encodeURIComponent(
    `'${parentId}' in parents and name = '${_gdEsc(name)}' and trashed = false` +
    (folderOnly ? ` and mimeType = 'application/vnd.google-apps.folder'` : '')
  );
  const r = await driveFetch(`/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=5`);
  return ((await r.json()).files || [])[0] || null;
}
async function ensureFolder(parentId, name) {
  const existing = await findChild(parentId, name, { folderOnly: true });
  if (existing) return existing.id;
  const r = await driveFetch(`/files?supportsAllDrives=true&fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  return (await r.json()).id;
}
async function listFolders(parentId) {
  const q = encodeURIComponent(`'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const r = await driveFetch(`/files?q=${q}&fields=files(id,name,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=100`);
  return ((await r.json()).files || []);
}
// Upload (create or overwrite-by-name) into a folder. content: Buffer.
async function uploadFile(folderId, name, content, mimeType) {
  const existing = await findChild(folderId, name);
  const token = await driveToken();
  const boundary = '-------dsb' + Date.now();
  const metadata = existing ? { name } : { name, parents: [folderId] };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--`)
  ]);
  const uploadUrl = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`;
  const r = await fetch(uploadUrl, {
    method: existing ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!r.ok) throw new Error(`Drive upload ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function downloadFile(fileId) {
  const r = await driveFetch(`/files/${fileId}?alt=media&supportsAllDrives=true`);
  return Buffer.from(await r.arrayBuffer());
}
function folderUrl(folderId) { return `https://drive.google.com/drive/folders/${folderId}`; }
// ---------- end Google Drive client ----------

// ---------- HubSpot helpers (dossier) ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function hsSearch(hsToken, obj, body, attempt = 0) {
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${obj}/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.status === 429 && attempt < 5) {
    await sleep(Math.min(5000, 500 * Math.pow(1.6, attempt)));
    return hsSearch(hsToken, obj, body, attempt + 1);
  }
  if (!r.ok) throw new Error(`HubSpot ${obj} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function hsAssociations(hsToken, fromType, fromId, toType) {
  const r = await fetch(`https://api.hubapi.com/crm/v4/objects/${fromType}/${fromId}/associations/${toType}?limit=50`, {
    headers: { Authorization: `Bearer ${hsToken}` }
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map(x => x.toObjectId);
}

async function hsBatchRead(hsToken, obj, ids, properties) {
  if (!ids.length) return [];
  const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${obj}/batch/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: ids.slice(0, 50).map(id => ({ id: String(id) })), properties })
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map(x => ({ id: x.id, ...x.properties }));
}

// Fetch HubSpot company + contacts + deals + resolve ownership per the
// Weekly Signal Dossiers routing rules (company owner supersedes contact;
// closed-won = skip flag; open deal = keep owner; else Cody→Charles).
async function fetchHubSpotCompanyData(hsToken, schoolName) {
  const out = { company: null, contacts: [], deals: [], owner_name: null, destination_owner: null, deal_state: 'none', skip_reason: null };
  try {
    const cr = await hsSearch(hsToken, 'companies', {
      filterGroups: [
        { filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: schoolName }] }
      ],
      properties: ['name', 'domain', 'hubspot_owner_id', 'lifecyclestage', 'city', 'state'],
      limit: 3
    });
    const company = (cr.results || [])[0];
    if (!company) return out;
    out.company = { id: company.id, ...company.properties };
    const ownerId = company.properties.hubspot_owner_id;
    out.owner_name = OWNER_ID_TO_NAME[ownerId] || (ownerId ? `Owner ${ownerId}` : null);

    // Contacts + deals in parallel
    const [contactIds, dealIds] = await Promise.all([
      hsAssociations(hsToken, 'companies', company.id, 'contacts'),
      hsAssociations(hsToken, 'companies', company.id, 'deals')
    ]);
    const [contacts, deals] = await Promise.all([
      hsBatchRead(hsToken, 'contacts', contactIds, ['firstname', 'lastname', 'email', 'jobtitle']),
      hsBatchRead(hsToken, 'deals', dealIds, ['dealname', 'dealstage', 'amount', 'closedate', 'pipeline'])
    ]);
    out.contacts = contacts.map(c => ({
      name: [c.firstname, c.lastname].filter(Boolean).join(' '),
      email: c.email || null, title: c.jobtitle || null
    })).filter(c => c.name || c.email);
    out.deals = deals;

    // Deal-state routing (WON stage id 56188260, LOST 56188261 on DS pipeline;
    // fall back to name matching for other pipelines)
    const isWon = d => d.dealstage === '56188260' || /won/i.test(d.dealstage || '');
    const isLost = d => d.dealstage === '56188261' || /lost/i.test(d.dealstage || '');
    if (deals.some(isWon)) { out.deal_state = 'closed_won'; out.skip_reason = 'Company already has a closed-won deal'; }
    else if (deals.some(d => !isWon(d) && !isLost(d))) out.deal_state = 'open';
    else if (deals.length) out.deal_state = 'closed_lost_only';

    // Reassignment: Cody → Charles only when no open deal
    if (out.deal_state === 'open' || out.deal_state === 'closed_won') {
      out.destination_owner = out.owner_name;
    } else {
      out.destination_owner = (out.owner_name === 'Cody Bennett') ? 'Charles Ramos' : (out.owner_name || null);
    }
  } catch (e) {
    out._error = e.message;
  }
  return out;
}

// ---------- Server-side dossier HTML + PDF (for the automatic weekly cron) ----------
const DS_LOGO_URL = 'https://2675906.fs1.hubspotusercontent-na1.net/hubfs/2675906/Ed%20Awards/DegreeSight.png';
function escS(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Mirrors dossierMarkup() in sales.html — keep the two in sync when the layout changes.
function serverDossierHtml(d) {
  const doc = d.dossier || {};
  const initials = (d.school_name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const repName = 'DegreeSight';
  const themeColors = { hot: '#C0472E', warm: '#B4700F', neutral: '#12305B' };
  const bannerBg = { hot: '#FDF0EC', warm: '#FDF6E8', neutral: '#EEF2F9' };
  const theme = doc.theme || 'neutral';
  const stat = (s) => `<div style="flex:1;min-width:110px;background:#fff;border:1px solid #E3E8F0;border-radius:10px;padding:12px 14px;"><div style="font:700 26px/1 Inter,sans-serif;color:${s.warn ? '#C0472E' : '#0A1F3C'};">${s.n || ''}</div><div style="font-size:10.5px;color:#5B6B82;margin-top:4px;line-height:1.35;">${s.l || ''}</div></div>`;
  const stackRow = (r) => `<div style="display:flex;justify-content:space-between;padding:8px 12px;border-top:1px solid #E9EDF3;font-size:12px;"><span style="color:#42526B;">${escS(r.label)}</span><b style="color:${r.ok ? '#0A7D68' : '#0A1F3C'};">${escS(r.value)}</b></div>`;
  const person = (p) => {
    const badgeColors = { owner: 'background:#E5F5F2;color:#0A7D68;', stale: 'background:#FDF0EC;color:#C0472E;', neutral: 'background:#EEF2F9;color:#12305B;' };
    return `<div style="background:#fff;border:1px solid #E3E8F0;border-radius:10px;padding:14px 16px;margin-bottom:8px;"><div style="display:flex;justify-content:space-between;align-items:center;"><b style="font-size:14px;color:#0A1F3C;">${escS(p.name)}</b><span style="font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:3px 9px;border-radius:999px;${badgeColors[p.badge_type] || badgeColors.neutral}">${escS(p.badge)}</span></div><div style="font-size:11.5px;color:#42526B;margin-top:2px;">${escS(p.role)}</div><div style="font-size:11.5px;color:#5B6B82;margin-top:6px;line-height:1.45;">${p.note || ''}</div>${p.contact ? `<div style="font-size:11px;color:#1034E5;margin-top:6px;">${escS(p.contact)}</div>` : ''}</div>`;
  };
  const chip = (c) => `<span style="display:inline-block;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:4px 12px;font-size:10px;color:#fff;margin:3px 4px 3px 0;"><b>${escS(c.src)}</b> · ${escS(c.detail)}</span>`;
  const watchRow = (w, i) => `<div style="display:flex;gap:12px;background:#FDF6E8;border-radius:10px;padding:12px 14px;margin-bottom:8px;align-items:flex-start;"><div style="width:22px;height:22px;border-radius:50%;background:#B4700F;color:#fff;font:700 11px/22px Inter,sans-serif;text-align:center;flex:none;">${i + 1}</div><div style="font-size:12px;color:#42526B;line-height:1.5;">${w}</div></div>`;
  const secTitle = (t) => `<div style="display:flex;align-items:center;gap:8px;margin:18px 0 10px;"><div style="width:18px;height:2px;background:#15B4A6;"></div><div style="font:700 11px Inter,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#0A7D68;">${t}</div></div>`;
  const body = `
    <div class="dossier-page" style="background:#fff;overflow:hidden;">
      <div style="background:#0A1F3C;padding:22px 30px;display:flex;justify-content:space-between;align-items:center;">
        <img src="${DS_LOGO_URL}" alt="DegreeSight" style="height:34px;filter:brightness(0) invert(1);" />
        <div style="text-align:right;">
          <div style="font-size:9px;letter-spacing:.22em;color:#15B4A6;font-weight:700;">GO-TO-MARKET INTELLIGENCE</div>
          <div style="font:700 19px Inter,sans-serif;color:#fff;">Account Dossier</div>
          <span style="display:inline-block;margin-top:5px;border:1px solid #15B4A6;color:#15B4A6;border-radius:999px;font-size:9px;font-weight:700;letter-spacing:.14em;padding:3px 12px;">${escS((doc.tag || 'ACCOUNT REVIEW').toUpperCase())}</span>
        </div>
      </div>
      <div style="padding:14px 30px;border-bottom:1px solid #E9EDF3;font-size:11px;color:#5B6B82;">
        Prepared by <b style="color:#0A1F3C;">${escS(repName)}</b>&nbsp;&nbsp;For <b style="color:#0A1F3C;">${escS(d.prepared_for || 'Sales team')}</b>&nbsp;&nbsp;Compiled <b style="color:#0A1F3C;">${escS(d.compiled_date || '')}</b>
      </div>
      <div style="padding:20px 30px 6px;display:flex;gap:16px;align-items:center;">
        <div style="width:54px;height:54px;border:1px solid #E3E8F0;border-radius:12px;display:grid;place-items:center;font:700 18px Inter,sans-serif;color:#12305B;flex:none;">${initials}</div>
        <div><div style="font:700 26px Inter,sans-serif;color:#0A1F3C;">${escS(d.school_name)}</div><div style="font-size:12px;color:#5B6B82;margin-top:2px;">${doc.context_line || ''}</div></div>
      </div>
      <div style="margin:16px 30px;background:${bannerBg[theme]};border:1px solid ${themeColors[theme]}33;border-radius:12px;padding:14px 18px;display:flex;gap:14px;align-items:flex-start;">
        <span style="background:${themeColors[theme]};color:#fff;font:700 9px Inter,sans-serif;letter-spacing:.1em;border-radius:999px;padding:4px 12px;white-space:nowrap;flex:none;margin-top:2px;">${escS((doc.banner_label || 'WHY IT MATTERS').toUpperCase())}</span>
        <div style="font-size:12px;color:#42526B;line-height:1.55;">${doc.banner_text || ''}</div>
      </div>
      <div style="padding:0 30px;">
        ${secTitle('Read this first')}
        <div style="border-left:3px solid #15B4A6;background:#F7FAF9;border-radius:0 10px 10px 0;padding:14px 18px;">
          <div style="font:700 10px Inter,sans-serif;letter-spacing:.12em;color:#0A7D68;margin-bottom:8px;">THREE THINGS THAT DECIDE THIS ACCOUNT</div>
          <ol style="margin:0;padding-left:18px;font-size:12px;color:#42526B;line-height:1.55;">${(doc.tldr || []).map(t => `<li style="margin-bottom:6px;">${t}</li>`).join('')}</ol>
        </div>
        ${secTitle('The numbers')}
        <div style="display:flex;gap:10px;flex-wrap:wrap;">${(doc.stats || []).map(stat).join('')}</div>
        ${secTitle('Tech stack & what matters')}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
          <div style="border:1px solid #E3E8F0;border-radius:10px;overflow:hidden;"><div style="background:#0A1F3C;color:#fff;font:700 10px Inter,sans-serif;letter-spacing:.1em;padding:8px 12px;">SYSTEMS ON FILE</div>${(doc.stack || []).map(stackRow).join('')}</div>
          <div style="font-size:12px;color:#42526B;line-height:1.55;">${doc.stack_matters || ''}</div>
        </div>
        ${secTitle('Who is on file')}
        ${(doc.people || []).length ? (doc.people || []).map(person).join('') : '<div style="font-size:12px;color:#5B6B82;">No contacts on file in HubSpot. Candidly, sourcing an enrollment or registrar contact is step one.</div>'}
      </div>
      <div style="background:#0A1F3C;margin-top:18px;padding:16px 30px 20px;">
        <div style="font:700 10px Inter,sans-serif;letter-spacing:.14em;color:#15B4A6;margin-bottom:8px;">HOW THIS DOSSIER WAS ASSEMBLED</div>
        <div>${(doc.provenance_chips || []).map(chip).join('')}</div>
        <div style="font-size:11px;color:rgba(255,255,255,.85);line-height:1.55;margin-top:8px;">${doc.provenance_point || ''}</div>
      </div>
    </div>
    <div class="dossier-page" style="background:#fff;overflow:hidden;padding:8px 30px 22px;">
      ${secTitle('Why they would want DegreeSight')}
      <ul style="list-style:none;margin:0;padding:0;">${(doc.fit || []).map(f => `<li style="display:flex;gap:10px;font-size:12px;color:#42526B;line-height:1.55;margin-bottom:8px;"><span style="width:8px;height:8px;border-radius:50%;background:#15B4A6;flex:none;margin-top:5px;"></span><span>${f}</span></li>`).join('')}</ul>
      ${secTitle('Watch for')}
      ${(doc.watch || []).map(watchRow).join('')}
      ${secTitle('Bring to the first call')}
      <ul style="margin:0;padding-left:18px;font-size:12px;color:#42526B;line-height:1.6;">${(doc.bring || []).map(b => `<li style="margin-bottom:6px;">${b}</li>`).join('')}</ul>
      <div style="background:#0A1F3C;border-radius:12px;padding:20px 24px;margin-top:18px;">
        <div style="font-size:14px;line-height:1.6;color:#fff;"><b style="color:#15B4A6;">${escS(doc.pull_highlight)}</b> ${doc.pull_body || ''}</div>
        <div style="font-size:10px;color:rgba(255,255,255,.55);margin-top:10px;">Strategic framing · ${escS(d.school_name)} dossier</div>
      </div>
      <div style="display:flex;justify-content:space-between;border-top:1px solid #E9EDF3;margin-top:16px;padding-top:10px;font-size:10px;color:#5B6B82;">
        <span>${doc.sources_footer || 'Sources: Starbridge, HubSpot.'}</span>
        <span><b style="color:#0A1F3C;">DegreeSight</b> · Auto-generated weekly</span>
      </div>
    </div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
      * { box-sizing: border-box; margin: 0; }
      body { font-family: Inter, -apple-system, sans-serif; }
      .dossier-page { page-break-after: always; width: 100%; }
      .dossier-page:last-child { page-break-after: auto; }
    </style></head><body>${body}</body></html>`;
}

// Headless-Chrome PDF (puppeteer-core + @sparticuz/chromium). Dynamic import so
// interactive requests never pay the cold-start cost.
async function renderPdfBuffer(html) {
  const [{ default: chromium }, { default: puppeteer }] = await Promise.all([
    import('@sparticuz/chromium'),
    import('puppeteer-core')
  ]);
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    return Buffer.from(await page.pdf({ format: 'letter', printBackground: true, margin: { top: '0.3in', bottom: '0.3in', left: '0.3in', right: '0.3in' } }));
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- Slack bot (DM per rep) ----------
// Env: SLACK_BOT_TOKEN (xoxb-, scopes: chat:write, im:write, users:read, users:read.email)
//      SLACK_TEST_EMAIL (optional) — when set, EVERY DM is rerouted to this user with a [TEST] prefix
async function slackApi(method, payload) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN not set');
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}`);
  return j;
}
async function slackDmByEmail(email, text) {
  const testEmail = process.env.SLACK_TEST_EMAIL;
  const target = testEmail || email;
  const prefix = testEmail && testEmail !== email ? `🧪 *[TEST — would go to ${email}]*\n` : '';
  const u = await slackApi('users.lookupByEmail', { email: target });
  const conv = await slackApi('conversations.open', { users: u.user.id });
  await slackApi('chat.postMessage', { channel: conv.channel.id, text: prefix + text, unfurl_links: false });
}

// Full dossier generation (Starbridge + HubSpot + Claude). Shared by the
// interactive ?action=dossier route and the automatic weekly cron.
async function generateDossier(buyerId, buyerName) {
  const hsToken = process.env.HUBSPOT_TOKEN;
  const [summaryRes, signalsRes, attributesRes, hubspotRes] = await Promise.allSettled([
    getBuyerSummary(buyerId),
    listRecentBuyerSignals(buyerId, { pageSize: 15 }),
    getBuyerAttributes(buyerId),
    hsToken && buyerName ? fetchHubSpotCompanyData(hsToken, buyerName) : Promise.resolve(null)
  ]);
  const summary = summaryRes.status === 'fulfilled' ? summaryRes.value : null;
  const signals = signalsRes.status === 'fulfilled' ? signalsRes.value : [];
  const attributes = attributesRes.status === 'fulfilled' ? attributesRes.value : {};
  const hubspot = hubspotRes.status === 'fulfilled' ? hubspotRes.value : null;
  const skip = hubspot && hubspot.deal_state === 'closed_won';
  const claudePayload = {
    school_name: buyerName,
    starbridge_summary: summary,
    starbridge_attributes: attributes,
    recent_signals: (Array.isArray(signals) ? signals : (signals?.result || [])).slice(0, 10),
    hubspot: hubspot ? {
      company: hubspot.company,
      owner: hubspot.owner_name,
      destination_owner: hubspot.destination_owner,
      deal_state: hubspot.deal_state,
      contacts: hubspot.contacts.slice(0, 10),
      deals: hubspot.deals.map(d => ({ name: d.dealname, stage: d.dealstage, amount: d.amount }))
    } : null
  };
  let dossier = null, claude_error = null;
  try { dossier = await claudeDossier(claudePayload); }
  catch (e) { claude_error = e.message; }
  return {
    buyerId,
    school_name: buyerName,
    skip_recommended: skip,
    skip_reason: hubspot?.skip_reason || null,
    prepared_for: hubspot?.destination_owner || null,
    owner_name: hubspot?.owner_name || null,
    deal_state: hubspot?.deal_state || 'unknown',
    hubspot_contacts: hubspot?.contacts || [],
    compiled_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    dossier,
    claude_error,
    _sources: {
      starbridge_summary: !!summary,
      starbridge_attributes: Object.keys(attributes || {}).length > 0,
      signals_count: (Array.isArray(signals) ? signals : (signals?.result || [])).length,
      hubspot_company: !!hubspot?.company,
      hubspot_error: hubspot?._error || null
    }
  };
}

// Claude synthesis — builds the dossier copy JSON following the writing rules.
async function claudeDossier(payload) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const prompt = `You are writing a DegreeSight account dossier. DegreeSight sells AI-powered transfer credit evaluation and degree-audit for higher ed (two motions: Inbound student-facing transferability check; Insight registrar-grade automated credit evaluation). Partner references: Indiana Wesleyan, Cumberlands, Youngstown State, Roosevelt University.

WRITING RULES (hard):
- Concise, direct, plain language. NO em dashes anywhere. No corporate filler.
- Use "candidly" rather than "honestly".
- Be honest about gaps and risk. Flag hard budgets and unclear ownership.
- Inline <b>...</b> tags allowed for emphasis. Word limits below are strict.

DATA:
${JSON.stringify(payload, null, 2)}

Return VALID JSON only:
{
  "theme": "hot" | "warm" | "neutral",
  "tag": "Signal-Driven" | "Inbound" | "Account Review",
  "context_line": "≤12 words: target type · institution type · City, ST",
  "banner_label": "Why it's hot" | "Why it matters",
  "banner_text": "≤60 words. Lead with how it surfaced and why now. <b> allowed.",
  "tldr": ["3 items, each ≤35 words, start with <b>bolded takeaway.</b>"],
  "stats": [{"n": "value", "l": "≤8 word label", "warn": false}, "... exactly 4"],
  "stack": [{"label": "System category", "value": "Product name", "ok": true}, "... up to 4; ok=true when it is in DegreeSight connector set (Banner, Colleague, PeopleSoft, Workday, Slate, TargetX, Salesforce, DegreeWorks, uAchieve, Canvas, D2L, Blackboard, Moodle)"],
  "stack_matters": "≤55 words starting with <b>Why it matters:</b>",
  "people": [{"name": "", "badge": "Best entry|Verify title|Champion", "badge_type": "owner|stale|neutral", "role": "", "note": "≤25 words", "contact": "email"}, "... up to 2, ONLY from real HubSpot contacts provided"],
  "provenance_chips": [{"src": "Starbridge", "detail": "≤6 words"}, {"src": "HubSpot", "detail": "≤6 words"}],
  "provenance_point": "≤45 words starting with <b>The point of the integration:</b>",
  "fit": ["3 items ≤35 words each, start with <b>bold claim.</b> Why they would want DegreeSight."],
  "watch": ["3-4 items ≤30 words each, start with <b>Bolded risk.</b> Budget, ownership, timing, competitors."],
  "bring": ["3 items ≤25 words each, start with <b>Bolded item.</b> What to bring to the first call."],
  "pull_highlight": "2-4 word teal phrase",
  "pull_body": "≤55 words closing strategic framing",
  "sources_footer": "Sources: Starbridge, HubSpot. Figures Starbridge/IPEDS-derived; confirm in conversation."
}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const txt = (j.content?.[0]?.text || '').replace(/^```(?:json)?\s*/gim, '').replace(/\s*```\s*$/gim, '');
  const s = txt.indexOf('{'), e2 = txt.lastIndexOf('}');
  if (s < 0 || e2 <= s) throw new Error('Claude did not return JSON');
  let jsonStr = txt.slice(s, e2 + 1).replace(/,(\s*[\}\]])/g, '$1');
  return JSON.parse(jsonStr);
}

export default async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return res.status(500).json({ error: 'DASHBOARD_TOKEN not set' });
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/(?:^|;\s*)auth=([^;]+)/);
  let user = m ? await verifyAuthCookie(m[1], token) : null;
  // Cron / self-chained invocations authenticate with CRON_SECRET instead of a cookie
  // (Vercel Cron sends "Authorization: Bearer $CRON_SECRET" automatically when the env is set).
  const cronSecret = process.env.CRON_SECRET;
  const authHdr = req.headers.authorization || '';
  const urlSecret = new URL(req.url, 'http://x').searchParams.get('secret');
  const isCron = !!cronSecret && (authHdr === `Bearer ${cronSecret}` || urlSecret === cronSecret);
  if (!user && isCron) user = { email: 'cron@degreesight.com', role: 'system' };
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  let action = url.searchParams.get('action') || 'signals';
  let cronSubOverride = null;
  // Vercel Cron cannot carry query params in the path — it hits /api/starbridge
  // bare, authenticated with CRON_SECRET and tagged with x-vercel-cron-schedule.
  // Route those invocations straight into the weekly pipeline.
  if (!url.searchParams.get('action') && (req.headers['x-vercel-cron-schedule'] || isCron)) {
    action = 'weekly';
    cronSubOverride = 'cron';
  }

  try {
    // ===== SEARCH =====
    if (action === 'search') {
      const q = url.searchParams.get('q');
      const state = url.searchParams.get('state') || undefined;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '15', 10), 50);
      if (!q || q.trim().length < 2) {
        return res.status(400).json({ error: 'q (search term) required, min 2 chars' });
      }
      const data = await searchBuyers(q.trim(), { stateCode: state, limit });
      return res.status(200).json(data);
    }

    // ===== BUYER SUMMARY =====
    if (action === 'summary') {
      const buyerId = url.searchParams.get('buyerId');
      if (!buyerId) return res.status(400).json({ error: 'buyerId required' });

      // Always fetch attributes in parallel — they work for any buyer
      const [summaryRes, signalsRes, attributesRes] = await Promise.allSettled([
        getBuyerSummary(buyerId),
        listRecentBuyerSignals(buyerId, { pageSize: 20 }),
        getBuyerAttributes(buyerId)
      ]);

      let summary = null, summary_error = null;
      if (summaryRes.status === 'fulfilled') summary = summaryRes.value;
      else {
        const err = summaryRes.reason;
        if (err.status === 404) summary_error = 'no_summary_yet';
        else summary_error = err.message;
      }
      let signals = [], signals_error = null;
      if (signalsRes.status === 'fulfilled') signals = signalsRes.value;
      else signals_error = signalsRes.reason.message;

      const attributes = attributesRes.status === 'fulfilled' ? attributesRes.value : {};

      return res.status(200).json({ buyerId, summary, summary_error, signals, signals_error, attributes });
    }

    // ===== DOSSIER: full account dossier (Starbridge + HubSpot + Claude) =====
    if (action === 'dossier') {
      const buyerId = url.searchParams.get('buyerId');
      const buyerName = url.searchParams.get('buyerName') || '';
      if (!buyerId) return res.status(400).json({ error: 'buyerId required' });
      return res.status(200).json(await generateDossier(buyerId, buyerName));
    }

    // ===== LEAD DOSSIER: resolve a HubSpot company name → Starbridge buyer → dossier =====
    if (action === 'lead_dossier') {
      const company = (url.searchParams.get('company') || '').trim();
      if (company.length < 2) return res.status(400).json({ error: 'company required' });
      let buyers;
      try { buyers = await searchBuyers(company, { limit: 5 }); }
      catch (e) { return res.status(502).json({ error: `Starbridge search failed: ${e.message}` }); }
      const list = Array.isArray(buyers) ? buyers : (buyers?.result || buyers?.buyers || []);
      const match = list[0];
      if (!match) return res.status(404).json({ error: 'no_starbridge_match', company });
      const buyerId = match.id || match.buyerId;
      const buyerName = match.name || match.buyerName || company;
      const d = await generateDossier(buyerId, buyerName);
      d._matched_buyer = { id: buyerId, name: buyerName, searched: company };
      return res.status(200).json(d);
    }

    // ===== DRAFT EMAIL: Claude writes a personalized outreach draft for a lead =====
    if (action === 'draft_email') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
      const lead = {
        name: url.searchParams.get('name') || '',
        email: url.searchParams.get('email') || '',
        title: url.searchParams.get('title') || '',
        company: url.searchParams.get('company') || '',
        score: url.searchParams.get('score') || '',
        tier: url.searchParams.get('tier') || '',
        stage: url.searchParams.get('stage') || ''
      };
      const repName = url.searchParams.get('rep') || 'the DegreeSight team';
      // Light company context from Starbridge (best effort, never blocks the draft)
      let sbContext = null;
      if (lead.company && lead.company.length > 2) {
        try {
          const buyers = await searchBuyers(lead.company, { limit: 1 });
          const list = Array.isArray(buyers) ? buyers : (buyers?.result || buyers?.buyers || []);
          if (list[0]) {
            const [sum, sigs] = await Promise.allSettled([
              getBuyerSummary(list[0].id || list[0].buyerId),
              listRecentBuyerSignals(list[0].id || list[0].buyerId, { pageSize: 5 })
            ]);
            sbContext = {
              summary: sum.status === 'fulfilled' ? sum.value : null,
              recent_signals: sigs.status === 'fulfilled' ? (Array.isArray(sigs.value) ? sigs.value : (sigs.value?.result || [])).slice(0, 5) : []
            };
          }
        } catch {}
      }
      const prompt = `You write a first-touch sales email for ${repName}, a DegreeSight sales rep. DegreeSight sells AI-powered transfer credit evaluation and degree-audit for higher ed (Inbound student-facing transferability check; Insight registrar-grade automated credit evaluation). Partner references: Indiana Wesleyan, Cumberlands, Youngstown State, Roosevelt University.

WRITING RULES (hard):
- Plain text only, NO html, NO markdown. NO em dashes. Use "candidly" rather than "honestly".
- Short: subject ≤9 words; body ≤130 words, 3 short paragraphs max, one clear ask (15-min call).
- Personal and specific to the lead and their institution. No corporate filler, no "I hope this finds you well".
- If signals show a concrete trigger (RFP, new hire, initiative), lead with it. If context is thin, be candid and lead with the transfer-credit pain.
- Sign off with just the rep first name.

LEAD: ${JSON.stringify(lead)}
COMPANY CONTEXT (Starbridge): ${JSON.stringify(sbContext) || 'none'}

Return VALID JSON only: {"subject": "...", "body": "..."}`;
      const r2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 700, messages: [{ role: 'user', content: prompt }] })
      });
      if (!r2.ok) return res.status(502).json({ error: `Claude ${r2.status}: ${(await r2.text()).slice(0, 200)}` });
      const j2 = await r2.json();
      const txt = (j2.content?.[0]?.text || '').replace(/^```(?:json)?\s*/gim, '').replace(/\s*```\s*$/gim, '');
      const s2 = txt.indexOf('{'), e2 = txt.lastIndexOf('}');
      let draft;
      try { draft = JSON.parse(txt.slice(s2, e2 + 1).replace(/,(\s*[\}\]])/g, '$1')); }
      catch { return res.status(502).json({ error: 'Claude did not return valid JSON' }); }
      return res.status(200).json({ to: lead.email, subject: draft.subject || '', body: draft.body || '', _sb_context: !!sbContext });
    }

    // ===== WEEKLY: weekly dossier batch + per-rep digests (saved to Confluence) =====
    if (action === 'weekly') {
      const sub = cronSubOverride || url.searchParams.get('sub') || 'plan';
      // Reps in the weekly loop. Cody intentionally excluded (routing rules: his
      // net-new accounts flow to Charles).
      const WEEKLY_REPS = [
        { name: 'Jay Fedje',      ownerId: '118972528', email: 'jay.fedje@degreesight.com' },
        { name: 'Michael Cronin', ownerId: '84179396',  email: 'michael.cronin@degreesight.com' },
        { name: 'Charles Ramos',  ownerId: '90988586',  email: 'charles.ramos@degreesight.com' },
        { name: 'Drew Melendres', ownerId: '30458491',  email: 'drew.melendres@degreesight.com' }
      ];
      const now = new Date();
      const wk = (() => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
      const week = url.searchParams.get('week') || wk;
      // Storage: Google Drive (inlined client above). Week folder "Week of YYYY-MM-DD"
      // inside DRIVE_FOLDER_ID; bundle.json + one PDF per dossier.
      const WEEK_FOLDER = w => `Week of ${w}`;

      // Local helpers shared by the interactive subs AND the automatic cron
      const runPlan = async () => {
        const STRONG_TYPES = new Set(['RFP', 'Purchase', 'Meeting']);
        const [hot, rfp, purchase, meeting] = await Promise.all([
          listTopRecentSignals({ pageSize: 100, sort: 'Hotness', relativeDatePeriodFrom: 'LastSevenDays' }),
          listTopRecentSignals({ pageSize: 50, filterType: ['RFP'],      relativeDatePeriodFrom: 'LastSevenDays' }).catch(() => ({ result: [] })),
          listTopRecentSignals({ pageSize: 50, filterType: ['Purchase'], relativeDatePeriodFrom: 'LastSevenDays' }).catch(() => ({ result: [] })),
          listTopRecentSignals({ pageSize: 50, filterType: ['Meeting'],  relativeDatePeriodFrom: 'LastSevenDays' }).catch(() => ({ result: [] }))
        ]);
        const all = [...(hot.result || []), ...(rfp.result || []), ...(purchase.result || []), ...(meeting.result || [])];
        const byBuyer = {};
        const seenSignal = new Set(); // dedupe the same signal appearing in two fetches
        for (const s of all) {
          const bid = s.row?.buyerId;
          if (!bid) continue;
          const sigKey = `${bid}|${s.bridge?.name || ''}|${s.row?.name || ''}`;
          if (seenSignal.has(sigKey)) continue;
          seenSignal.add(sigKey);
          const type = s.bridge?.filterType || null;
          const weight = STRONG_TYPES.has(type) ? 3 : 1;
          if (!byBuyer[bid]) byBuyer[bid] = { buyerId: bid, name: s.row?.buyerName || s.row?.name || '', signal_count: 0, intent_score: 0, strong_signals: 0, top_signal: null };
          byBuyer[bid].signal_count++;
          byBuyer[bid].intent_score += weight;
          if (STRONG_TYPES.has(type)) byBuyer[bid].strong_signals++;
          // Prefer a strong-intent signal as the headline signal
          if (!byBuyer[bid].top_signal || (STRONG_TYPES.has(type) && !STRONG_TYPES.has(byBuyer[bid].top_signal.type))) {
            byBuyer[bid].top_signal = { type, name: s.row?.name || null, bridge: s.bridge?.name || null };
          }
          if (!byBuyer[bid].name && s.row?.name) byBuyer[bid].name = s.row.name;
        }
        const targets = Object.values(byBuyer)
          .sort((a, b) => b.intent_score - a.intent_score || b.signal_count - a.signal_count)
          .slice(0, 25);
        return { week, targets, total_signals: all.length };
      };

      const runDigests = async (dossierSummaries) => {
        const hsToken = process.env.HUBSPOT_TOKEN;
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
        const weekStartISO = `${week}T00:00:00Z`;
        const digests = {};
        for (const rep of WEEKLY_REPS) {
          // Deals that moved this week for this rep
          let movedDeals = [];
          if (hsToken) {
            try {
              const dr = await hsSearch(hsToken, 'deals', {
                filterGroups: [{ filters: [
                  { propertyName: 'hubspot_owner_id', operator: 'EQ', value: rep.ownerId },
                  { propertyName: 'hs_lastmodifieddate', operator: 'BETWEEN', value: weekStartISO, highValue: new Date().toISOString() }
                ] }],
                properties: ['dealname', 'dealstage', 'amount', 'closedate'],
                sorts: [{ propertyName: 'amount', direction: 'DESCENDING' }], limit: 15
              });
              movedDeals = (dr.results || []).map(x => x.properties);
            } catch (e) { /* digest still works without deals */ }
          }
          const repDossiers = dossierSummaries.filter(d2 => (d2.prepared_for || '') === rep.name);
          const prompt = `You write a short Monday digest for a DegreeSight sales rep. Concise, direct, plain language. NO em dashes. Use "candidly" rather than "honestly". Be honest about gaps.

REP: ${rep.name}
WEEK OF: ${week}
NEW ACCOUNT DOSSIERS PREPARED FOR THIS REP THIS WEEK: ${JSON.stringify(repDossiers)}
THEIR DEALS WITH ACTIVITY THIS WEEK: ${JSON.stringify(movedDeals)}

Return VALID JSON only:
{
  "headline": "≤14 words, the single most important thing for ${rep.name} this week",
  "bullets": ["3-5 items, each ≤30 words, start with <b>bolded action or fact.</b> Reference the dossiers and deals above by name. If there is nothing for a category, say so candidly."],
  "focus_account": "school name from the dossiers most worth their first hour, or null"
}`;
          try {
            const r2 = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
              body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 900, messages: [{ role: 'user', content: prompt }] })
            });
            if (!r2.ok) throw new Error(`Claude ${r2.status}`);
            const j2 = await r2.json();
            const txt = (j2.content?.[0]?.text || '').replace(/^```(?:json)?\s*/gim, '').replace(/\s*```\s*$/gim, '');
            const s2 = txt.indexOf('{'), e3 = txt.lastIndexOf('}');
            digests[rep.name] = JSON.parse(txt.slice(s2, e3 + 1).replace(/,(\s*[\}\]])/g, '$1'));
          } catch (e) {
            digests[rep.name] = { headline: 'Digest unavailable', bullets: [`Claude error: ${e.message}`], focus_account: null, _error: true };
          }
          digests[rep.name].moved_deals = movedDeals.length;
          digests[rep.name].dossier_count = repDossiers.length;
        }
        return digests;
      };

      // --- plan: pick this week's top 25 targets (strong intent 3x) ---
      if (sub === 'plan') {
        return res.status(200).json(await runPlan());
      }

      // --- digests: one Claude digest per rep (minus Cody) ---
      if (sub === 'digests') {
        const body = req.body || {};
        const digests = await runDigests(Array.isArray(body.dossiers) ? body.dossiers : []);
        return res.status(200).json({ week, digests });
      }

      // --- save: persist the weekly bundle (JSON) to the week's Drive folder ---
      if (sub === 'save') {
        const bundle = req.body || {};
        if (!bundle.week) bundle.week = week;
        bundle.saved_at = new Date().toISOString();
        bundle.saved_by = user.email;
        const folderId = await ensureFolder(rootFolderId(), WEEK_FOLDER(bundle.week));
        await uploadFile(folderId, 'bundle.json', Buffer.from(JSON.stringify(bundle, null, 2)), 'application/json');
        return res.status(200).json({ ok: true, week: bundle.week, folder_id: folderId, folder_url: folderUrl(folderId) });
      }

      // --- pdf: upload one dossier PDF (base64) into the week's folder ---
      if (sub === 'pdf') {
        const b = req.body || {};
        if (!b.pdf_base64 || !b.school_name) return res.status(400).json({ error: 'school_name and pdf_base64 required' });
        const w2 = b.week || week;
        const folderId = await ensureFolder(rootFolderId(), WEEK_FOLDER(w2));
        const safeName = String(b.school_name).replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
        const buf = Buffer.from(b.pdf_base64, 'base64');
        if (buf.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'PDF too large (>4MB)' });
        const up = await uploadFile(folderId, `${safeName}.pdf`, buf, 'application/pdf');
        return res.status(200).json({ ok: true, file_id: up.id, url: up.webViewLink || null });
      }

      // --- list: saved weeks (Drive subfolders) ---
      if (sub === 'list') {
        const folders = await listFolders(rootFolderId());
        const weeks = folders
          .filter(f => (f.name || '').startsWith('Week of '))
          .map(f => ({ week: f.name.replace('Week of ', ''), folder_id: f.id, folder_url: folderUrl(f.id), updated_at: f.modifiedTime }))
          .sort((a, b) => b.week.localeCompare(a.week));
        return res.status(200).json({ weeks });
      }

      // --- get: load one saved week's bundle.json ---
      if (sub === 'get') {
        const folder = await findChild(rootFolderId(), WEEK_FOLDER(week), { folderOnly: true });
        if (!folder) return res.status(404).json({ error: `No saved folder for week ${week}` });
        const file = await findChild(folder.id, 'bundle.json');
        if (!file) return res.status(404).json({ error: 'Folder exists but bundle.json is missing' });
        const buf = await downloadFile(file.id);
        let bundle;
        try { bundle = JSON.parse(buf.toString('utf8')); }
        catch { return res.status(500).json({ error: 'bundle.json could not be parsed' }); }
        return res.status(200).json({ week, bundle, folder_url: folderUrl(folder.id) });
      }

      // --- notify: Slack webhook to the team (reps minus Cody) ---
      if (sub === 'notify') {
        const hook = process.env.SLACK_WEBHOOK_URL;
        if (!hook) return res.status(400).json({ error: 'SLACK_WEBHOOK_URL not set. Create an incoming webhook in Slack and add it as a Vercel env var.' });
        const b = req.body || {};
        const names = WEEKLY_REPS.map(r3 => r3.name).join(', ');
        const dashUrl = `https://${req.headers.host}/sales.html`;
        const text = `📂 *Weekly dossiers are ready* (week of ${b.week || week})\n` +
          `${b.dossier_count ?? '?'} account dossier${(b.dossier_count || 0) === 1 ? '' : 's'} + personal digests for: ${names}\n` +
          `Open the *Dossier → Weekly* tab: ${dashUrl}` +
          (b.folder_url ? `\nPDFs on Drive: ${b.folder_url}` : '');
        const r4 = await fetch(hook, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        if (!r4.ok) return res.status(500).json({ error: `Slack webhook ${r4.status}: ${(await r4.text()).slice(0, 200)}` });
        return res.status(200).json({ ok: true });
      }

      // --- drive_check: diagnose service-account identity + folder access ---
      if (sub === 'drive_check') {
        const out = {
          sa_email_env: (process.env.GOOGLE_SA_EMAIL || '').trim() || null,
          folder_id_env: (process.env.DRIVE_FOLDER_ID || '').trim() || null,
          key_present: !!process.env.GOOGLE_SA_PRIVATE_KEY
        };
        try {
          const r5 = await driveFetch('/about?fields=user');
          out.token_identity = (await r5.json()).user?.emailAddress || null;
        } catch (e) { out.token_error = e.message.slice(0, 300); }
        try {
          const r6 = await driveFetch(`/files/${rootFolderId()}?fields=id,name,owners(emailAddress),capabilities(canAddChildren)&supportsAllDrives=true`);
          out.folder = await r6.json();
        } catch (e) { out.folder_error = e.message.slice(0, 300); }
        return res.status(200).json(out);
      }

      // --- cron: fully automatic pipeline, self-chained to fit the 60s limit ---
      // Each invocation does ONE unit of work (1 dossier+PDF, or digests, or save,
      // or notify), persists state.json to the week's Drive folder, then triggers
      // the next invocation. Kicked off weekly by Vercel Cron (CRON_SECRET auth).
      if (sub === 'cron') {
        const folderId = await ensureFolder(rootFolderId(), WEEK_FOLDER(week));
        let state = null;
        let freshPlan = false;
        const sf = await findChild(folderId, 'state.json');
        if (sf) { try { state = JSON.parse((await downloadFile(sf.id)).toString('utf8')); } catch {} }
        if (!state || url.searchParams.get('restart') === '1') {
          const plan = await runPlan();
          state = { week, phase: 'dossiers', targets: plan.targets, dossiers: [], pdf_ok: 0, pdf_fail: 0, started_at: new Date().toISOString(), errors: [] };
          freshPlan = true; // save state + chain immediately; heavy work starts on the next link
        }
        if (state.phase === 'done') {
          return res.status(200).json({ ok: true, phase: 'done', week, finished_at: state.finished_at });
        }

        const safeName = n => String(n || 'dossier').replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
        try {
          if (freshPlan) {
            // no-op this invocation: persist the plan and hand off to the chain
          } else if (state.phase === 'dossiers') {
            const idx = state.dossiers.length;
            if (idx >= state.targets.length) {
              state.phase = 'digests';
            } else {
              const t = state.targets[idx];
              const d = await generateDossier(t.buyerId, t.name || '');
              d._signal_count = t.signal_count; d._intent_score = t.intent_score; d._strong_signals = t.strong_signals;
              state.dossiers.push(d);
              try {
                const pdf = await renderPdfBuffer(serverDossierHtml(d));
                await uploadFile(folderId, `${safeName(d.school_name)}.pdf`, pdf, 'application/pdf');
                state.pdf_ok++;
              } catch (e) { state.pdf_fail++; state.errors.push(`pdf ${d.school_name}: ${e.message}`.slice(0, 200)); }
              if (state.dossiers.length >= state.targets.length) state.phase = 'digests';
            }
          } else if (state.phase === 'digests') {
            const summaries = state.dossiers.map(d2 => ({
              school_name: d2.school_name, prepared_for: d2.prepared_for, deal_state: d2.deal_state,
              skip_recommended: d2.skip_recommended, theme: d2.dossier?.theme || null, banner: d2.dossier?.banner_text || null
            }));
            state.digests = await runDigests(summaries);
            state.phase = 'save';
          } else if (state.phase === 'save') {
            const bundle = {
              week: state.week, targets: state.targets, dossiers: state.dossiers, digests: state.digests,
              saved_at: new Date().toISOString(), saved_by: 'weekly-cron', folder_url: folderUrl(folderId)
            };
            await uploadFile(folderId, 'bundle.json', Buffer.from(JSON.stringify(bundle, null, 2)), 'application/json');
            state.phase = 'notify';
          } else if (state.phase === 'notify') {
            const dashUrl = `https://${req.headers.host}/sales.html`;
            const stripB = s => String(s || '').replace(/<\/?b>/g, '*').replace(/<[^>]+>/g, '');
            state.dm_ok = 0; state.dm_fail = 0;
            for (const rep of WEEKLY_REPS) {
              const dg = (state.digests || {})[rep.name] || {};
              const text =
                `📂 *Weekly dossiers — week of ${state.week}*\n` +
                (dg.headline ? `*${stripB(dg.headline)}*\n` : '') +
                (dg.bullets || []).map(bt => `• ${stripB(bt)}`).join('\n') +
                (dg.focus_account ? `\n🎯 First hour: *${stripB(dg.focus_account)}*` : '') +
                `\n\n${state.pdf_ok} PDFs: ${folderUrl(folderId)}\nDashboard: ${dashUrl}`;
              try { await slackDmByEmail(rep.email, text); state.dm_ok++; }
              catch (e) { state.dm_fail++; state.errors.push(`slack ${rep.name}: ${e.message}`.slice(0, 200)); }
            }
            state.phase = 'done';
            state.finished_at = new Date().toISOString();
          }
        } catch (e) {
          state.errors.push(`${state.phase}: ${e.message}`.slice(0, 300));
          state.retry = (state.retry || 0) + 1;
          if (state.retry > 3) { state.phase = 'done'; state.finished_at = new Date().toISOString(); state.aborted = true; }
        }

        await uploadFile(folderId, 'state.json', Buffer.from(JSON.stringify(state)), 'application/json');

        // Chain the next step (fire, wait long enough to guarantee dispatch, abort)
        if (state.phase !== 'done') {
          try {
            const nextUrl = `https://${req.headers.host}/api/starbridge?action=weekly&sub=cron&week=${state.week}&secret=${encodeURIComponent(cronSecret || '')}`;
            const ctrl = new AbortController();
            const tm = setTimeout(() => ctrl.abort(), 2000);
            await fetch(nextUrl, { signal: ctrl.signal }).catch(() => {});
            clearTimeout(tm);
          } catch {}
        }
        return res.status(200).json({
          ok: true, phase: state.phase, week: state.week,
          dossiers_done: state.dossiers.length, targets: (state.targets || []).length,
          pdf_ok: state.pdf_ok, pdf_fail: state.pdf_fail, errors: state.errors.slice(-3)
        });
      }

      // --- cron_status: progress of the automatic run (for the dashboard) ---
      if (sub === 'cron_status') {
        const folder = await findChild(rootFolderId(), WEEK_FOLDER(week), { folderOnly: true });
        if (!folder) return res.status(200).json({ week, phase: 'not_started' });
        const sf2 = await findChild(folder.id, 'state.json');
        if (!sf2) return res.status(200).json({ week, phase: 'not_started' });
        try {
          const st = JSON.parse((await downloadFile(sf2.id)).toString('utf8'));
          return res.status(200).json({
            week, phase: st.phase, dossiers_done: (st.dossiers || []).length, targets: (st.targets || []).length,
            pdf_ok: st.pdf_ok, pdf_fail: st.pdf_fail, dm_ok: st.dm_ok, dm_fail: st.dm_fail,
            started_at: st.started_at, finished_at: st.finished_at, errors: (st.errors || []).slice(-5),
            folder_url: folderUrl(folder.id)
          });
        } catch { return res.status(200).json({ week, phase: 'unknown' }); }
      }

      return res.status(400).json({ error: `unknown weekly sub: ${sub}` });
    }

    // ===== ANALYTICS: aggregate signals overview =====
    if (action === 'analytics') {
      const period = url.searchParams.get('period') || 'LastThirtyDays';
      const [hotSignals, newSignals, rfpSignals, meetingSignals, jobChangeSignals] = await Promise.all([
        listTopRecentSignals({ pageSize: 100, sort: 'Hotness', relativeDatePeriodFrom: period }),
        listTopRecentSignals({ pageSize: 100, sort: 'Date',    relativeDatePeriodFrom: period }),
        listTopRecentSignals({ pageSize: 30,  filterType: ['RFP'],       relativeDatePeriodFrom: period }),
        listTopRecentSignals({ pageSize: 30,  filterType: ['Meeting'],   relativeDatePeriodFrom: period }),
        listTopRecentSignals({ pageSize: 30,  filterType: ['JobChange'], relativeDatePeriodFrom: period })
      ]);

      // Aggregate
      const allRows = [...(hotSignals.result || []), ...(newSignals.result || [])];
      const buyerCounts = {};
      const buyerLastSeen = {};
      const signalsByType = {};
      const bridgeCounts = {};
      for (const s of allRows) {
        const type = s.bridge?.filterType;
        if (type) signalsByType[type] = (signalsByType[type] || 0) + 1;
        const bridgeName = s.bridge?.name;
        if (bridgeName) bridgeCounts[bridgeName] = (bridgeCounts[bridgeName] || 0) + 1;
        const buyerId = s.row?.buyerId;
        if (buyerId) {
          if (!buyerCounts[buyerId]) buyerCounts[buyerId] = { buyerId, count: 0, sample_row_name: s.row.name };
          buyerCounts[buyerId].count++;
          const when = s.row.updatedAt;
          if (when && (!buyerLastSeen[buyerId] || when > buyerLastSeen[buyerId])) buyerLastSeen[buyerId] = when;
        }
      }
      const topBuyers = Object.values(buyerCounts)
        .map(b => ({ ...b, last_seen: buyerLastSeen[b.buyerId] || null }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      const topN = (obj, n = 15) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ label: k, count: v }));

      const compactSignal = (s) => ({
        buyer_id: s.row?.buyerId || null,
        bridge_name: s.bridge?.name,
        filter_type: s.bridge?.filterType,
        row_name: s.row?.name,
        status: s.row?.status,
        updated_at: s.row?.updatedAt
      });

      return res.status(200).json({
        period,
        total_signals: allRows.length,
        unique_buyers: Object.keys(buyerCounts).length,
        signals_by_type: signalsByType,
        top_bridges: topN(bridgeCounts, 10),
        top_buyers: topBuyers,
        hottest: (hotSignals.result || []).slice(0, 15).map(compactSignal),
        recent_rfps:        (rfpSignals.result || []).slice(0, 15).map(compactSignal),
        recent_meetings:    (meetingSignals.result || []).slice(0, 15).map(compactSignal),
        recent_job_changes: (jobChangeSignals.result || []).slice(0, 15).map(compactSignal)
      });
    }

    // ===== SIGNALS LIST (default) =====
    const sort = url.searchParams.get('sort') || 'Hotness';
    const period = url.searchParams.get('period') || 'LastThirtyDays';
    const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') || '50', 10), 100);
    const filterTypeRaw = url.searchParams.get('filterType');
    const filterType = filterTypeRaw ? filterTypeRaw.split(',').filter(Boolean) : undefined;
    const statusRaw = url.searchParams.get('status');
    const status = statusRaw ? statusRaw.split(',').filter(Boolean) : undefined;

    const data = await listTopRecentSignals({
      pageSize, sort, filterType, status, relativeDatePeriodFrom: period
    });
    return res.status(200).json(data);

  } catch (e) {
    if (e.status === 401) return res.status(502).json({ error: 'starbridge_unauthorized', detail: 'Check STARBRIDGE_API_KEY' });
    return res.status(502).json({ error: 'starbridge_failed', detail: e.message });
  }
}
