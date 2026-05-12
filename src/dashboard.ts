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
    // 7-day strip for the widget's day picker. Always covers the 7 calendar
    // days ending on the real "today" (not selected_date), so the strip is
    // stable as the user taps between days.
    week_strip: {
        date: string;
        weekday_short: string; // M, T, W, ...
        calories_in: number;
        balance: number | null;
        meals_count: number;
        is_today: boolean;
        is_selected: boolean;
    }[];
    selected_date: string;
    insight: {
        text: string | null;
        generated_at: string | null;
        cached: boolean;
        // Surface the underlying error so the widget can show a hint when
        // the API key isn't set without burning a request first.
        unavailable_reason: string | null;
    };
    weight_graph: {
        weeks: { week_start: string; min_weight_kg: number | null }[];
    };
    weight_forecast: {
        current_kg: number | null;
        // Aspirational slope used for projection. Always negative when a
        // forecast is produced. Derived from the user's own best historical
        // pace, not a population average.
        slope_kg_per_week: number | null;
        // "best_week" — sustained the user's steepest observed week-over-week
        //               weight loss
        // "best_day"  — projected from the user's biggest single-day calorie
        //               deficit, applied every day
        // "insufficient_data" — not enough history yet to be aspirational
        method: "best_week" | "best_day" | "insufficient_data";
        // Diagnostic data so the widget (or anyone reading the JSON) can
        // explain why a forecast is what it is.
        weekly_deficit_kcal: number | null;
        // Human-readable line describing how the forecast was derived,
        // for surfacing in the widget subtitle.
        rationale: string;
        targets: {
            goal_kg: number;
            reached: boolean;
            eta_days: number | null;
            eta_date: string | null; // YYYY-MM-DD
        }[];
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

// Calorie-to-mass conversion: ~7700 kcal per kg of fat.
// Source: dietary energy density of adipose tissue.
const KCAL_PER_KG_FAT = 7700;

// ---------- LLM insight ----------
//
// Short, one-line nutrition observation generated by Claude Haiku 4.5. Cached
// per user for ~15 min to keep widget refreshes from burning the API budget.

const INSIGHT_TTL_MS = 15 * 60 * 1000;
type CachedInsight = { text: string; generatedAt: number; basis: string };
const insightCache = new Map<string, CachedInsight>();

async function getCachedInsight(
    userId: string,
    displayDate: string,
    realToday: string,
    displayMeals: Meal[],
    weekMeals: Meal[],
    targets: ReturnType<typeof getDRITargets> | null,
    avgBalance: number,
): Promise<DashboardPayload["insight"]> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return {
            text: null,
            generated_at: null,
            cached: false,
            unavailable_reason:
                "ANTHROPIC_API_KEY env var not set — add it in Railway to enable insights.",
        };
    }

    // Cache key: insight stays the same until enough new data lands. We hash
    // the meal IDs of the selected day + the previous day's totals so a fresh
    // log invalidates the cache.
    const yesterdayDate = (() => {
        const d = new Date(realToday + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
    })();
    const yesterdayMeals = weekMeals.filter((m) => {
        const md = new Date(m.logged_at).toISOString().slice(0, 10);
        return md === yesterdayDate;
    });
    const basis = JSON.stringify({
        displayDate,
        mealIds: displayMeals.map((m) => m.id),
        yIds: yesterdayMeals.map((m) => m.id),
    });
    const cached = insightCache.get(userId);
    if (
        cached &&
        cached.basis === basis &&
        Date.now() - cached.generatedAt < INSIGHT_TTL_MS
    ) {
        return {
            text: cached.text,
            generated_at: new Date(cached.generatedAt).toISOString(),
            cached: true,
            unavailable_reason: null,
        };
    }

    try {
        const text = await callClaudeForInsight(
            displayDate,
            realToday,
            displayMeals,
            yesterdayMeals,
            targets,
            avgBalance,
            apiKey,
        );
        if (text) {
            insightCache.set(userId, {
                text,
                generatedAt: Date.now(),
                basis,
            });
        }
        return {
            text,
            generated_at: text ? new Date().toISOString() : null,
            cached: false,
            unavailable_reason: text ? null : "Claude returned empty",
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Fall back to the previous cached insight if the API call fails
        // (network blips, rate limit) — better than showing nothing.
        if (cached) {
            return {
                text: cached.text,
                generated_at: new Date(cached.generatedAt).toISOString(),
                cached: true,
                unavailable_reason: `live call failed: ${msg}`,
            };
        }
        return {
            text: null,
            generated_at: null,
            cached: false,
            unavailable_reason: msg,
        };
    }
}

function summarizeMealsForPrompt(meals: Meal[]): string {
    if (meals.length === 0) return "(none logged)";
    return meals
        .map((m) => {
            const macros = [
                m.calories != null ? `${m.calories} kcal` : null,
                m.protein_g != null ? `${m.protein_g}P` : null,
                m.carbs_g != null ? `${m.carbs_g}C` : null,
                m.fat_g != null ? `${m.fat_g}F` : null,
            ]
                .filter(Boolean)
                .join(" / ");
            const typ = m.meal_type ? `[${m.meal_type}] ` : "";
            return `- ${typ}${m.description}${macros ? ` (${macros})` : ""}`;
        })
        .join("\n");
}

async function callClaudeForInsight(
    displayDate: string,
    realToday: string,
    displayMeals: Meal[],
    yesterdayMeals: Meal[],
    targets: ReturnType<typeof getDRITargets> | null,
    avgBalance: number,
    apiKey: string,
): Promise<string | null> {
    const isToday = displayDate === realToday;
    const todaySummary = summarizeMealsForPrompt(displayMeals);
    const ySummary = summarizeMealsForPrompt(yesterdayMeals);

    const targetLines = targets
        ? [
              `Daily targets: ${targets.calories_kcal} kcal, ${targets.protein_g.rda}g protein RDA, ${targets.carbs_g.rda}g carbs RDA, ${targets.fat_g.min}-${targets.fat_g.max}g fat.`,
          ]
        : ["No DRI targets set yet."];

    const systemPrompt =
        "You are a concise nutrition coach reading the user's daily food log. " +
        "Output exactly ONE observation, max 16 words, plain text, no emoji, no greeting. " +
        "Pick whatever is most actionable: a specific tip, a pattern across days, or an encouragement. " +
        "Examples: 'Save ~40g protein room for dinner.' / 'Sodium spiked yesterday too — watch sauces today.' / 'On pace for a 600-kcal deficit if dinner stays moderate.'";

    const userPrompt = [
        `Today is ${realToday}. The user is viewing ${displayDate}${isToday ? " (today, in progress)" : " (past day)"}.`,
        `Average daily balance last 7 days: ${avgBalance > 0 ? "+" : ""}${avgBalance} kcal/day.`,
        ...targetLines,
        "",
        `Meals on ${displayDate}:`,
        todaySummary,
        "",
        `Meals yesterday (${(() => {
            const d = new Date(realToday + "T00:00:00Z");
            d.setUTCDate(d.getUTCDate() - 1);
            return d.toISOString().slice(0, 10);
        })()}):`,
        ySummary,
    ].join("\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 80,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
        }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
        content?: { type: string; text?: string }[];
    };
    const textBlock = json.content?.find((b) => b.type === "text");
    return textBlock?.text?.trim() ?? null;
}

// Build an **optimistic** weight-loss forecast — "if you sustained your best
// historical pace, when would you hit each target?" Two grounded variants:
//
//   1. "best_week": find the steepest week-over-week weight loss the user
//      has actually achieved (capped at -1.5 kg/wk so a single water-weight
//      week doesn't dominate). Project at that pace.
//   2. "best_day": if weight data is too sparse, find their biggest
//      single-day calorie deficit (capped at -1500 kcal/day so a sick day
//      or travel day doesn't dominate). Project at that pace every day.
//
// Both keep the forecast grounded in what the user has *demonstrated they
// can do*, not a fantasy target. The widget surfaces this with copy like
// "at your best week's pace" so the optimism is honest.
function buildOptimisticForecast(
    weeks: { week_start: string; min_weight_kg: number | null }[],
    dayBalances: { date: string; balance: number | null }[],
    latestWeightKg: number | null,
    goals: number[],
): DashboardPayload["weight_forecast"] {
    const targets = goals.map((g) => ({
        goal_kg: g,
        reached:
            latestWeightKg != null && latestWeightKg <= g ? true : false,
        eta_days: null as number | null,
        eta_date: null as string | null,
    }));

    if (latestWeightKg == null) {
        return {
            current_kg: null,
            slope_kg_per_week: null,
            method: "insufficient_data",
            weekly_deficit_kcal: null,
            rationale: "log a weight to unlock the forecast",
            targets,
        };
    }

    // --- 1. Best week-over-week loss from weighed weeks ---
    const filledWeeks = weeks
        .map((w) => w.min_weight_kg)
        .filter((v): v is number => v != null);
    let bestWeeklyLossKg: number | null = null;
    for (let i = 1; i < filledWeeks.length; i++) {
        const delta = filledWeeks[i]! - filledWeeks[i - 1]!;
        // Sanity-clamp: weeks with >1.5kg loss are usually water/glycogen
        // swings, and weeks with >0.5kg gain shouldn't drag the "best" lower.
        if (delta < -1.5 || delta > 0.5) continue;
        if (bestWeeklyLossKg == null || delta < bestWeeklyLossKg) {
            bestWeeklyLossKg = delta;
        }
    }

    // --- 2. Best single-day deficit from last 7 days ---
    let bestDailyDeficit: number | null = null;
    for (const d of dayBalances) {
        const b = d.balance;
        if (b == null) continue;
        // Sanity-clamp: -1500 kcal/day is the floor for "achievable
        // sustained." -3000 from a fasting day shouldn't dominate.
        if (b < -1500 || b > 500) continue;
        if (bestDailyDeficit == null || b < bestDailyDeficit) {
            bestDailyDeficit = b;
        }
    }

    // --- Pick the most aspirational grounded signal we have ---
    let slopePerDay: number | null = null;
    let method: "best_week" | "best_day" | "insufficient_data" =
        "insufficient_data";
    let rationale = "log more data to project an ETA";
    let slopePerWeek: number | null = null;
    let weeklyDeficitKcal: number | null = null;

    if (bestWeeklyLossKg != null && bestWeeklyLossKg < -0.05) {
        slopePerWeek = bestWeeklyLossKg;
        slopePerDay = bestWeeklyLossKg / 7;
        weeklyDeficitKcal = Math.round(bestWeeklyLossKg * KCAL_PER_KG_FAT);
        method = "best_week";
        rationale = `if you match your best week so far (${(-bestWeeklyLossKg).toFixed(2)} kg/wk)`;
    } else if (bestDailyDeficit != null && bestDailyDeficit < -100) {
        slopePerDay = bestDailyDeficit / KCAL_PER_KG_FAT;
        slopePerWeek = slopePerDay * 7;
        weeklyDeficitKcal = bestDailyDeficit * 7;
        method = "best_day";
        rationale = `if every day matches your best (${-bestDailyDeficit} kcal deficit)`;
    }

    if (slopePerDay != null && slopePerDay < 0) {
        const now = Date.now();
        for (const t of targets) {
            if (t.reached) continue;
            const kgToLose = latestWeightKg - t.goal_kg;
            const days = Math.ceil(kgToLose / -slopePerDay);
            if (!Number.isFinite(days) || days <= 0) continue;
            const etaMs = now + days * 86_400_000;
            t.eta_days = days;
            t.eta_date = new Date(etaMs).toISOString().slice(0, 10);
        }
    }

    return {
        current_kg: latestWeightKg,
        slope_kg_per_week:
            slopePerWeek != null
                ? Math.round(slopePerWeek * 100) / 100
                : null,
        method,
        weekly_deficit_kcal: weeklyDeficitKcal,
        rationale,
        targets,
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
    selectedDate?: string,
): Promise<DashboardPayload> {
    const profile = await getProfile(userId);
    const tz = profile?.timezone ?? (await getUserTimezone(userId)) ?? DEFAULT_TIMEZONE;

    const realToday = todayInZone(tz);
    // Validate selectedDate — must be a real date and within the last 7 days,
    // not future. Falls back to today silently if invalid.
    let displayDate = realToday;
    if (selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
        const d = new Date(selectedDate + "T00:00:00Z");
        if (!isNaN(d.getTime())) {
            const todayD = new Date(realToday + "T00:00:00Z");
            const diffDays = Math.round(
                (todayD.getTime() - d.getTime()) / 86_400_000,
            );
            if (diffDays >= 0 && diffDays <= 6) displayDate = selectedDate;
        }
    }

    const weekStart = (() => {
        // 6 days back inclusive so "week" = real today + 6 prior days (7 total)
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - 6);
        return dateInZone(d, tz);
    })();

    const [displayMeals, weekMeals, weekSteps, weekWeight, weightGraph] =
        await Promise.all([
            getMealsByDate(userId, displayDate, tz),
            getMealsInRange(userId, weekStart, realToday, tz),
            getStepsInRange(userId, weekStart, realToday, tz),
            getWeightInRange(userId, weekStart, realToday, tz),
            buildWeightGraph(userId, tz, 8),
        ]);

    // Today's totals (actually "selected day" totals)
    const caloriesIn = sumMacro(displayMeals, "calories");
    const proteinIn = sumMacro(displayMeals, "protein_g");
    const carbsIn = sumMacro(displayMeals, "carbs_g");
    const fatIn = sumMacro(displayMeals, "fat_g");

    const stepsTodayEntries = weekSteps.filter(
        (s) => dateInZone(new Date(s.logged_at), tz) === displayDate,
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

    // Forecast targets — uses the latest weight from the 8-week graph (which
    // covers a longer window than just the past 7 days) so the user always
    // gets a "current" reading even if they haven't weighed in this week.
    const latestForForecast = (() => {
        for (let i = weightGraph.length - 1; i >= 0; i--) {
            const w = weightGraph[i]?.min_weight_kg;
            if (w != null) return w;
        }
        return weightEnd ?? weightStart ?? null;
    })();
    // Build the per-day balance series for the forecast's "best day" path.
    // Uses the same conservative step-calorie factor as the rest of the
    // payload so the optimism is grounded in numbers the user already sees.
    const dayBalances: { date: string; balance: number | null }[] = [];
    for (const [date, bucket] of dayBuckets) {
        dayBalances.push({ date, balance: bucket.balance });
    }
    const weightForecast = buildOptimisticForecast(
        weightGraph,
        dayBalances,
        latestForForecast,
        [115, 110],
    );

    // Last meal (anywhere in the last week)
    const lastMeal = weekMeals[weekMeals.length - 1] ?? null;

    // Build week strip — 7 cells ending at real today
    const weekdayShort = ["S", "M", "T", "W", "T", "F", "S"];
    const stripCells: DashboardPayload["week_strip"] = [];
    const todayD = new Date(realToday + "T00:00:00Z");
    for (let i = 6; i >= 0; i--) {
        const d = new Date(todayD);
        d.setUTCDate(d.getUTCDate() - i);
        const isoDate = d.toISOString().slice(0, 10);
        const dayMeals = weekMeals.filter(
            (m) => dateInZone(new Date(m.logged_at), tz) === isoDate,
        );
        const dayCal = dayMeals.reduce((s, m) => s + (m.calories ?? 0), 0);
        const dayStepCalRaw = weekSteps
            .filter((s) => dateInZone(new Date(s.logged_at), tz) === isoDate)
            .reduce((s, e) => s + (e.calories_burned ?? 0), 0);
        const dayBalance =
            eer != null
                ? dayCal - (eer + dayStepCalRaw * stepFactor)
                : null;
        stripCells.push({
            date: isoDate,
            weekday_short: weekdayShort[d.getUTCDay()] ?? "?",
            calories_in: Math.round(dayCal),
            balance: dayBalance != null ? Math.round(dayBalance) : null,
            meals_count: dayMeals.length,
            is_today: isoDate === realToday,
            is_selected: isoDate === displayDate,
        });
    }

    const insight = await getCachedInsight(
        userId,
        displayDate,
        realToday,
        displayMeals,
        weekMeals,
        targets,
        avgBalance,
    );

    return {
        generated_at: new Date().toISOString(),
        timezone: tz,
        today: {
            date: displayDate,
            meals_count: displayMeals.length,
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
        week_strip: stripCells,
        selected_date: displayDate,
        insight,
        weight_graph: { weeks: weightGraph },
        weight_forecast: weightForecast,
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
        const dateParam = c.req.query("date") ?? undefined;
        const payload = await buildDashboardPayload(userId, dateParam);
        c.header("Cache-Control", "no-store");
        return c.json(payload);
    });

    // Push HealthKit data (steps + weight) from the user's iOS Shortcut.
    // Idempotent — replaces today's entry on each call rather than appending.
    dashboard.post("/health-sync", authenticateBearer, async (c) => {
        const userId = c.get("userId");
        let raw: Record<string, unknown>;
        try {
            raw = (await c.req.json()) as Record<string, unknown>;
        } catch {
            return c.json({ error: "invalid_json" }, 400);
        }

        // Normalize keys to lowercase so the Shortcut can send "Steps",
        // "STEPS", "steps", "Weight_Kg", etc. without breaking.
        const body: { steps?: unknown; weight_kg?: unknown } = {};
        for (const [k, v] of Object.entries(raw ?? {})) {
            const lk = k.toLowerCase();
            if (lk === "steps") body.steps = v;
            else if (lk === "weight_kg" || lk === "weight" || lk === "weightkg")
                body.weight_kg = v;
        }

        const profile = await getProfile(userId);
        const tz =
            profile?.timezone ??
            (await getUserTimezone(userId)) ??
            DEFAULT_TIMEZONE;

        const wrote: Record<string, unknown> = {};

        // Steps — calorie-burn estimate uses profile weight when available
        if (body.steps != null && body.steps !== "") {
            const steps = Number(body.steps);
            if (!Number.isFinite(steps) || steps < 0) {
                return c.json(
                    { error: "invalid_steps", received: body.steps },
                    400,
                );
            }
            const weightKg = profile?.weight_kg ?? 70;
            const calories = Math.round(steps * 0.0005 * weightKg);
            const entry = await upsertTodaysSteps(
                userId,
                Math.round(steps),
                calories,
                tz,
            );
            wrote.steps = {
                step_count: entry.step_count,
                calories_burned: entry.calories_burned,
                logged_at: entry.logged_at,
            };
        }

        if (body.weight_kg != null && body.weight_kg !== "") {
            const w = Number(body.weight_kg);
            if (!Number.isFinite(w) || w <= 0 || w > 500) {
                return c.json(
                    { error: "invalid_weight_kg", received: body.weight_kg },
                    400,
                );
            }
            const entry = await upsertTodaysWeight(userId, w, tz);
            wrote.weight = {
                weight_kg: entry.weight_kg,
                logged_at: entry.logged_at,
            };
        }

        // If neither field was present, fail loudly so the Shortcut author
        // immediately sees the issue instead of getting a misleading ok.
        if (Object.keys(wrote).length === 0) {
            return c.json(
                {
                    error: "no_fields",
                    error_description:
                        "Request body needs at least one of: steps, weight_kg. Check the Shortcut's Request Body fields.",
                    received_body: body,
                },
                400,
            );
        }

        return c.json({ ok: true, wrote });
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

    // Browser-rendered mockup of the Scriptable widget so we can audit design
    // changes without rebuilding to a phone. Public — no auth required for
    // the sample payload, but accepts ?token=… to fetch real data.
    dashboard.get("/preview", async (c) => {
        const file = Bun.file("./widgets/preview.html");
        if (!(await file.exists())) {
            return c.text("Preview not bundled.", 404);
        }
        return c.html(await file.text());
    });

    return dashboard;
}
