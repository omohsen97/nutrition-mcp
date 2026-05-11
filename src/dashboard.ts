import { Hono } from "hono";
import type { Context } from "hono";
import crypto from "node:crypto";
import {
    getMealsByDate,
    getMealsInRange,
    getProfile,
    getStepsInRange,
    getUserTimezone,
    getWeightInRange,
    signInUser,
    storeToken,
    upsertTodaysSteps,
    upsertTodaysWeight,
    type Meal,
} from "./supabase.js";
import {
    calculateEER,
    getDRITargets,
    type ActivityLevel,
    type ProfileData,
} from "./health.js";
import { DEFAULT_TIMEZONE, todayInZone, dateInZone } from "./timezone.js";
import { authenticateBearer } from "./middleware.js";

// =============================================================================
// Personal nutrition dashboard
//
// Exposes:
//   GET  /dashboard/setup        — login form (returns a long-lived bearer
//                                  token + ready-to-paste Scriptable config)
//   POST /dashboard/setup        — auths, issues a fresh token
//   GET  /dashboard/nutrition    — JSON snapshot for the widget (bearer auth)
// =============================================================================

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function sumMacro(meals: Meal[], key: keyof Meal): number {
    return meals.reduce((s, m) => s + ((m[key] as number | null) ?? 0), 0);
}

// EER's activity multiplier already includes the user's typical daily movement.
// Adding raw step calories on top would double-count for anyone who isn't
// "inactive." This factor scales step calories down so they only contribute the
// portion that's likely *above* what their declared activity level already
// implies. Bias is intentionally conservative — better to under-count burn
// than to over-claim a deficit.
function conservativeStepFactor(level: ActivityLevel | undefined): number {
    switch (level) {
        case "inactive":
            return 0.7;
        case "low_active":
            return 0.35;
        case "active":
            return 0.15;
        case "very_active":
            return 0;
        default:
            return 0.3;
    }
}

function relativeTimeFromNow(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime();
    const min = Math.round(diffMs / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
}

interface MacroTarget {
    actual: number;
    target_rda?: number;
    target_min?: number;
    target_max?: number;
}

interface DashboardPayload {
    generated_at: string;
    timezone: string;
    today: {
        date: string;
        meals_count: number;
        calories_in: number;
        calories_out: number;
        balance: number;
        eer: number | null;
        step_calories_raw: number;
        step_calories_adjusted: number;
        step_calories_factor: number;
        steps: number;
        macros: {
            protein_g: MacroTarget;
            carbs_g: MacroTarget;
            fat_g: MacroTarget;
        };
        targets_known: boolean;
    };
    week: {
        days: number;
        avg_calories: number;
        avg_balance: number;
        total_steps: number;
        weight_kg_start: number | null;
        weight_kg_end: number | null;
        weight_kg_delta: number | null;
    };
    weight_graph: {
        weeks: { week_start: string; min_weight_kg: number | null }[];
    };
    last_meal: {
        description: string;
        meal_type: string | null;
        logged_at: string;
        relative: string;
    } | null;
    profile: {
        exists: boolean;
        activity_level: ActivityLevel | null;
    };
}

// Pull 8 weeks of weight data, group by ISO week (Mon-anchored), and emit the
// minimum weight per week — the user's "lowest point on the scale" trend.
async function buildWeightGraph(
    userId: string,
    tz: string,
    weeks: number,
): Promise<{ week_start: string; min_weight_kg: number | null }[]> {
    const days = weeks * 7;
    const end = new Date();
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - days);
    const startStr = dateInZone(start, tz);
    const endStr = dateInZone(end, tz);
    const entries = await getWeightInRange(userId, startStr, endStr, tz);

    // Build a fixed-size array of week buckets so the graph always has the
    // right shape even when there are no measurements in a given week.
    const result: { week_start: string; min_weight_kg: number | null }[] = [];
    const today = new Date();
    for (let i = weeks - 1; i >= 0; i--) {
        const weekDate = new Date(today);
        weekDate.setUTCDate(weekDate.getUTCDate() - i * 7);
        // Snap to Monday of that week (UTC) for stable bucket keys
        const dayOfWeek = (weekDate.getUTCDay() + 6) % 7; // Mon=0..Sun=6
        weekDate.setUTCDate(weekDate.getUTCDate() - dayOfWeek);
        weekDate.setUTCHours(0, 0, 0, 0);
        const weekStart = weekDate.toISOString().slice(0, 10);
        result.push({ week_start: weekStart, min_weight_kg: null });
    }
    const indexByWeek = new Map(result.map((r, i) => [r.week_start, i]));

    for (const e of entries) {
        const d = new Date(e.logged_at);
        const dayOfWeek = (d.getUTCDay() + 6) % 7;
        const monday = new Date(d);
        monday.setUTCDate(monday.getUTCDate() - dayOfWeek);
        monday.setUTCHours(0, 0, 0, 0);
        const key = monday.toISOString().slice(0, 10);
        const idx = indexByWeek.get(key);
        if (idx == null) continue;
        const bucket = result[idx]!;
        if (
            bucket.min_weight_kg == null ||
            e.weight_kg < bucket.min_weight_kg
        ) {
            bucket.min_weight_kg = e.weight_kg;
        }
    }

    return result;
}

export async function buildDashboardPayload(
    userId: string,
): Promise<DashboardPayload> {
    const profile = await getProfile(userId);
    const tz = profile?.timezone ?? (await getUserTimezone(userId)) ?? DEFAULT_TIMEZONE;

    const today = todayInZone(tz);
    const weekStart = (() => {
        // 6 days back inclusive so "week" = today + 6 prior days (7 days total)
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - 6);
        return dateInZone(d, tz);
    })();

    const [todayMeals, weekMeals, weekSteps, weekWeight, weightGraph] =
        await Promise.all([
            getMealsByDate(userId, today, tz),
            getMealsInRange(userId, weekStart, today, tz),
            getStepsInRange(userId, weekStart, today, tz),
            getWeightInRange(userId, weekStart, today, tz),
            buildWeightGraph(userId, tz, 8),
        ]);

    // Today's totals
    const caloriesIn = sumMacro(todayMeals, "calories");
    const proteinIn = sumMacro(todayMeals, "protein_g");
    const carbsIn = sumMacro(todayMeals, "carbs_g");
    const fatIn = sumMacro(todayMeals, "fat_g");

    const stepsTodayEntries = weekSteps.filter(
        (s) => dateInZone(new Date(s.logged_at), tz) === today,
    );
    const stepsToday = stepsTodayEntries.reduce((s, e) => s + e.step_count, 0);
    const rawStepCaloriesToday = stepsTodayEntries.reduce(
        (s, e) => s + (e.calories_burned ?? 0),
        0,
    );

    const stepFactor = conservativeStepFactor(
        profile?.activity_level as ActivityLevel | undefined,
    );
    const adjustedStepCaloriesToday = Math.round(
        rawStepCaloriesToday * stepFactor,
    );

    const eer = profile ? calculateEER(profile as ProfileData) : null;
    const targets = profile ? getDRITargets(profile as ProfileData) : null;

    const caloriesOut = (eer ?? 0) + adjustedStepCaloriesToday;
    const balance = caloriesIn - caloriesOut;

    // Week aggregates by day
    const dayBuckets = new Map<
        string,
        { calories: number; balance: number | null }
    >();
    for (const m of weekMeals) {
        const d = dateInZone(new Date(m.logged_at), tz);
        const bucket = dayBuckets.get(d) ?? { calories: 0, balance: null };
        bucket.calories += m.calories ?? 0;
        dayBuckets.set(d, bucket);
    }
    // Per-day balance using EER + conservatively-adjusted step calories. Uses
    // the SAME factor as today so the displayed trend stays consistent.
    if (eer != null) {
        const stepCalByDay = new Map<string, number>();
        for (const s of weekSteps) {
            const d = dateInZone(new Date(s.logged_at), tz);
            stepCalByDay.set(
                d,
                (stepCalByDay.get(d) ?? 0) + (s.calories_burned ?? 0),
            );
        }
        for (const [date, bucket] of dayBuckets) {
            const rawCal = stepCalByDay.get(date) ?? 0;
            const adjusted = rawCal * stepFactor;
            bucket.balance = bucket.calories - (eer + adjusted);
        }
    }
    const dayCount = Math.max(1, dayBuckets.size);
    const avgCalories = Math.round(
        [...dayBuckets.values()].reduce((s, b) => s + b.calories, 0) / dayCount,
    );
    const balanceValues = [...dayBuckets.values()]
        .map((b) => b.balance)
        .filter((v): v is number => v != null);
    const avgBalance =
        balanceValues.length > 0
            ? Math.round(
                  balanceValues.reduce((s, v) => s + v, 0) /
                      balanceValues.length,
              )
            : 0;

    const weekTotalSteps = weekSteps.reduce((s, e) => s + e.step_count, 0);

    // Weight: earliest vs latest entry within the week
    let weightStart: number | null = null;
    let weightEnd: number | null = null;
    if (weekWeight.length > 0) {
        weightStart = weekWeight[0]!.weight_kg;
        weightEnd = weekWeight[weekWeight.length - 1]!.weight_kg;
    }

    // Last meal (anywhere in the last week)
    const lastMeal = weekMeals[weekMeals.length - 1] ?? null;

    return {
        generated_at: new Date().toISOString(),
        timezone: tz,
        today: {
            date: today,
            meals_count: todayMeals.length,
            calories_in: Math.round(caloriesIn),
            calories_out: Math.round(caloriesOut),
            balance: Math.round(balance),
            eer,
            step_calories_raw: Math.round(rawStepCaloriesToday),
            step_calories_adjusted: adjustedStepCaloriesToday,
            step_calories_factor: stepFactor,
            steps: stepsToday,
            macros: {
                protein_g: {
                    actual: Math.round(proteinIn * 10) / 10,
                    target_rda: targets?.protein_g.rda,
                },
                carbs_g: {
                    actual: Math.round(carbsIn * 10) / 10,
                    target_rda: targets?.carbs_g.rda,
                },
                fat_g: {
                    actual: Math.round(fatIn * 10) / 10,
                    target_min: targets?.fat_g.min,
                    target_max: targets?.fat_g.max,
                },
            },
            targets_known: targets != null,
        },
        week: {
            days: dayCount,
            avg_calories: avgCalories,
            avg_balance: avgBalance,
            total_steps: weekTotalSteps,
            weight_kg_start: weightStart,
            weight_kg_end: weightEnd,
            weight_kg_delta:
                weightStart != null && weightEnd != null
                    ? Math.round((weightEnd - weightStart) * 10) / 10
                    : null,
        },
        weight_graph: { weeks: weightGraph },
        last_meal: lastMeal
            ? {
                  description: lastMeal.description,
                  meal_type: lastMeal.meal_type,
                  logged_at: lastMeal.logged_at,
                  relative: relativeTimeFromNow(lastMeal.logged_at),
              }
            : null,
        profile: {
            exists: profile != null,
            activity_level: (profile?.activity_level as ActivityLevel) ?? null,
        },
    };
}

// ---------- Setup page ----------

function renderSetupForm(error?: string): string {
    const errorHtml = error
        ? `<p style="background:#fff3f3;border:1px solid #f4a;border-radius:6px;padding:10px;color:#900;margin-bottom:12px">${escapeHtml(error)}</p>`
        : "";
    return `<!doctype html><html><head>
<meta charset=utf-8><title>Nutrition Dashboard Setup</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:3rem auto;padding:0 1rem;color:#222}
h1{font-size:1.5rem;margin-bottom:.25rem}
p.lead{color:#555;margin-top:0}
form{display:flex;flex-direction:column;gap:10px;margin-top:1.5rem}
label{font-size:.85rem;color:#444}
input{font-size:1rem;padding:10px;border:1px solid #ccc;border-radius:6px}
button{font-size:1rem;padding:10px 14px;border:0;border-radius:6px;background:#1c7;color:white;cursor:pointer;margin-top:.5rem}
button:hover{background:#0a5}
</style></head><body>
<h1>Nutrition Dashboard Setup</h1>
<p class="lead">Sign in (same email/password you use when connecting the MCP) to mint a dashboard token. Paste it into the Scriptable widget on your phone.</p>
${errorHtml}
<form method="POST" action="/dashboard/setup">
  <label>Email<input type="email" name="email" required autocomplete="email"></label>
  <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
  <button type="submit">Mint dashboard token</button>
</form>
</body></html>`;
}

function buildBootstrapScript(baseUrl: string, token: string): string {
    // Tiny script the user pastes ONCE into Scriptable. On every refresh it
    // fetches the latest widget code from /dashboard/scriptable.js, caches it
    // locally for offline use, and eval()s it with API_URL + API_TOKEN in
    // scope. Future widget changes deploy automatically — no re-paste.
    const apiUrl = `${baseUrl}/dashboard/nutrition`;
    const scriptUrl = `${baseUrl}/dashboard/scriptable.js`;
    const syncUrl = `${baseUrl}/dashboard/health-sync`;
    return `// Auto-updating nutrition widget bootstrap (paste once)
// Health sync endpoint (for your Shortcut): ${syncUrl}
const API_URL = "${apiUrl}";
const API_TOKEN = "${token}";
const SCRIPT_SOURCE = "${scriptUrl}";

const fm = FileManager.local();
const cachePath = fm.joinPath(
    fm.documentsDirectory(),
    "_nutrition-widget.cache.js",
);

let code = null;
try {
    const req = new Request(SCRIPT_SOURCE);
    req.timeoutInterval = 8;
    code = await req.loadString();
    fm.writeString(cachePath, code);
} catch (err) {
    if (fm.fileExists(cachePath)) code = fm.readString(cachePath);
}

if (code) {
    await eval(\`(async () => { \${code} })()\`);
} else {
    const w = new ListWidget();
    const t = w.addText("⚠ Could not load widget code (offline and no cache).");
    t.font = Font.systemFont(11);
    t.textColor = new Color("#ef4444");
    if (config.runsInWidget) Script.setWidget(w);
    else w.presentLarge();
    Script.complete();
}
`;
}

function buildShortcutInstructions(baseUrl: string, token: string): string {
    const syncUrl = `${baseUrl}/dashboard/health-sync`;
    return `Build this once in the Shortcuts app. Each numbered step is one action — tap the search bar at the bottom of the editor and type the action name in bold.

CREATE THE SHORTCUT
===================

Open Shortcuts → tap + (top right) → tap the shortcut title and rename to "Sync Health Data". Then add these actions in order:

1. **Find Health Samples**
   - Tap "Step Count" if it's not already the Sample type
   - Tap the existing "Date" filter, set to: Start Date is after Start of Today
   - Leave Order and Limit as defaults
   (This gives you every step sample logged today.)

2. **Calculate Statistics**
   - Operation: Sum
   - Numbers input: tap the field, select the "Health Samples" magic variable from step 1
   (Total daily steps as a single number.)

3. **Set Variable**
   - Name: Steps
   - Value: the "Statistics Result" magic variable from step 2

4. **Find Health Samples** (a second one)
   - Sample type: Body Mass (or "Weight" on older iOS)
   - Order: Latest First
   - Limit: 1
   (Most recent weight reading.)

5. **Get Details of Health Samples**
   - Input: the Health Samples variable from step 4
   - Detail: Quantity (gives the numeric kg value)

6. **Set Variable**
   - Name: WeightKg
   - Value: the "Quantity" magic variable from step 5

7. **Get Contents of URL**
   - URL: ${syncUrl}
   - Tap "Show More" to reveal the rest of the fields
   - Method: POST
   - Headers (tap "Add new header"):
       Authorization → Bearer ${token}
       Content-Type  → application/json
   - Request Body: JSON
       - Add key "steps" → tap value → choose Number → pick the "Steps" variable
       - Add key "weight_kg" → tap value → choose Number → pick the "WeightKg" variable

Tap Done. Run the shortcut once to test — you should get a green "ok: true" response.

AUTOMATE IT
===========

Shortcuts app → Automation tab → New (top right) → Time of Day → set 30-min or hourly cadence → Next → Run Shortcut → pick "Sync Health Data" → toggle OFF "Ask Before Running" → Done.

From now on your steps and weight push to the server automatically, and the widget reads from there.

TROUBLESHOOTING
===============
- "I don't see Get Details of Health Samples" → search for "Get Numbers from Input", same effect.
- "Find Health Samples" missing → ensure Health permission was granted when prompted on first run.
- Response shows "invalid_weight_kg" → the weight came back in lbs. Add a "Convert Measurement" action before step 6 to convert pounds to kilograms.`;
}

async function renderSetupResult(
    baseUrl: string,
    token: string,
): Promise<string> {
    const bootstrap = buildBootstrapScript(baseUrl, token);
    const shortcutNotes = buildShortcutInstructions(baseUrl, token);

    return `<!doctype html><html><head>
<meta charset=utf-8><title>Dashboard token minted</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.5rem;margin-bottom:.25rem}
h2{font-size:1.1rem;margin-top:2rem}
p.lead{color:#555;margin-top:0}
pre{background:#f4f4f4;border-radius:6px;padding:10px;font-family:ui-monospace,Menlo,monospace;font-size:.75rem;line-height:1.35;max-height:32vh;overflow:auto;white-space:pre;word-break:normal}
ol{padding-left:1.2rem}
ol li{margin-bottom:.5rem}
.warn{background:#fffbea;border:1px solid #e6c44a;border-radius:6px;padding:10px;font-size:.85rem;color:#5a4500;margin-top:1.5rem}
.note{background:#eef6ff;border:1px solid #b9d7ff;border-radius:6px;padding:10px;font-size:.85rem;color:#1d4f8a;margin-top:.75rem}
button.copy{font-size:1rem;padding:10px 16px;border:0;border-radius:6px;background:#1c7;color:white;cursor:pointer;margin:.75rem 0}
button.copy:hover{background:#0a5}
button.copy.copied{background:#444}
</style></head><body>
<h1>Token minted ✓</h1>
<p class="lead">Paste the bootstrap below into Scriptable ONCE — every future widget update I push deploys automatically. No re-paste, ever.</p>

<button class="copy" id="copyBoot" data-target="bootstrap">📋 Copy bootstrap script</button>

<ol>
  <li>Install <strong>Scriptable</strong> from the App Store.</li>
  <li>Open Scriptable → tap <strong>+</strong> (top-right).</li>
  <li>Long-press the editor → <strong>Paste</strong>.</li>
  <li>Tap the script name at the top, rename to <code>nutrition-widget</code>, tap Done.</li>
  <li>Home screen → long-press empty area → <strong>+</strong> → search "Scriptable" → swipe to <strong>Large</strong> → Add Widget.</li>
  <li>Tap the widget → <strong>Script</strong> → pick <code>nutrition-widget</code>.</li>
</ol>

<details open><summary style="cursor:pointer;font-size:.85rem;color:#666">View bootstrap source</summary>
<pre id="bootstrap">${escapeHtml(bootstrap)}</pre>
</details>

<div class="note">
The bootstrap caches the widget code locally, so the widget still works briefly when offline. Tap the widget any time to force-refresh.
</div>

<h2>Optional — push iPhone Health steps + weight</h2>
<p class="lead">Set up a Shortcut + hourly automation so your Health data flows into the dashboard.</p>

<button class="copy" id="copyShort" data-target="shortcut">📋 Copy Shortcut instructions</button>

<details><summary style="cursor:pointer;font-size:.85rem;color:#666">View Shortcut steps</summary>
<pre id="shortcut">${escapeHtml(shortcutNotes)}</pre>
</details>

<p class="warn">Treat the token like a password — anyone with it can read or write your data. Lose this tab? Just re-mint here (old tokens stay valid 365 days unless revoked).</p>

<script>
document.querySelectorAll('button.copy').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const text = document.getElementById(btn.dataset.target).textContent;
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = '✓ Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 2000);
    } catch {
      document.getElementById(btn.dataset.target).parentElement.open = true;
      const range = document.createRange();
      range.selectNode(document.getElementById(btn.dataset.target));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      btn.textContent = 'Tap and hold the code below → Copy';
    }
  });
});
</script>
</body></html>`;
}

export function createDashboardRouter() {
    const dashboard = new Hono<{
        Variables: { userId: string; accessToken: string };
    }>();

    function getBaseUrl(c: Context): string {
        const proto = c.req.header("x-forwarded-proto") || "http";
        const host =
            c.req.header("x-forwarded-host") || c.req.header("host");
        if (host) return `${proto}://${host}`;
        return new URL(c.req.url).origin;
    }

    dashboard.get("/setup", (c) => c.html(renderSetupForm()));

    dashboard.post("/setup", async (c) => {
        const body = await c.req.parseBody();
        const email = (body.email as string)?.trim().toLowerCase();
        const password = body.password as string;
        if (!email || !password) {
            return c.html(renderSetupForm("Email and password are required."), 400);
        }
        let userId: string;
        try {
            userId = await signInUser(email, password);
        } catch (err) {
            // Surface the actual sign-in error (e.g. "Invalid login credentials")
            // instead of falling back to sign-up — this is a token-mint flow,
            // not account creation.
            const raw =
                err instanceof Error ? err.message : "Authentication failed";
            const friendly = /invalid login credentials/i.test(raw)
                ? "Wrong email or password."
                : raw;
            return c.html(renderSetupForm(friendly), 400);
        }
        const token = crypto.randomUUID();
        await storeToken(token, userId);
        return c.html(await renderSetupResult(getBaseUrl(c), token));
    });

    dashboard.get("/nutrition", authenticateBearer, async (c) => {
        const userId = c.get("userId");
        const payload = await buildDashboardPayload(userId);
        c.header("Cache-Control", "no-store");
        return c.json(payload);
    });

    // Push HealthKit data (steps + weight) from the user's iOS Shortcut.
    // Idempotent — replaces today's entry on each call rather than appending.
    dashboard.post("/health-sync", authenticateBearer, async (c) => {
        const userId = c.get("userId");
        let body: { steps?: unknown; weight_kg?: unknown };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: "invalid_json" }, 400);
        }

        const profile = await getProfile(userId);
        const tz =
            profile?.timezone ??
            (await getUserTimezone(userId)) ??
            DEFAULT_TIMEZONE;

        const result: Record<string, unknown> = { ok: true };

        // Steps — calorie-burn estimate uses profile weight when available
        if (body.steps != null) {
            const steps = Number(body.steps);
            if (!Number.isFinite(steps) || steps < 0) {
                return c.json({ error: "invalid_steps" }, 400);
            }
            const weightKg = profile?.weight_kg ?? 70;
            const calories = Math.round(steps * 0.0005 * weightKg);
            const entry = await upsertTodaysSteps(
                userId,
                Math.round(steps),
                calories,
                tz,
            );
            result.steps = {
                step_count: entry.step_count,
                calories_burned: entry.calories_burned,
                logged_at: entry.logged_at,
            };
        }

        if (body.weight_kg != null) {
            const w = Number(body.weight_kg);
            if (!Number.isFinite(w) || w <= 0 || w > 500) {
                return c.json({ error: "invalid_weight_kg" }, 400);
            }
            const entry = await upsertTodaysWeight(userId, w, tz);
            result.weight = {
                weight_kg: entry.weight_kg,
                logged_at: entry.logged_at,
            };
        }

        return c.json(result);
    });

    // Serves the Scriptable widget source so the user can copy it on their
    // phone directly without needing to AirDrop.
    dashboard.get("/scriptable.js", async (c) => {
        const file = Bun.file("./widgets/nutrition-widget.js");
        if (!(await file.exists())) {
            return c.text("Widget source not bundled.", 404);
        }
        return c.body(await file.text(), 200, {
            "Content-Type": "application/javascript; charset=utf-8",
        });
    });

    return dashboard;
}
