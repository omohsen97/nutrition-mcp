import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
    DEFAULT_TIMEZONE,
    startOfLocalDayUtc,
    endOfLocalDayUtc,
    dateInZone,
} from "./timezone.js";

let supabase: SupabaseClient;

export function getSupabase(): SupabaseClient {
    if (!supabase) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SECRET_KEY;
        if (!url || !key) {
            throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
        }
        supabase = createClient(url, key);
    }
    return supabase;
}

// ---------- Auth ----------

export async function signUpUser(
    email: string,
    password: string,
): Promise<string> {
    const { data, error } = await getSupabase().auth.signUp({
        email,
        password,
    });

    if (error) throw new Error(error.message);
    if (!data.user) throw new Error("Sign-up failed");
    return data.user.id;
}

export async function signInUser(
    email: string,
    password: string,
): Promise<string> {
    const { data, error } = await getSupabase().auth.signInWithPassword({
        email,
        password,
    });

    if (error) throw new Error(error.message);
    return data.user.id;
}

// ---------- Meals ----------

export interface Meal {
    id: string;
    user_id: string;
    logged_at: string;
    meal_type: string | null;
    description: string;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    notes: string | null;
}

export interface MealInput {
    description: string;
    meal_type: "breakfast" | "lunch" | "dinner" | "snack";
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    logged_at?: string;
    notes?: string;
}

export async function insertMeal(
    userId: string,
    input: MealInput,
): Promise<Meal> {
    const { data, error } = await getSupabase()
        .from("meals")
        .insert({
            user_id: userId,
            description: input.description,
            meal_type: input.meal_type,
            calories: input.calories ?? null,
            protein_g: input.protein_g ?? null,
            carbs_g: input.carbs_g ?? null,
            fat_g: input.fat_g ?? null,
            logged_at: input.logged_at ?? new Date().toISOString(),
            notes: input.notes ?? null,
        })
        .select()
        .single();

    if (error) throw new Error(`Failed to insert meal: ${error.message}`);
    return data as Meal;
}

export async function getMealsByDate(
    userId: string,
    date: string,
    tz: string,
): Promise<Meal[]> {
    const { data, error } = await getSupabase()
        .from("meals")
        .select("*")
        .eq("user_id", userId)
        .gte("logged_at", startOfLocalDayUtc(date, tz))
        .lte("logged_at", endOfLocalDayUtc(date, tz))
        .order("logged_at", { ascending: true });

    if (error) throw new Error(`Failed to get meals: ${error.message}`);
    return (data as Meal[]) ?? [];
}

export async function getMealsInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string,
): Promise<Meal[]> {
    const { data, error } = await getSupabase()
        .from("meals")
        .select("*")
        .eq("user_id", userId)
        .gte("logged_at", startOfLocalDayUtc(startDate, tz))
        .lte("logged_at", endOfLocalDayUtc(endDate, tz))
        .order("logged_at", { ascending: true });

    if (error) throw new Error(`Failed to get meals: ${error.message}`);
    return (data as Meal[]) ?? [];
}

export async function deleteMeal(userId: string, id: string): Promise<void> {
    const { error } = await getSupabase()
        .from("meals")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);

    if (error) throw new Error(`Failed to delete meal: ${error.message}`);
}

export async function updateMeal(
    userId: string,
    id: string,
    fields: Partial<MealInput>,
): Promise<Meal> {
    const update: Record<string, unknown> = {};
    if (fields.description !== undefined)
        update.description = fields.description;
    if (fields.meal_type !== undefined) update.meal_type = fields.meal_type;
    if (fields.calories !== undefined) update.calories = fields.calories;
    if (fields.protein_g !== undefined) update.protein_g = fields.protein_g;
    if (fields.carbs_g !== undefined) update.carbs_g = fields.carbs_g;
    if (fields.fat_g !== undefined) update.fat_g = fields.fat_g;
    if (fields.logged_at !== undefined) update.logged_at = fields.logged_at;
    if (fields.notes !== undefined) update.notes = fields.notes;

    const { data, error } = await getSupabase()
        .from("meals")
        .update(update)
        .eq("id", id)
        .eq("user_id", userId)
        .select()
        .single();

    if (error) throw new Error(`Failed to update meal: ${error.message}`);
    return data as Meal;
}

// ---------- User Profiles ----------

export interface UserProfile {
    id: string;
    user_id: string;
    age: number;
    sex: string;
    height_cm: number;
    weight_kg: number;
    activity_level: string;
    timezone: string;
    updated_at: string;
}

export interface ProfileInput {
    age: number;
    sex: "male" | "female";
    height_cm: number;
    weight_kg: number;
    activity_level: "inactive" | "low_active" | "active" | "very_active";
    timezone?: string;
}

export async function upsertProfile(
    userId: string,
    input: ProfileInput,
): Promise<UserProfile> {
    const payload: Record<string, unknown> = {
        user_id: userId,
        age: input.age,
        sex: input.sex,
        height_cm: input.height_cm,
        weight_kg: input.weight_kg,
        activity_level: input.activity_level,
        updated_at: new Date().toISOString(),
    };
    // Only set timezone when explicitly provided so callers updating other
    // fields don't clobber the user's existing zone preference.
    if (input.timezone !== undefined) payload.timezone = input.timezone;

    const { data, error } = await getSupabase()
        .from("user_profiles")
        .upsert(payload, { onConflict: "user_id" })
        .select()
        .single();

    if (error) throw new Error(`Failed to upsert profile: ${error.message}`);
    return data as UserProfile;
}

export async function getUserTimezone(userId: string): Promise<string> {
    const { data, error } = await getSupabase()
        .from("user_profiles")
        .select("timezone")
        .eq("user_id", userId)
        .single();

    if (error || !data) return DEFAULT_TIMEZONE;
    return (data.timezone as string | null) ?? DEFAULT_TIMEZONE;
}

// Requires an existing profile (user_profiles has NOT NULL columns for
// age/sex/etc). set_profile must be called first.
export async function setUserTimezone(
    userId: string,
    timezone: string,
): Promise<string> {
    const { data, error } = await getSupabase()
        .from("user_profiles")
        .update({
            timezone,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .select("timezone")
        .single();

    if (error) {
        if (error.code === "PGRST116") {
            throw new Error(
                "No profile found. Use set_profile first, then set_timezone.",
            );
        }
        throw new Error(`Failed to set timezone: ${error.message}`);
    }
    return data!.timezone as string;
}

export async function getProfile(userId: string): Promise<UserProfile | null> {
    const { data, error } = await getSupabase()
        .from("user_profiles")
        .select("*")
        .eq("user_id", userId)
        .single();

    if (error && error.code !== "PGRST116") {
        throw new Error(`Failed to get profile: ${error.message}`);
    }
    return (data as UserProfile) ?? null;
}

// ---------- Weight Entries ----------

export interface WeightEntry {
    id: string;
    user_id: string;
    weight_kg: number;
    logged_at: string;
}

export async function insertWeight(
    userId: string,
    weightKg: number,
    loggedAt?: string,
): Promise<WeightEntry> {
    const { data, error } = await getSupabase()
        .from("weight_entries")
        .insert({
            user_id: userId,
            weight_kg: weightKg,
            logged_at: loggedAt ?? new Date().toISOString(),
        })
        .select()
        .single();

    if (error) throw new Error(`Failed to insert weight: ${error.message}`);
    return data as WeightEntry;
}

export async function getWeightInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string,
): Promise<WeightEntry[]> {
    const { data, error } = await getSupabase()
        .from("weight_entries")
        .select("*")
        .eq("user_id", userId)
        .gte("logged_at", startOfLocalDayUtc(startDate, tz))
        .lte("logged_at", endOfLocalDayUtc(endDate, tz))
        .order("logged_at", { ascending: true });

    if (error) throw new Error(`Failed to get weight entries: ${error.message}`);
    return (data as WeightEntry[]) ?? [];
}

export async function deleteWeight(userId: string, id: string): Promise<void> {
    const { error } = await getSupabase()
        .from("weight_entries")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);

    if (error) throw new Error(`Failed to delete weight entry: ${error.message}`);
}

// ---------- Step Entries ----------

export interface StepEntry {
    id: string;
    user_id: string;
    step_count: number;
    calories_burned: number | null;
    logged_at: string;
}

export async function insertSteps(
    userId: string,
    stepCount: number,
    caloriesBurned: number | null,
    loggedAt?: string,
): Promise<StepEntry> {
    const { data, error } = await getSupabase()
        .from("step_entries")
        .insert({
            user_id: userId,
            step_count: stepCount,
            calories_burned: caloriesBurned,
            logged_at: loggedAt ?? new Date().toISOString(),
        })
        .select()
        .single();

    if (error) throw new Error(`Failed to insert steps: ${error.message}`);
    return data as StepEntry;
}

export async function getStepsInRange(
    userId: string,
    startDate: string,
    endDate: string,
    tz: string,
): Promise<StepEntry[]> {
    const { data, error } = await getSupabase()
        .from("step_entries")
        .select("*")
        .eq("user_id", userId)
        .gte("logged_at", startOfLocalDayUtc(startDate, tz))
        .lte("logged_at", endOfLocalDayUtc(endDate, tz))
        .order("logged_at", { ascending: true });

    if (error) throw new Error(`Failed to get step entries: ${error.message}`);
    return (data as StepEntry[]) ?? [];
}

export async function deleteSteps(userId: string, id: string): Promise<void> {
    const { error } = await getSupabase()
        .from("step_entries")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);

    if (error) throw new Error(`Failed to delete step entry: ${error.message}`);
}

// Group step entries by the user's local day and keep only the LATEST entry
// per day. iOS Shortcut posts cumulative day-to-date step totals (so 5564 at
// 1pm supersedes 5050 at noon), and any historical day might have multiple
// entries from before upsertTodaysSteps existed or from manual `log_steps`
// calls. Summing them double-counts. The latest entry per day is the source
// of truth; multi-day totals should sum across these per-day winners.
// Assumes entries are sorted ascending by `logged_at` (which is how
// `getStepsInRange` returns them).
export function latestStepsByDay(
    entries: StepEntry[],
    tz: string,
): Map<string, StepEntry> {
    const byDay = new Map<string, StepEntry>();
    for (const e of entries) {
        const d = dateInZone(new Date(e.logged_at), tz);
        const existing = byDay.get(d);
        if (!existing || e.logged_at > existing.logged_at) {
            byDay.set(d, e);
        }
    }
    return byDay;
}

// Updates today's step entry if one exists in the user's local day, otherwise
// inserts a new one. Used by the iOS Shortcut sync flow which posts running
// totals every hour — we want LATEST-wins semantics, not summation.
export async function upsertTodaysSteps(
    userId: string,
    stepCount: number,
    caloriesBurned: number | null,
    tz: string,
): Promise<StepEntry> {
    const sb = getSupabase();
    const today = new Date().toISOString().slice(0, 10);
    // Find any entry whose logged_at falls inside the user's "today" window.
    const { data: existing, error: findErr } = await sb
        .from("step_entries")
        .select("*")
        .eq("user_id", userId)
        .gte("logged_at", startOfLocalDayUtc(today, tz))
        .lte("logged_at", endOfLocalDayUtc(today, tz))
        .order("logged_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (findErr)
        throw new Error(`Failed to find today's steps: ${findErr.message}`);

    if (existing) {
        const { data, error } = await sb
            .from("step_entries")
            .update({
                step_count: stepCount,
                calories_burned: caloriesBurned,
                logged_at: new Date().toISOString(),
            })
            .eq("id", (existing as StepEntry).id)
            .select()
            .single();
        if (error)
            throw new Error(`Failed to update steps: ${error.message}`);
        return data as StepEntry;
    }
    return insertSteps(userId, stepCount, caloriesBurned);
}

// Similar pattern for weight — keeps a single entry per local day even if the
// Shortcut posts hourly.
export async function upsertTodaysWeight(
    userId: string,
    weightKg: number,
    tz: string,
): Promise<WeightEntry> {
    const sb = getSupabase();
    const today = new Date().toISOString().slice(0, 10);
    const { data: existing, error: findErr } = await sb
        .from("weight_entries")
        .select("*")
        .eq("user_id", userId)
        .gte("logged_at", startOfLocalDayUtc(today, tz))
        .lte("logged_at", endOfLocalDayUtc(today, tz))
        .order("logged_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (findErr)
        throw new Error(`Failed to find today's weight: ${findErr.message}`);

    if (existing) {
        const { data, error } = await sb
            .from("weight_entries")
            .update({
                weight_kg: weightKg,
                logged_at: new Date().toISOString(),
            })
            .eq("id", (existing as WeightEntry).id)
            .select()
            .single();
        if (error)
            throw new Error(`Failed to update weight: ${error.message}`);
        return data as WeightEntry;
    }
    return insertWeight(userId, weightKg);
}

// ---------- Delete all user data ----------

export async function deleteAllUserData(userId: string): Promise<void> {
    const sb = getSupabase();

    const { error: analyticsErr } = await sb
        .from("tool_analytics")
        .delete()
        .eq("user_id", userId);
    if (analyticsErr)
        throw new Error(`Failed to delete analytics: ${analyticsErr.message}`);

    const { error: profileErr } = await sb
        .from("user_profiles")
        .delete()
        .eq("user_id", userId);
    if (profileErr)
        throw new Error(`Failed to delete profile: ${profileErr.message}`);

    const { error: weightErr } = await sb
        .from("weight_entries")
        .delete()
        .eq("user_id", userId);
    if (weightErr)
        throw new Error(`Failed to delete weight entries: ${weightErr.message}`);

    const { error: stepsErr } = await sb
        .from("step_entries")
        .delete()
        .eq("user_id", userId);
    if (stepsErr)
        throw new Error(`Failed to delete step entries: ${stepsErr.message}`);

    const { error: mealsErr } = await sb
        .from("meals")
        .delete()
        .eq("user_id", userId);
    if (mealsErr)
        throw new Error(`Failed to delete meals: ${mealsErr.message}`);

    // Favorites + recipes (recipe_ingredients cascades on recipe delete).
    const { error: recipesErr } = await sb
        .from("recipes")
        .delete()
        .eq("user_id", userId);
    if (recipesErr)
        throw new Error(`Failed to delete recipes: ${recipesErr.message}`);

    const { error: favsErr } = await sb
        .from("meal_favorites")
        .delete()
        .eq("user_id", userId);
    if (favsErr)
        throw new Error(`Failed to delete favorites: ${favsErr.message}`);

    // Google Health data
    const { error: ghDpErr } = await sb
        .from("google_health_data_points")
        .delete()
        .eq("user_id", userId);
    if (ghDpErr)
        throw new Error(
            `Failed to delete Google Health data points: ${ghDpErr.message}`,
        );

    const { error: ghSsErr } = await sb
        .from("google_health_sync_state")
        .delete()
        .eq("user_id", userId);
    if (ghSsErr)
        throw new Error(
            `Failed to delete Google Health sync state: ${ghSsErr.message}`,
        );

    const { error: ghStErr } = await sb
        .from("google_health_oauth_states")
        .delete()
        .eq("user_id", userId);
    if (ghStErr)
        throw new Error(
            `Failed to delete Google Health OAuth states: ${ghStErr.message}`,
        );

    const { error: ghTokErr } = await sb
        .from("google_health_tokens")
        .delete()
        .eq("user_id", userId);
    if (ghTokErr)
        throw new Error(
            `Failed to delete Google Health tokens: ${ghTokErr.message}`,
        );

    const { error: tokensErr } = await sb
        .from("oauth_tokens")
        .delete()
        .eq("user_id", userId);
    if (tokensErr)
        throw new Error(`Failed to delete tokens: ${tokensErr.message}`);

    const { error: refreshErr } = await sb
        .from("refresh_tokens")
        .delete()
        .eq("user_id", userId);
    if (refreshErr)
        throw new Error(
            `Failed to delete refresh tokens: ${refreshErr.message}`,
        );

    const { error: authErr } = await sb
        .from("auth_codes")
        .delete()
        .eq("user_id", userId);
    if (authErr)
        throw new Error(`Failed to delete auth codes: ${authErr.message}`);

    const { error: userErr } = await sb.auth.admin.deleteUser(userId);
    if (userErr) throw new Error(`Failed to delete user: ${userErr.message}`);
}

// ---------- OAuth tokens ----------

export async function storeToken(token: string, userId: string): Promise<void> {
    const expiresAt = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { error } = await getSupabase().from("oauth_tokens").upsert(
        {
            token,
            user_id: userId,
            expires_at: expiresAt,
        },
        { onConflict: "token" },
    );

    if (error) throw new Error(`Failed to store token: ${error.message}`);
}

export async function getUserIdByToken(token: string): Promise<string | null> {
    const { data, error } = await getSupabase()
        .from("oauth_tokens")
        .select("user_id")
        .eq("token", token)
        .gt("expires_at", new Date().toISOString())
        .single();

    if (error || !data) return null;
    return data.user_id as string;
}

// ---------- Auth codes ----------

export async function storeAuthCode(
    code: string,
    redirectUri: string,
    userId: string,
    codeChallenge?: string,
): Promise<void> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error } = await getSupabase()
        .from("auth_codes")
        .insert({
            code,
            redirect_uri: redirectUri,
            user_id: userId,
            code_challenge: codeChallenge ?? null,
            expires_at: expiresAt,
        });

    if (error) throw new Error(`Failed to store auth code: ${error.message}`);
}

export interface AuthCodeData {
    code: string;
    redirect_uri: string;
    user_id: string;
    code_challenge: string | null;
}

export async function consumeAuthCode(
    code: string,
): Promise<AuthCodeData | null> {
    const now = new Date().toISOString();

    const { data, error } = await getSupabase()
        .from("auth_codes")
        .delete()
        .eq("code", code)
        .gt("expires_at", now)
        .select()
        .single();

    if (error || !data) return null;
    return data as AuthCodeData;
}

// ---------- Refresh tokens ----------

export async function storeRefreshToken(
    token: string,
    userId: string,
): Promise<void> {
    const expiresAt = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { error } = await getSupabase().from("refresh_tokens").insert({
        token,
        user_id: userId,
        expires_at: expiresAt,
    });

    if (error)
        throw new Error(`Failed to store refresh token: ${error.message}`);
}

export async function consumeRefreshToken(
    token: string,
): Promise<string | null> {
    const { data, error } = await getSupabase()
        .from("refresh_tokens")
        .delete()
        .eq("token", token)
        .gt("expires_at", new Date().toISOString())
        .select("user_id")
        .single();

    if (error || !data) return null;
    return data.user_id as string;
}

// ---------- Registered clients ----------

export function registerClient(
    clientName: string | null,
    redirectUris: string[],
): void {
    getSupabase()
        .from("registered_clients")
        .insert({
            client_name: clientName,
            redirect_uris: redirectUris,
        })
        .then(({ error }) => {
            if (error) {
                console.warn(
                    "Failed to persist client registration:",
                    error.message,
                );
            }
        });
}
