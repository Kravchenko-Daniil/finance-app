# Deploy & install

Step-by-step guide to spin up this project on a fresh Cloudflare account and a new GitHub data repo.

**Time:** ~30–45 minutes.

---

## Architecture

```
[Browser / PWA] ──HTTPS──> [Cloudflare]
                              │
   ┌──────────────────────────┴────────────────────────────┐
   │ <your-domain>  (single domain)                        │
   ├───────────────────────────────────────────────────────┤
   │ /, /balances, /events, /expenses, /icon.svg, ...      │
   │   → Cloudflare Pages (PWA static assets from pwa/)    │
   │                                                       │
   │ /api/*                                                │
   │   → Cloudflare Worker (worker/src/index.js)           │
   │     └─ GitHub API → <your-user>/<your-data-repo>      │
   └───────────────────────────────────────────────────────┘
                                                │
                                   [cron pull every ~5 min]
                                                ▼
                                    <local clone of data repo>
```

PWA and Worker share a single domain (same-origin). The PWA fetches relative paths `/api/...` — no CORS, no «Worker URL» field in settings; only a Bearer token.

---

## Step 0. Prerequisites

- A **Cloudflare account** (free tier is enough).
- A domain you own, with DNS managed by Cloudflare. Free `*.workers.dev` won't work for the single-domain setup; you need a real domain to attach both Pages and the Workers Route to.
- A **private GitHub repository** to store data. The Worker commits to it via GitHub API. The repo just needs a `balances.json` (initial accounts) and an empty `events.json`. Example seed in `docs/data-repo-seed.md`.
- `npm` / `npx` available locally (for `wrangler`).

---

## Step 1. GitHub fine-grained PAT

1. <https://github.com/settings/tokens?type=beta> → **Generate new token**.
2. **Name:** anything (`<project>-sync`). **Expiration:** 1 year.
3. **Repository access:** *Only select repositories* → pick your private data repo.
4. **Repository permissions:** **Contents: Read and write**, **Metadata: Read-only** (auto).
5. Generate, **copy** the token (`github_pat_...`).

---

## Step 2. APP_TOKEN (Bearer for PWA → Worker)

```bash
openssl rand -base64 32
```

Save it — it goes into Worker secrets AND the PWA's localStorage.

---

## Step 3. Configure & deploy Worker

```bash
cd worker
cp wrangler.example.toml wrangler.toml
```

Edit `wrangler.toml`:
- `[[routes]].pattern` → `<your-domain>/api/*`
- `[[routes]].zone_name` → root zone (e.g. `example.com` for `app.example.com/api/*`)
- `[vars].REPO` → `<your-github-user>/<your-private-data-repo>`
- `[vars].DEFAULT_ACCOUNT_USDT` / `_RUB` / `_THB` → the `id` values from your `balances.json`

Then:

```bash
npx wrangler@latest login                       # auth Cloudflare
npx wrangler@latest secret put GITHUB_TOKEN     # paste PAT from Step 1
npx wrangler@latest secret put APP_TOKEN        # paste token from Step 2
npx wrangler@latest deploy
```

### Smoke-test the Worker

```bash
DOMAIN="your-domain.example.com"
TOKEN="<your APP_TOKEN>"

# GET balances
curl "https://$DOMAIN/api/balances" -H "Authorization: Bearer $TOKEN"

# Quick-expense (main PWA screen)
curl -X POST "https://$DOMAIN/api/expense" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"coffee 350"}'

# Quick-expense with a currency token (routes to DEFAULT_ACCOUNT_USDT)
curl -X POST "https://$DOMAIN/api/expense" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"test 5 usdt"}'

# GET day (expenses for a specific day in Bangkok TZ)
curl "https://$DOMAIN/api/day?date=2026-05-08" -H "Authorization: Bearer $TOKEN"

# POST event (structured: income/expense/transfer/exchange)
curl -X POST "https://$DOMAIN/api/event" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"income","to":"<account-id>","amount":1000,"note":"salary"}'

# DELETE last event (undo)
curl -X DELETE "https://$DOMAIN/api/event/last" -H "Authorization: Bearer $TOKEN"
```

All `POST`s return `{ok:true, event:{...}, balances:{...}}`. The atomic commit updates `balances.json` + `events.json` in a single commit via GitHub Trees API (CAS on ref).

---

## Step 4. Deploy PWA to Cloudflare Pages

```bash
cd ..   # back to project root
npx wrangler@latest pages deploy pwa --project-name=<your-pwa-project-name>
```

**Important:** run from the project root, not from `pwa/`. Wrangler otherwise misses assets.

Wrangler prints a `<hash>.<project>.pages.dev` URL. Attach your custom domain to the Pages project in Cloudflare Dashboard → Workers & Pages → your Pages project → Custom domains → Set up a custom domain → enter `<your-domain>`.

---

## Step 5. Open PWA & configure

Open `https://<your-domain>/` in a browser. On first load the **Settings** panel pops up with a single field:

- **Bearer token** — paste the `APP_TOKEN` from Step 2 → Save.

That's it — no "Worker URL" field, the PWA fetches `/api/...` on the same origin.

### Add to Home Screen (mobile)

- **Android Chrome:** menu (⋮) → *Add to Home screen*.
- **iPhone Safari:** Share (□↑) → *Add to Home Screen*.

### First real test

1. Type `test 50` → green `✓ test 50`.
2. Type `test-usdt 5 usdt` → should route to your USDT account (not the THB default).
3. Open `https://github.com/<your-user>/<your-data-repo>/commits/master` — new commits `Event: ...`.

---

## Step 6. (Optional) Cron sync on your laptop

If you want a local clone of the data repo that stays fresh automatically, follow `sync/INSTALL.md`.

Minimum:

```bash
cp sync/pull.example.sh sync/pull.sh
# Edit REPO_DIR to point at your local clone of the data repo
chmod +x sync/pull.sh

sudo service cron start
crontab -e
# Add a line:
*/5 * * * * /absolute/path/to/sync/pull.sh

gh auth setup-git   # for git auth to private repo
```

Manual test:

```bash
sync/pull.sh && cat /tmp/data-sync.log
```

---

## Step 7. (Optional) Claude Code SessionStart hook

To `git pull` the data repo whenever you start a Claude Code session:

```bash
cp hooks/session-start.example.sh hooks/session-start.sh
# Edit REPO_DIR
chmod +x hooks/session-start.sh
```

Then wire it into `~/.claude/settings.json` as a `SessionStart` hook (see `hooks/HOOK-INSTALL.md`).

---

## End-to-end checklist

- [ ] `curl` quick-expense with a plain number → commit on GitHub data repo
- [ ] `curl` quick-expense with `usdt` token → routes to your USDT account, not THB default
- [ ] PWA opens on `<your-domain>`, Settings has only a token field
- [ ] Recording from PWA → commit on GitHub
- [ ] (If using cron) local clone updates within ~5 min
- [ ] (If using hook) new Claude session sees fresh data immediately

---

## Troubleshooting

**Worker returns 401 Unauthorized.** `APP_TOKEN` in the Worker secret doesn't match what's in PWA `localStorage`. Re-paste in Settings, or `wrangler secret put APP_TOKEN`.

**Worker returns 404 on `/api/...`.** The Workers Route isn't configured, or the Worker isn't deployed to the right zone. Cloudflare Dashboard → Workers → your Worker → Settings → Domains & Routes — should show `Route: <your-domain>/api/*`. If absent, `cd worker && wrangler deploy`.

**Pages returns HTML on `/api/balances` instead of JSON.** The Workers Route isn't matching, or hit Pages first. Workers Routes have priority over Pages by design — verify the pattern is exactly `<your-domain>/api/*` (not `/api*` or `api.<your-domain>/*`), and the zone is correct.

**Worker 500 with `github GET 401`.** PAT invalid/expired. Regenerate → `wrangler secret put GITHUB_TOKEN`.

**Worker 500 with `ref conflict`.** SHA conflict after 4 retries — extremely rare, usually from parallel writes. Just retry.

**Local clone doesn't update.** `cat /tmp/data-sync.log` → cron running? `sudo service cron status` → up? `crontab -l` → line present? `cd <repo> && git pull` works manually?

**PWA didn't update after deploy.** Service Worker is caching. Close-reopen PWA, or DevTools → Application → Clear storage. Cache version is the `CACHE` constant in `pwa/sw.js` — bump it on significant changes.

**PWA won't install on iPhone.** Safari needs HTTPS (Pages provides it) and a `manifest.json` (present). If "Add to Home Screen" doesn't appear — update Safari, open in actual Safari (not an in-app browser).

**Worker compute exhausted.** Cloudflare Workers free tier is 100k requests/day. A typical use profile (a few dozen recordings/day) won't come close.

---

## What's intentionally NOT in MVP

- **Auto FX.** Reconciliation done elsewhere (in a Claude session over the data repo).
- **Categories.** Free-text `note`; categorize later via Claude.
- **In-PWA chat with Claude.** Requires a paid Anthropic API key — use Claude Code locally over the data repo instead.
- **Multiple users.** Single Bearer token, single data repo. If you need multi-user, that's a different project.

---

## What's in `worker/test-smoke.mjs`

Unit tests for pure logic (parser + bangkokContext + parseDay + applyMutation/reverseMutation + validateEvent + currency tokens). Run with `cd worker && node test-smoke.mjs`.

The tests read a real archived markdown file via the `ARCHIVE_MD_PATH` env variable. If unset, the file-dependent tests are skipped. Set it when you want to run integration-style checks against your own archived data:

```bash
ARCHIVE_MD_PATH=/path/to/old-expenses.md node test-smoke.mjs
```
