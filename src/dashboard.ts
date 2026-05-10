import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import crypto from "node:crypto";
import {
    signInUser,
    signUpUser,
    storeToken,
    getUserIdByToken,
    getProfile,
    getMealsInRange,
    getWeightInRange,
    getStepsInRange,
    type Meal,
    type WeightEntry,
    type StepEntry,
    type UserProfile,
} from "./supabase.js";
import { getDRITargets, type ActivityLevel, type Sex } from "./health.js";

const COOKIE_NAME = "nmcp_dash";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function ymd(d: Date): string {
    return d.toISOString().slice(0, 10);
}

async function authedUserId(c: {
    req: { header: (n: string) => string | undefined; raw: Request };
}): Promise<string | null> {
    // hono cookie helpers want the Context, but we just need the raw cookie
    const cookieHeader = c.req.header("cookie");
    if (!cookieHeader) return null;
    const match = cookieHeader.match(
        new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`),
    );
    if (!match) return null;
    return await getUserIdByToken(decodeURIComponent(match[1] as string));
}

function isHttps(c: {
    req: { header: (n: string) => string | undefined; url: string };
}): boolean {
    if (c.req.header("x-forwarded-proto") === "https") return true;
    try {
        return new URL(c.req.url).protocol === "https:";
    } catch {
        return false;
    }
}

interface DayTotal {
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
}

interface DayStep {
    step_count: number;
    calories_burned: number;
}

function buildDailyMacros(
    meals: Meal[],
    days: string[],
): Record<string, DayTotal> {
    const totals: Record<string, DayTotal> = {};
    for (const d of days) {
        totals[d] = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    }
    for (const m of meals) {
        const k = m.logged_at.slice(0, 10);
        const t = totals[k];
        if (!t) continue;
        t.calories += m.calories ?? 0;
        t.protein_g += m.protein_g ?? 0;
        t.carbs_g += m.carbs_g ?? 0;
        t.fat_g += m.fat_g ?? 0;
    }
    return totals;
}

function buildDailySteps(steps: StepEntry[]): Record<string, DayStep> {
    const out: Record<string, DayStep> = {};
    for (const s of steps) {
        const k = s.logged_at.slice(0, 10);
        if (!out[k]) out[k] = { step_count: 0, calories_burned: 0 };
        out[k].step_count += s.step_count;
        out[k].calories_burned += s.calories_burned ?? 0;
    }
    return out;
}

function lastNDays(today: Date, n: number): string[] {
    const out: string[] = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        out.push(ymd(d));
    }
    return out;
}

function profileToDRIInput(p: UserProfile) {
    return {
        age: p.age,
        sex: p.sex as Sex,
        height_cm: p.height_cm,
        weight_kg: p.weight_kg,
        activity_level: p.activity_level as ActivityLevel,
    };
}

export function createDashboardRouter() {
    const r = new Hono();

    // Login page
    r.get("/dashboard/login", async (c) => {
        const userId = await authedUserId(c);
        if (userId) return c.redirect("/dashboard");
        const tpl = await Bun.file("./public/dashboard-login.html").text();
        return c.html(tpl.replace("{{ERROR}}", ""));
    });

    // Login submission — sign in or sign up, set HTTP-only cookie
    r.post("/dashboard/login", async (c) => {
        const body = await c.req.parseBody();
        const email = (body.email as string)?.trim().toLowerCase();
        const password = body.password as string;

        if (!email || !password) {
            const tpl = await Bun.file("./public/dashboard-login.html").text();
            return c.html(
                tpl.replace(
                    "{{ERROR}}",
                    `<div class="error-banner">Email and password are required</div>`,
                ),
                400,
            );
        }

        let userId: string;
        try {
            try {
                userId = await signInUser(email, password);
            } catch {
                userId = await signUpUser(email, password);
            }
        } catch (err: unknown) {
            const message =
                err instanceof Error ? err.message : "Authentication failed";
            const tpl = await Bun.file("./public/dashboard-login.html").text();
            return c.html(
                tpl.replace(
                    "{{ERROR}}",
                    `<div class="error-banner">${escapeHtml(message)}</div>`,
                ),
                401,
            );
        }

        const token = crypto.randomUUID();
        await storeToken(token, userId);

        setCookie(c, COOKIE_NAME, token, {
            httpOnly: true,
            secure: isHttps(c),
            sameSite: "Lax",
            path: "/",
            maxAge: COOKIE_MAX_AGE,
        });

        return c.redirect("/dashboard");
    });

    // Logout
    r.post("/dashboard/logout", async (c) => {
        deleteCookie(c, COOKIE_NAME, { path: "/" });
        return c.redirect("/dashboard/login");
    });

    // Dashboard page
    r.get("/dashboard", async (c) => {
        const userId = await authedUserId(c);
        if (!userId) return c.redirect("/dashboard/login");
        return c.html(await Bun.file("./public/dashboard.html").text());
    });

    // Dashboard data API
    r.get("/api/dashboard/data", async (c) => {
        const userId = await authedUserId(c);
        if (!userId) return c.json({ error: "unauthorized" }, 401);

        const today = new Date();
        const todayStr = ymd(today);
        const week = lastNDays(today, 7);
        const month = lastNDays(today, 30);
        const monthStartStr = month[0]!;
        const weekStartStr = week[0]!;

        const [profile, weekMeals, weights, steps]: [
            UserProfile | null,
            Meal[],
            WeightEntry[],
            StepEntry[],
        ] = await Promise.all([
            getProfile(userId),
            getMealsInRange(userId, weekStartStr, todayStr),
            getWeightInRange(userId, monthStartStr, todayStr),
            getStepsInRange(userId, monthStartStr, todayStr),
        ]);

        const dayTotals = buildDailyMacros(weekMeals, week);
        const stepsByDay = buildDailySteps(steps);

        const todayMeals = weekMeals.filter((m) =>
            m.logged_at.startsWith(todayStr),
        );
        const todayTotals = dayTotals[todayStr]!;

        const targets = profile
            ? getDRITargets(profileToDRIInput(profile))
            : null;

        return c.json({
            today: todayStr,
            profile,
            targets,
            today_totals: todayTotals,
            today_meals: todayMeals,
            weekly: week.map((date) => ({ date, ...dayTotals[date]! })),
            weight_history: weights.map((w) => ({
                date: w.logged_at.slice(0, 10),
                weight_kg: w.weight_kg,
            })),
            steps_by_day: month.map((date) => ({
                date,
                ...(stepsByDay[date] ?? { step_count: 0, calories_burned: 0 }),
            })),
            today_steps: stepsByDay[todayStr] ?? null,
        });
    });

    return r;
}
