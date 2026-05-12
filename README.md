# Health Tracker MCP

> A personal health-tracking system that lives behind Claude. Log meals by talking; track weight, steps, recipes, and Fitbit Air data; see the whole thing as a sleek iPhone widget; and get an aspirational forecast of when you'll hit your goal weight if you sustain your best week's pace.

Originally forked from [`akutishevsky/nutrition-mcp`](https://github.com/akutishevsky/nutrition-mcp) and significantly rebuilt. The maintainer's live instance runs at [`nutrition-mcp-production-8ba9.up.railway.app`](https://nutrition-mcp-production-8ba9.up.railway.app); self-hosting is fully supported (see [Self-hosting](#self-hosting)).

Current version: **4.1.0** · See [`HANDOFF.md`](HANDOFF.md) for the live working journal kept across Claude sessions.

---

## What it does

**Conversational meal logging.** "I had a chicken caesar wrap for lunch, large" → Claude estimates calories + macros and stores it. Editable, deletable, queryable by date range.

**Quick re-logging.**
- *Favorites* — save meals you eat regularly by name, re-log with one tool call.
- *Recipes* — composed meals with optional itemized ingredients and per-serving macros (auto-computed from the ingredient list).

**Weight + steps tracking.** Log weights, see trends; log step counts (or push them automatically from Apple HealthKit via an iOS Shortcut). EER + DRI targets computed using Mifflin–St Jeor.

**Daily intelligence.**
- *Daily summary* — calories in vs out (EER + step-derived burn, conservatively adjusted to avoid double-counting), macros vs DRI targets, deficit/surplus.
- *DRI targets* — protein RDA, carb RDA, fat range, fibre, water — all personalized.
- *Nutrient lookup* — search Canada's Canadian Nutrient File for any food.

**Fitbit Air / Google Health integration.** OAuth (PKCE) into the Google Health API, sync all 30+ data types (sleep, heart rate, HRV, VO2 max, activity, weight, etc.) into Supabase. Read-only — Google doesn't allow third-party writes for nutrition.

**iPhone home-screen widget.** Large Scriptable widget showing:
- Today's calories vs target (or any of the last 7 days via day strip)
- 3 macros with progress
- **Aspirational forecast**: "If you nail it — 115 kg by Jun 17 (36 days), at your best week's pace"
- 8-week weight graph with target lines, axes labels, and best-week highlighted
- Optional LLM insight ("Protein lagging — aim for a 30g+ source at dinner")
- Auto-updating bootstrap pattern — paste once, future changes deploy automatically

[Browser preview](https://nutrition-mcp-production-8ba9.up.railway.app/dashboard/preview) renders the widget in any browser for design audits.

---

## MCP Tools (35 total)

| Category | Tool | Purpose |
|---|---|---|
| **Meals** | `log_meal` | Log a meal (description, type, calories, macros, notes) |
| | `get_meals_today` | Today's meals |
| | `get_meals_by_date` | Meals on a specific YYYY-MM-DD |
| | `get_meals_by_date_range` | Meals across a date range |
| | `get_nutrition_summary` | Daily macro totals across a range |
| | `update_meal` | Edit any field of a logged meal |
| | `delete_meal` | Delete by ID |
| **Favorites** | `save_meal_favorite` | Save a meal as a named favorite |
| | `list_meal_favorites` | List favorites, most-recently-used first |
| | `log_meal_from_favorite` | Re-log a favorite by name (bumps use count) |
| | `delete_meal_favorite` | Delete a favorite |
| **Recipes** | `save_recipe` | Create/update a recipe with optional ingredients (auto per-serving macros) |
| | `list_recipes` | List all recipes |
| | `get_recipe` | Full recipe with ingredients |
| | `log_recipe` | Log N servings of a recipe as a meal entry |
| | `delete_recipe` | Delete a recipe (ingredients cascade) |
| **Weight** | `log_weight` | Log a weight entry (syncs to profile) |
| | `get_weight_history` | Weight entries across a range with delta |
| | `delete_weight` | Delete a weight entry |
| **Steps** | `log_steps` | Log a step count (auto-estimates calorie burn) |
| | `get_steps_history` | Steps + cal burned across a range |
| | `delete_steps` | Delete a step entry |
| **Profile** | `set_profile` | Age, sex, height, weight, activity level, timezone |
| | `get_profile` | Current profile + estimated daily calorie needs (EER) |
| | `set_timezone` | Update IANA timezone only |
| **Analysis** | `get_dri_targets` | Personalized DRI targets (cals, P/C/F, fibre, water) |
| | `get_daily_summary` | Full day: in vs out, balance, macros vs targets |
| | `lookup_nutrient` | Search the Canadian Nutrient File |
| **Google Health** | `google_health_connect` | Returns the OAuth URL to authorize Fitbit Air / Google Health |
| | `google_health_status` | Connection status + per-data-type sync state |
| | `google_health_sync` | Pull data points for a time range |
| | `google_health_get_data_points` | Query stored data points by type |
| | `list_google_health_data_types` | List all 30+ data types Google Health exposes |
| | `google_health_disconnect` | Revoke + delete tokens |
| **Account** | `delete_account` | Permanently delete account + all data (irreversible) |

---

## iPhone widget

The Scriptable widget pulls its data from `/dashboard/nutrition` and is updated continuously without re-pasting the code — a small bootstrap script runs first, fetches the latest widget source from `/dashboard/scriptable.js`, and `eval`s it.

### One-time setup

1. Mint a long-lived dashboard token: visit `/dashboard/setup`, sign in with your MCP credentials.
2. Tap **Copy widget script** on the result page (the snippet has your `API_URL` + `API_TOKEN` already filled in).
3. Install [Scriptable](https://scriptable.app) (free) on your iPhone.
4. Open Scriptable → **+** → paste the bootstrap → name it `nutrition-widget` → Done.
5. Long-press home screen → **+** → search "Scriptable" → swipe to **Large** → Add Widget → tap it → set Script to `nutrition-widget`.

Tap a day in the strip to navigate; tap anywhere else to reset to today.

### Design preview

Open `/dashboard/preview` in any browser to see a faithful HTML mockup of the widget. Pass `?token=…` to render against your real data, `?theme=dark` to switch palette. Used for design audits without rebuilding to a phone every time.

---

## iOS HealthKit Shortcut

The widget reads steps + weight from Supabase. To get them in, you build a one-time iOS Shortcut that:

1. Finds Health Samples → Step Count → today → calculates the sum.
2. Finds Health Samples → Body Mass → latest 1.
3. POSTs `{ "steps": ..., "weight_kg": ... }` to `/dashboard/health-sync` with `Authorization: Bearer <your-token>`.

Detailed step-by-step instructions render on `/dashboard/setup` after sign-in (a few iOS versions worth of UI differences accounted for). Recommended automation trigger: **When Scriptable is opened** or **When Claude is closed** — fires the sync naturally around the times you'd want fresh numbers.

The `/dashboard/health-sync` endpoint accepts case-insensitive keys (`steps`/`Steps`/`STEPS`, `weight_kg`/`Weight_Kg`/`WeightKg`) and returns a loud `no_fields` error if neither is present, so a misconfigured Shortcut fails fast instead of falsely returning `ok`.

---

## LLM-generated insights

When `ANTHROPIC_API_KEY` is set in the environment, the dashboard payload includes a one-line nutrition observation generated by **Claude Haiku 4.5** ("Protein lagging — save 40g for dinner", "Sodium spiked yesterday too", etc.). Cached 15 min per user; cache key is the meal IDs in scope, so logging a new meal invalidates the cache and produces a fresh insight on next refresh. Falls back gracefully when the API key isn't set or the call fails.

---

## Aspirational weight forecast

The forecast section ("If you nail it") is **deliberately optimistic but grounded**. The logic, in priority order:

1. **`best_week`** — find the steepest week-over-week weight loss the user has actually achieved across their 8-week minima, **capped at -1.5 kg/wk** so a single water-weight swing doesn't dominate. Project at that pace.
2. **`best_day`** — if weight data is too sparse, find the biggest single-day calorie deficit from the last 7 days, **capped at -1500 kcal/day**. Project at that pace every day.
3. **`insufficient_data`** — not enough history yet to be honest.

A `rationale` field on the payload tells the widget exactly which assumption powers the ETA, so the optimism is *transparent* — the widget shows you "if you match your best week so far (0.70 kg/wk)" right below the dates.

---

## Tech stack

- **Bun** — runtime and package manager
- **Hono** — HTTP framework
- **MCP SDK** — Model Context Protocol over Streamable HTTP
- **Supabase** — Postgres + Auth, accessed via service role key
- **OAuth 2.0** — for both MCP client auth and Google Health
- **Anthropic API** — Claude Haiku 4.5 for nutrition insights
- **Google Health API** — Fitbit Air / wearable data ingestion (read-only)
- **Scriptable** — iPhone widget runtime (JS)
- **Railway** — production hosting; **Docker** for portable deploy

---

## HTTP endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /` | none | Landing page (includes the widget bootstrap card) |
| `GET /health` | none | Liveness probe |
| `GET /privacy` | none | Privacy & terms |
| `GET /.well-known/oauth-authorization-server` | none | MCP OAuth metadata |
| `GET /.well-known/oauth-protected-resource` | none | MCP resource metadata |
| `POST /register` | none | Dynamic client registration |
| `GET /authorize` | none | MCP OAuth — login page |
| `POST /approve` | session | MCP OAuth — login submit |
| `POST /token` | client creds | MCP OAuth — token exchange |
| `ALL /mcp` | Bearer | MCP server endpoint |
| `GET /dashboard/setup` | none | Token-mint sign-in form |
| `POST /dashboard/setup` | email+pwd | Mints a dashboard token, returns bootstrap |
| `GET /dashboard/nutrition` | Bearer | Widget JSON payload (`?date=` to pick a day) |
| `POST /dashboard/health-sync` | Bearer | Accepts Health data from the iOS Shortcut |
| `GET /dashboard/scriptable.js` | none | Latest widget source (for the bootstrap) |
| `GET /dashboard/preview` | none | Browser-rendered widget mockup |
| `GET /google-health/callback` | OAuth state | Google Health OAuth return URL |

---

## Self-hosting

### Prerequisites

- Bun installed locally (for development)
- A [Supabase](https://supabase.com) project (free tier is enough)
- A hosting target with Docker support (Railway, Fly.io, DigitalOcean App Platform, etc.)

### Database setup

The schema lives in `supabase/migrations/`. Apply with the Supabase CLI:

```bash
supabase login                              # one-time; opens browser OR use SUPABASE_ACCESS_TOKEN
supabase link --project-ref <your-ref>
supabase db push --include-all
```

If you can't use the CLI, paste [`supabase-full-setup.sql`](supabase-full-setup.sql) into your Supabase SQL Editor instead — it bundles all migrations into a single executable script for fresh installs.

In Supabase, also enable **Email Auth** (Authentication → Providers → Email) and disable email confirmation if you want sign-ups to be immediate.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | Your Supabase project URL |
| `SUPABASE_SECRET_KEY` | yes | Service role key (bypasses RLS) |
| `OAUTH_CLIENT_ID` | yes | Random string for MCP client identification |
| `OAUTH_CLIENT_SECRET` | yes | Random string for MCP client authentication |
| `PORT` | no | Server port (default `8080`) |
| `ALLOWED_ORIGINS` | no | Comma-separated origins for CORS (localhost always allowed) |
| `PUBLIC_BASE_URL` | no | Used to build OAuth callback URLs if you have a custom domain |
| `ANTHROPIC_API_KEY` | no | Enables the LLM insight in the dashboard payload |
| `GOOGLE_HEALTH_CLIENT_ID` | no | Google Cloud OAuth client ID — required for Fitbit Air integration |
| `GOOGLE_HEALTH_CLIENT_SECRET` | no | Google Cloud OAuth client secret |

Generate the OAuth strings:

```bash
openssl rand -hex 16     # OAUTH_CLIENT_ID
openssl rand -hex 32     # OAUTH_CLIENT_SECRET
```

### Local dev

```bash
bun install
cp .env.example .env             # fill in your credentials
bun run dev                      # hot reload on http://localhost:8080
```

### Deploy (Railway)

```bash
railway login
railway link                     # connect to your service
railway up --detach              # builds + deploys via the included Dockerfile
```

Or push to any platform that auto-builds a `Dockerfile`. Set the env vars listed above.

### Google Health (Fitbit Air) setup

1. Create a Google Cloud project; enable the **Google Health API**.
2. Configure the OAuth consent screen as External, add your own email as a test user (test mode is fine for personal use; refresh tokens expire after 7 days unless you go through verification).
3. Create OAuth 2.0 credentials → Web application → add `https://<your-domain>/google-health/callback` as an authorized redirect URI.
4. Set `GOOGLE_HEALTH_CLIENT_ID` and `GOOGLE_HEALTH_CLIENT_SECRET` in your environment.
5. From your MCP client, call `google_health_connect` — visit the returned URL, approve scopes, and you're done. Run `google_health_sync` periodically to pull new data points.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Claude (any client)                                          │
│  └─ MCP tools ──► /mcp (Bearer auth) ──► registerTools(...)   │
└──────────────────────────────────────────────────────────────┘
                            │
┌──────────────────────────────────────────────────────────────┐
│ Hono server (Bun)                                            │
│  /mcp                  ─ McpServer (35 tools)                │
│  /dashboard/setup      ─ token mint flow                      │
│  /dashboard/nutrition  ─ Bearer-auth JSON for the widget      │
│  /dashboard/health-sync─ HealthKit Shortcut sink              │
│  /dashboard/scriptable.js, /preview ─ widget delivery         │
│  /google-health/callback ─ OAuth return                       │
└──────────────────────────────────────────────────────────────┘
        │              │                  │               │
   Supabase      Anthropic API     Google Health API   File serving
   (Postgres)    (Haiku 4.5)       (Fitbit Air, etc.)   (widget JS,
   meals,        insights          read-only ingest      preview.html)
   weight,
   steps,
   recipes,
   favorites,
   profile,
   google_health_*,
   tokens
```

For deeper architectural decisions, version history, and open threads, see [`HANDOFF.md`](HANDOFF.md). That file is kept current across Claude Code sessions and is the canonical "where are we now" document.

---

## License

[MIT](LICENSE)
