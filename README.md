# my-finans

Hot-capture personal expense tracker. PWA on the home screen → Cloudflare Worker → commit to a private GitHub repo → cron-pulled to a laptop. The point is to log one expense («coffee 350») in ≤5–10 seconds at the moment of purchase, and do reconciliation (FX, balances, big events) later in a Claude Code session over the data repo.

This repository contains the **code** (Worker, PWA, sync scripts). The **data** lives in a separate private GitHub repo that you own.

---

## Architecture

```
[Browser / PWA] ──HTTPS──> [Cloudflare]
                              │
   ┌──────────────────────────┴───────────────────────────┐
   │ <your-domain>  (single domain)                       │
   ├──────────────────────────────────────────────────────┤
   │ /                       → Cloudflare Pages (PWA)     │
   │ /api/*                  → Cloudflare Worker          │
   │                            └─ GitHub API → data repo │
   └──────────────────────────────────────────────────────┘
                                                │
                                   [cron pull every ~5 min]
                                                ▼
                                  <local clone of data repo>
```

Same-origin: the PWA fetches relative paths `/api/...` — no CORS, and the user's PWA settings only need a Bearer token, never a "Worker URL".

---

## What's in this repo

| Folder | What |
|---|---|
| `worker/` | Cloudflare Worker (single-file vanilla JS). Endpoints `POST /api/expense`, `GET /api/balances`, `GET /api/day`, `POST /api/event`, `DELETE /api/event/last`. |
| `pwa/` | PWA: vanilla HTML/CSS/JS + Service Worker. Four pages: record expense, view balances, structured events, daily log. No build step. |
| `sync/` | bash script for WSL/Linux cron — keeps a local clone of the data repo fresh. |
| `hooks/` | Claude Code SessionStart hook — `git pull`s the data repo when a session starts. |
| `docs/` | Changelog. |
| `DEPLOY.md` | Full setup guide. |

---

## Data layout (in the private data repo)

The Worker reads and writes two files:

- **`balances.json`** — current balances per account. `{ updated_at: ISO, accounts: [{ id, name, amount, currency }] }`
- **`events.json`** — append-only event log. `{ events: [{ id, type, from?, to?, amount, amount_to?, note?, at }] }`. Types: `income | expense | transfer | exchange`.

Both files are updated **atomically** in a single GitHub commit via the Trees API (CAS on the branch ref). If a parallel write moves the ref between read and write, the Worker retries up to 4 times.

Optional `archive/` folder for older markdown logs from before you migrated to JSON.

---

## Quick-expense parser

The main PWA screen takes free text like:

- `coffee 350` → expense 350 in default currency (THB) from default cash account.
- `subscription 26 usdt` → routes to your USDT account, expense 26.
- `подписка 500 руб` → routes to your RUB account.

Rules: the last contiguous number is the amount; everything else is the note. Currency tokens (`usdt | rub | руб`, case-insensitive) get stripped from the note and route to the corresponding `DEFAULT_ACCOUNT_*` configured in `wrangler.toml`. Two or more tokens → ambiguous, falls back to default. Unicode-aware word boundaries so words like «рубероид» don't false-match `руб`.

The parser is intentionally dumb — no categories, no FX, no autocomplete. Designed for ≤5-second capture, not for analysis. Analysis happens later, in Claude over the data repo.

---

## Why this shape

Most expense trackers fail at the moment of capture: too many fields, too many taps, too much friction. So you either don't record, or record later and forget. This project gives up flexibility at capture time (free-text only, one default account per currency) to win on the only metric that matters — **did you actually log it**.

Reconciliation, categorization, currency conversion, charting — all of that is `git clone` away. The data is JSON in your own private repo. Open it in Claude Code, ask questions, edit by hand. The architecture explicitly preserves your ownership of the data.

---

## Setup

See **[DEPLOY.md](./DEPLOY.md)**. ~30–45 minutes:

1. GitHub fine-grained PAT for the data repo
2. Random `APP_TOKEN` for Bearer auth
3. `cp worker/wrangler.example.toml worker/wrangler.toml`, fill in your domain / repo / account ids
4. `npx wrangler deploy` for the Worker
5. `npx wrangler pages deploy pwa --project-name=...` for the PWA
6. Attach a custom domain to the Pages project (same domain the Worker route uses)
7. Open `https://<your-domain>/`, paste the Bearer token in Settings, done

---

## Status

Used daily by the author. Stable, no active development beyond personal needs. Pull requests welcome but unlikely to be reviewed quickly — fork freely.

---

## License

MIT.
