# Session handoff — nutrition-mcp

> Read this first if you're picking up this project on a new device or in a fresh Claude session. It captures the project shape, recent work, key decisions, and open threads so you don't have to reconstruct context from the git log.

Last updated: **2026-05-12** (v4.1.0)

> **You're expected to update this file as you make changes.** Treat it as a living journal — the owner asked for continuous updates so future sessions don't drift. Whenever you commit something material, bump the version line above, append to "Recent work" at the top, and revise "Open threads" so the next session inherits an accurate picture. A stale HANDOFF is worse than no HANDOFF.

---

## What this project is

A Model Context Protocol (MCP) server for personal health tracking, owned by Omar Mohsen (`omohsen97`). Forked from `akutishevsky/nutrition-mcp`; the fork has diverged significantly. Hosted on Railway, backed by Supabase.

**Public surface:**
- MCP server at `https://nutrition-mcp-production-8ba9.up.railway.app/mcp` — connected to Omar's Claude clients (MCP UUIDs `3157ff2e` full-featured, `8cf568e3` upstream basic)
- Landing page at the same domain root
- Dashboard endpoints under `/dashboard/*` (auth via long-lived OAuth bearer tokens)

**Components:**
1. **MCP server** (Hono + Bun) — tools for meals, weight, steps, recipes, favorites, Google Health
2. **Supabase backend** (project `kwzcfjbewgrtuobhuwyc`) — Postgres with RLS, holds all user data
3. **Scriptable widget** (`widgets/nutrition-widget.js`) — large iPhone home-screen widget rendering a personal nutrition dashboard
4. **HTML preview** (`widgets/preview.html`) — browser mockup of the widget at `/dashboard/preview` for design audits without round-tripping to a phone
5. **iOS Shortcut** (configured manually) — bridges Apple HealthKit (steps, weight) → POST `/dashboard/health-sync`

---

## Recent work (in commit order, newest first)

- **README rewrite (pending commit)** — replaced the leftover `akutishevsky` README (which still pitched the upstream maintainer's URL, Ko-fi link, Medium article, and listed only 8 MCP tools) with a full project description. Covers all 35 current tools, iPhone widget setup, iOS HealthKit Shortcut, Google Health integration, LLM insights, aspirational forecast methodology, all 17+ HTTP endpoints, self-hosting steps, and an ASCII architecture diagram. Points readers to HANDOFF.md as the canonical living journal.
- **`fa134e1` feat: v4.1.0** — forecast pivoted from "depressing realistic" to **aspirational but grounded**. Old `regression` / `deficit` methods replaced by `best_week` (sustain your steepest observed weekly weight loss, capped at -1.5 kg/wk) and `best_day` (your biggest single-day calorie deficit projected forward, capped at -1500 kcal/day). New `rationale` field on the payload tells the widget exactly what assumption powers the ETA. Widget section renamed to "If you nail it" with green accent dates and a one-line rationale underneath. WEIGHT section header now carries current kg + 8w delta to fill previous dead space. Chart shrunk to fit (78px in Scriptable, 76px in preview) so the footer stays visible. Mirror in `widgets/preview.html` updated. Mockup screenshot-audited via Claude Preview before shipping.
- **`ad9e649` feat: widget design preview + session handoff** — added `/dashboard/preview` page (HTML mockup of the Scriptable widget that screenshot-audits cleanly via Claude Preview), wrote HANDOFF.md, added `.claude/launch.json` so any future session can spin up a local preview server with one command.
- **`1d6ed62` feat: v4.0.0** — weight forecast (regression + calorie-deficit hybrid — superseded by v4.1.0 above), day-strip nav, LLM insight via Claude Haiku 4.5, full visual redesign to a Mercury/Apple Wallet aesthetic, hardened health-sync handler with case-insensitive keys + loud no-fields error
- **`c5d542e` feat(landing)** — added iPhone widget bootstrap card on the landing page with one-paste copy button
- **`a68a52a` feat: v2.3.0** — meal favorites, recipes, Google Health (Fitbit Air) OAuth scaffolding, dashboard endpoint + Scriptable widget v1, auto-update bootstrap pattern
- **`1cf98e6` chore: personalize landing** — replaced upstream `akutishevsky` branding with Omar's; removed Ko-fi widget and upstream Google Analytics
- **`c0bbbeb` (upstream)** — switched EER formula to Mifflin–St Jeor

---

## File map

```
src/
  index.ts            ← Hono app — wires OAuth, MCP, dashboard, Google Health OAuth callback
  mcp.ts              ← all MCP tools (~35 tools). Server version is duplicated here, package.json, server.json.
  oauth.ts            ← MCP client OAuth flow (authorize, /approve form-login, /token endpoint)
  middleware.ts       ← bearer-auth middleware shared between /mcp and /dashboard
  supabase.ts         ← all Supabase queries + types
  favorites.ts        ← meal favorites + recipes CRUD
  googleHealth.ts     ← Google Health API client (OAuth, PKCE, token storage, sync)
  dashboard.ts        ← /dashboard/{setup,nutrition,health-sync,scriptable.js,preview}
                        + LLM insight (Anthropic API + cache)
                        + forecast computation (linear regression + calorie-deficit fallback)
  health.ts           ← EER + DRI math
  analytics.ts        ← tool_analytics persistence wrapper
  timezone.ts         ← IANA tz helpers

widgets/
  nutrition-widget.js ← the Scriptable widget served at /dashboard/scriptable.js
  preview.html        ← browser mockup served at /dashboard/preview

supabase/
  migrations/         ← Postgres schema. Two committed: 20260425*_add_timezone.sql,
                        20260510*_add_favorites_recipes_googlehealth.sql
  config.toml         ← local CLI config (project_id = "nutrition-mcp")

public/
  index.html          ← landing page
  privacy.html, styles.css, favicon.ico, login.html

supabase-full-setup.sql ← legacy "paste in SQL editor" path for fresh installs
```

---

## Operating commands

```bash
# Type-check (project uses Bun in production, but TS is installed for local check)
./node_modules/.bin/tsc --noEmit

# Deploy
railway up --detach
# … then poll until live:
until curl -s -o /dev/null -w '%{http_code}' \
  https://nutrition-mcp-production-8ba9.up.railway.app/health | grep -q 200; do
  sleep 5
done

# Apply Supabase migrations (requires user's personal access token)
SUPABASE_ACCESS_TOKEN=sbp_… supabase db push --include-all

# Inspect Railway env vars (read-only view)
railway variables --kv | grep '^SUPABASE\|^ANTHROPIC\|^GOOGLE_HEALTH'

# Query the database directly via the REST API (handy for verifying writes)
eval "$(railway variables --kv 2>/dev/null | grep -E '^SUPABASE_(URL|SECRET_KEY)=')"
curl "$SUPABASE_URL/rest/v1/<table>?…" \
  -H "apikey: $SUPABASE_SECRET_KEY" \
  -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
```

---

## Important architectural decisions

1. **Server version is in three places.** `package.json`, `server.json`, and the `McpServer` constructor in `src/mcp.ts`. Bump all three on a release. Currently **4.0.0**.

2. **Supabase migrations are now in source control.** `.gitignore` excludes `supabase/*` but un-ignores `supabase/migrations/` and `supabase/config.toml`. Anything we add to migrations should land in a commit.

3. **OAuth tokens are long-lived.** The MCP issues 365-day bearer tokens stored in `oauth_tokens`. The dashboard reuses the same tokens — `/dashboard/setup` is a separate mint flow that lands a token in the same table.

4. **The widget renders from a single endpoint.** `GET /dashboard/nutrition` returns one big JSON payload (`DashboardPayload`) covering today, week, weight graph, forecast, insight, last meal, day strip, profile. The widget is a pure renderer. Adding a new display element = add a field to the payload + render in the widget. No widget-side state beyond the persisted day selection.

5. **Day-strip tap UX is constrained by iOS.** Scriptable widgets cannot perform App-Intent button taps — those require a native iOS app. The current scheme: tap launches Scriptable via URL scheme, the script writes the selected date to a JSON file in `FileManager.local().documentsDirectory()`, then exits without `presentLarge()`. The widget reads the persisted date on its next iOS-scheduled refresh (typically 2–15 min later, hinted to 2 min). Selection auto-expires after 24h. The user has been told this is the floor; the alternative is to build a native iOS app.

6. **Insight uses Claude Haiku 4.5 (`claude-haiku-4-5`).** API key in Railway env as `ANTHROPIC_API_KEY` (was not yet set as of last check). Falls back gracefully when missing — surfaces `unavailable_reason` in the payload, widget skips rendering the insight line.

7. **Forecast is OPTIMISTIC, grounded in the user's own best.** As of v4.1.0 the model no longer averages — it finds the single best week's weight loss the user has actually achieved (capped at -1.5 kg/wk so a water-weight swing doesn't dominate) and projects forward at that pace. If weight data is too sparse, it falls back to the best single-day calorie deficit from the last week (capped at -1500 kcal/day for the same reason). The widget surfaces this with "your best pace, sustained" + a one-line rationale explaining the specific number. **Do not regress this to a population average or a depressive "realistic" projection** — the owner explicitly asked for aspirational copy.

8. **Conservative step-calorie adjustment.** EER's activity multiplier already accounts for typical movement, so step-derived calories are scaled down (0% for `very_active`, 70% for `inactive`) before being added to "calories out." Prevents double-counting that was producing flattering balances.

9. **Google Health API doesn't allow third-party nutrition writes.** Confirmed by checking `developers.google.com/health/data-types` — only weight, hydration, body fat, height, exercise, sleep are writable by external apps. Pushing meal calories *into* Google Health is not possible. Apple HealthKit is the realistic alternative if we ever want native health-app integration (allows dietary energy + macro writes), but requires either a native app or HealthKit-write Shortcuts actions.

---

## Open threads (priority order)

1. **Continue tightening the design.** v4.1.0 fixed the major dead-space issues (forecast was too short, WEIGHT header had empty middle, footer was being clipped). Open candidates for the next pass: the **insight line** still feels floaty between the TODAY header and CONSUMED — consider tucking it inline with the calorie hero or shrinking; the **macros bars** sometimes leave noticeable gap between bar end and the value when actuals are low; the **chart at 78px is on the small side** — if we can free space elsewhere we could give it 90px back. Iterate via Claude Preview screenshots first, mirror to Scriptable widget after.

2. **`ANTHROPIC_API_KEY` not yet set in Railway.** Until it lands, the insight section is hidden and the JSON shows `unavailable_reason: "ANTHROPIC_API_KEY env var not set…"`. User said they'd add it; verify with `railway variables --kv | grep ANTHROPIC` before assuming insight is broken for another reason.

3. **`GOOGLE_HEALTH_CLIENT_ID` / `GOOGLE_HEALTH_CLIENT_SECRET` not yet set.** Fitbit Air ships soon. When user is ready, walk them through creating a Google Cloud project, enabling the Google Health API, configuring the OAuth consent screen with their email as a test user, and pasting the credentials into Railway. Then they run `google_health_connect` from any MCP client. Note: test-mode refresh tokens expire after 7 days — they'll have to re-auth periodically until the app is verified.

4. **Native iOS app option discussed.** User asked about scope/time/cost for a native companion app that would unlock real interactive widgets. Outcome of that conversation: deferred — Scriptable's "tap-flash-app-and-bounce" is good enough for now. Path forward documented in case they revisit: native iOS app (Swift + WidgetKit + AppIntents) using free Apple ID + AltStore (auto-resign weekly) OR $99/yr Developer Program (1-yr signing). I would scaffold the Xcode project.

5. **Push to GitHub.** Two commits (`c5d542e`, `1d6ed62`) are local-only as of this handoff. User has not yet given the green light to `git push origin main`. Ask before pushing.

---

## How to continue this work on a new device

1. `git clone https://github.com/omohsen97/nutrition-mcp.git` (or `cd` into the existing checkout).
2. `bun install` (or `npm install` if you only need TS for type checks).
3. Read this file top-to-bottom.
4. Run `git log --oneline -15` to confirm you're at or after `1d6ed62`.
5. If you're going to touch deployed infrastructure: `railway whoami` to confirm you're logged in as `omarmohsen1018@gmail.com`, `railway link` if not yet linked to the `nutrition-mcp` service.
6. **Update this file when you stop** — replace "Last updated" at the top, append a new entry at the top of "Recent work", and revise "Open threads" so the next session starts where you finished.

---

## Things NOT to do

- Don't auto-commit. The owner explicitly approves each commit.
- Don't push to `origin` without confirmation. Same person, different question.
- Don't modify `.env` files (none in repo by design — secrets live in Railway).
- Don't update git config (`user.name` / `user.email`).
- Don't add new emoji-heavy or "fun" decorations to the widget — current design direction is Mercury / Apple Wallet sobriety. Owner has rejected a "neon mission control" attempt; staying away from that aesthetic.
- Don't commit the dev-only `package-lock.json` (project uses `bun.lock`).
