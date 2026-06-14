# Pricing Discipline — app

An AI-wrapped venture-pricing diligence tool for Raed Ventures. Describe an opportunity (or fill the
five anchors); **Claude classifies the revenue model, anchors it to the correct sourced public-comp
medians, and assembles the deal config**; the app renders the interactive 5-block pricing tool
(Price → Growth Quality → Capital → Defensibility → Decision) plus a downloadable HTML report and
Excel workbook. Everything runs inside the app — no CLI, no flags.

Built on the `app-starter` conventions: Hono + Node, behind the platform's Slack-OTP proxy, deployed
via Docker Compose on the `raed_platform` network.

## How it works

1. **Intake** (`/`) — the five anchors (revenue model, ARR, growth, asked post-money, mode) or a
   free-text description. The five-anchor reminder is built in: if you give neither a description nor
   the anchors, the app tells you exactly what's missing.
2. **Classify & source** — `src/claude.js` calls `claude-opus-4-8` (adaptive thinking) with the
   pricing rules + the sourced-multiple library in `src/knowledge.js`, and a structured-output schema.
   Claude returns a validated deal config, a rationale, and a list of flagged assumptions. It never
   fabricates a multiple — unsourced sectors come back `null` and flagged.
3. **Render** — `src/engine.js` (the Node port of the repo's `build_html.py`) turns the config into
   the standalone interactive tool. The same config drives the Excel workbook, so the two agree.

The **deal config is the contract** — see [`docs/deal-config-schema.md`](docs/deal-config-schema.md).

## The Claude API key

The platform injects shared API keys into every app's environment, so **`ANTHROPIC_API_KEY` is
already present in production** — nothing to configure. To override with your own key for a running
instance, use **Settings** (`/settings`); it's held in memory only (resets on restart). The durable
place is the platform env / `.env`.

## Run locally

```bash
npm install
cp .env.example .env        # then put your ANTHROPIC_API_KEY in .env (or set it in /settings)
PORT=3000 npm run dev
# open http://localhost:3000/?fake_email=you@raed.vc
```

`?fake_email=…` stands in for the proxy's `X-Auth-Email` header when `NODE_ENV !== 'production'`.

Excel export needs Python + `openpyxl` locally (`pip install openpyxl`); the Docker image installs
them automatically. Without Python, the HTML tool and report still work — only the `.xlsx` button is
unavailable.

## Deploy

Push to GitHub, then use the platform deploy form (repo URL + app name). The proxy handles TLS,
login, your subdomain, and injects `ANTHROPIC_API_KEY`. Do not change the `app` service name,
`${APP_NAME}-app` container name, or the `raed_platform` network in `docker-compose.yml`.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | Opportunity intake form |
| `POST /price` | Run Claude → validate → store → redirect to the result |
| `GET /deal/:id` | Result page: rationale, sourced multiples, assumptions, downloads |
| `GET /tool/:id` | The interactive pricing tool (full HTML) |
| `GET /download/:id/html` · `/xlsx` | Standalone HTML / Excel workbook |
| `GET /api/deal/:id` | The deal config JSON |
| `GET /settings` · `POST /settings` | Claude API key override |
| `GET /healthz` | Health check (unauthenticated) |

## Files

```
src/server.js     Hono app: auth, intake form, pricing pipeline, render, downloads, settings
src/claude.js     Anthropic SDK call → validated deal config (claude-opus-4-8, structured output)
src/knowledge.js  the pricing rules + SOURCED multiple library + the deal-config JSON schema
src/engine.js     render the tool + validate the config (Node port of build_html.py / validate_deal.py)
assets/           pricing_template.html (the generic tool) + build_excel.py + validate_deal.py
```

## Note on persistence

Priced deals are held in memory (a server restart clears them) — fine for the single-instance internal
tool. To make deals durable and shareable by URL, add a datastore (SQLite/Postgres) keyed by deal id.
