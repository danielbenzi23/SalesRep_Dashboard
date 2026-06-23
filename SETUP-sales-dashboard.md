# Sales rep dashboard — setup

New URL: `https://<your-domain>/sales.html`

Sources: **HubSpot** (deals/activities) + **Confluence** (transcripts) + **Claude** (analysis). No new database.

## What this adds

- **Today** tab: tasks due, meetings this week, open pipeline, weighted forecast, needs-attention deals, goal tracker, recent meeting insights from Confluence
- **My pipeline** tab: funnel + open deals table
- **Conversations** tab: every Confluence meeting transcript — click any to analyze sentiment with Claude
- **My goals** tab: quota tracker (quarter + annual)
- **Recent** tab: last 5 won / lost

Sales reps see only their own data. Admins/managers get a dropdown to view any rep.

## Files to commit (7 total)

```
lib/auth.js                   (UPDATED — added EMAIL_TO_OWNER_ID, OWNER_ID_TO_NAME, REP_ANNUAL_QUOTA)
lib/confluence.js             (NEW — Confluence client)
api/sales-data.js             (NEW — HubSpot data filtered by rep)
api/transcripts.js            (NEW — lists Confluence transcripts)
api/transcript-insight.js     (NEW — fetches a Confluence page, runs Claude, returns insight)
public/sales.html             (NEW — sales workspace UI)
SETUP-sales-dashboard.md      (this file)
```

## 1. Add env vars on Vercel

| Key | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | for transcript analysis |
| `CONFLUENCE_EMAIL` | your Atlassian login email | account that owns the API token |
| `CONFLUENCE_API_TOKEN` | Atlassian API token | https://id.atlassian.com/manage-profile/security/api-tokens |
| `CONFLUENCE_BASE_URL` | `https://degreesight.atlassian.net/wiki` | optional, that's the default |
| `CONFLUENCE_TRANSCRIPTS_PARENT_ID` | `1461846041` | optional, that's the default (Meeting Transcriptions page id) |

Already present (no change): `HUBSPOT_TOKEN`, `DASHBOARD_TOKEN`, `DASHBOARD_PASSWORD`.

Redeploy after adding the new keys.

## 2. Access

- Each rep logs in normally at `/login.html`, then navigates to `/sales.html`
- Optional: add a link from `/index.html` header → `/sales.html`

## 3. Per-rep quotas

Edit `lib/auth.js`:

```js
export const REP_ANNUAL_QUOTA = {
  '80532547':  646880,   // Cody
  '118972528': 646880,   // Jay
  '84179396':  646880,   // Michael
  '90988586':  646880,   // Charles
  '30458491':  646880    // Drew
};
```

Quarterly = annual / 4.

## 4. Stale & hot thresholds

Edit `api/sales-data.js`:

```js
const STALE_DAYS = 14;            // deal flagged as stale if no activity for N days
const HOT_PROB_THRESHOLD = 0.85;  // Contract stage / close imminent
```

## Flow

```
User opens /sales.html
   │
   ├─ GET /api/me                  → who am I (cookie auth)
   ├─ GET /api/sales-data          → HubSpot (deals, tasks, meetings) filtered by my owner_id
   └─ GET /api/transcripts         → list Confluence transcripts (titles + dates)

User clicks a transcript card
   │
   └─ POST /api/transcript-insight { confluence_page_id }
                │
                ├─ fetch Confluence page → strip HTML
                ├─ call Claude Haiku 4.5 → JSON insight
                └─ return (no DB, no cache — runs on every click)
```

## Cost

- Claude Haiku 4.5: ~$0.009 per transcript click
- At 50 clicks/day across the team ≈ **$13/month** (worst case)
- At 10 clicks/day ≈ **$3/month**

If usage grows and re-analysis cost matters, we can later cache by writing the JSON insight back to Confluence as a child "Insights" page so the cache lives where the data lives.

## Troubleshooting

**"Your email is not mapped to a HubSpot owner"** — add your email to `EMAIL_TO_OWNER_ID` in `lib/auth.js`.

**Confluence 401** — `CONFLUENCE_EMAIL` and `CONFLUENCE_API_TOKEN` don't match. The token must belong to the email you set.

**Confluence 404 listing children** — `CONFLUENCE_TRANSCRIPTS_PARENT_ID` is wrong. Open the Meeting Transcriptions page in Confluence and copy the numeric id from the URL (the part right after `/pages/`).

**Claude returns invalid JSON** — rare; endpoint returns 502 with first 200 chars of the response. Usually means the transcript got mangled by the HTML stripper. Open the Confluence page and check the formatting.

**"transcript_too_short"** — the page body has under 100 characters after HTML stripping. Likely the wrong page id or an empty transcript.
