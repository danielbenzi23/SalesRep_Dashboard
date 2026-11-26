// Weekly lead-score snapshots in Vercel Blob.
//
// /api/lead-scoring?action=snapshot (Vercel Cron, Mondays) writes one JSON file
// per day; the lead-scoring view reads the newest one taken on or before the
// comparison date to show how each contact's global rank moved.
//
// The snapshot store is the PRIVATE one behind BLOB_READ_WRITE_TOKEN (the
// weekly pipeline's public store has its own token). If that store was created
// as public instead, set LEAD_SNAPSHOT_BLOB_ACCESS=public.

import { put, list, get } from '@vercel/blob';

const PREFIX = 'lead-scoring/snapshots/';
const ACCESS = process.env.LEAD_SNAPSHOT_BLOB_ACCESS === 'public' ? 'public' : 'private';
const DATE_RE = /(\d{4}-\d{2}-\d{2})\.json$/;

export async function saveSnapshot(dateKey, snapshot) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('dateKey must be YYYY-MM-DD');
  const saved = await put(`${PREFIX}${dateKey}.json`, JSON.stringify(snapshot), {
    access: ACCESS, addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json'
  });
  return { url: saved.url, pathname: saved.pathname };
}

// Newest snapshot dated on or before `beforeISO`, or null when there is none.
export async function getSnapshotBefore(beforeISO) {
  const cutoff = String(beforeISO || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) return null;

  let best = null;
  let cursor;
  do {
    const page = await list({ prefix: PREFIX, limit: 1000, cursor });
    for (const b of page.blobs) {
      const m = DATE_RE.exec(b.pathname);
      if (m && m[1] <= cutoff && (!best || m[1] > best.date)) best = { date: m[1], pathname: b.pathname };
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  if (!best) return null;

  const res = await get(best.pathname, { access: ACCESS, useCache: false });
  if (!res || res.statusCode !== 200 || !res.stream) return null;
  return JSON.parse(await new Response(res.stream).text());
}
