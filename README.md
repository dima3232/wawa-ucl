# Champions League 2026/27 ⭐

A self-updating web page for the UEFA Champions League 2026/27: the 36-team
league-phase table, a "When to watch" schedule, and the knockout bracket.
Runs on Cloudflare Workers with a small KV cache — one API call serves every
visitor, so it stays inside a free data plan.

## Features

- **League phase table** — all 36 teams in the Swiss-model single table
  (each club plays 8 different opponents), with the qualification zones:
  **1–8** straight to the Round of 16, **9–24** into the knockout play-off,
  **25–36** eliminated. Zones stay uncoloured until matches are actually
  played, so the pre-season list isn't mistaken for standings.
- **Two-legged knockout ties** — each tie shows both legs' goals per team plus
  the aggregate; penalties are marked separately. The final is a single match.
- **When to watch** — every fixture grouped by day in the **visitor's own
  timezone**, with a 🍺 marker for evening kick-offs and a LIVE window.
- **Local language** — UI auto-detects Ukrainian/English from the browser with
  a manual switcher; the choice is kept in `localStorage`.
- **Add to calendar** — Google and Outlook open a pre-filled event; Apple uses
  `webcal://` to the Worker's `/event.ics` (a plain `.ics` download is offered
  as a fallback). Each event carries a 30-minute reminder.
- **Match statistics** — possession, xG, shots on target, big chances, corners,
  offsides, fouls and cards, fetched on demand and cached forever in KV.

## How it works

Data comes from **Highlightly** (`leagueId 2486`). The Worker owns the API key
and the cache; browsers only ever talk to the Worker:

- `/fixtures` — the whole season (schedule + scores + status) from KV;
- `/stats?id=<matchId>` — one match's statistics, lazily fetched;
- `/event.ics` — a calendar event (used by the Apple `webcal://` flow);
- a **cron trigger** keeps the cache warm.

### Staying inside the free tier (100 requests/day)

The polling is deliberately shaped around the quota rather than a fixed interval:

- the **full season list** costs 2–3 paginated calls and is refreshed only
  every few hours;
- during a matchday only **that day's matches** are re-read — one call per
  refresh, every 5 minutes, so live scores lag by at most a few minutes;
- if the remaining quota drops below a threshold the interval stretches to
  15 minutes automatically;
- statistics are fetched on demand, with a small trickle of post-match
  backfill only while there's budget to spare.

A typical matchday lands around 70–80 calls out of 100; a quiet day costs a
handful. The budget is read from Highlightly's own rate-limit header, and a
stale counter is treated as unknown so a single bad response can never
deadlock the Worker into never calling the API again.

Source pagination is not stable — the same match can appear on two pages while
another goes missing — so results are de-duplicated by match id, and gaps are
filled by the per-day refresh.

## Local development

```bash
python3 -m http.server 8791
```

The Worker routes don't run under a plain static server. To preview with real
data, drop a `fixtures` file (the JSON shape `/fixtures` returns) next to
`index.html`; it is git-ignored and never deployed.

## Deployment

Cloudflare Workers with static assets, deployed from this repo on every push
to `main`.

- [`index.html`](index.html) is served as a static asset.
- [`worker.js`](worker.js) serves the dynamic routes and the cron.
- [`wrangler.jsonc`](wrangler.jsonc) wires the assets binding, the KV namespace
  (`UCL_KV`, keys prefixed `ucl:`) and the `HIGHLIGHTLY_KEY` **Secrets Store**
  binding — the key is referenced by name, never stored in the repo, so CI
  deploys re-attach it automatically instead of wiping it.

---

made for Football | WAWA ⚽
