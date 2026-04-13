import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Context } from "hono";
import {
    insertMeal,
    getMealsByDate,
    getMealsInRange,
    deleteMeal,
    updateMeal,
    deleteAllUserData,
    upsertProfile,
    getProfile,
    insertWeight,
    getWeightInRange,
    insertSteps,
    getStepsInRange,
    type Meal,
    type WeightEntry,
    type StepEntry,
    type UserProfile,
} from "./supabase.js";
import { withAnalytics } from "./analytics.js";
import {
    calculateEER,
    calculateStepCalories,
    getDRITargets,
    lookupNutrient,
    type ProfileData,
} from "./health.js";

const SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

const sessions = new Map<
    string,
    {
        transport: WebStandardStreamableHTTPServerTransport;
        mcpToken: string;
        lastActivity: number;
    }
>();

setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastActivity > SESSION_TTL_MS) {
            sessions.delete(id);
        }
    }
}, CLEANUP_INTERVAL_MS);

function todayDate(): string {
    return new Date().toISOString().slice(0, 10);
}

function formatMeal(meal: Meal): string {
    const parts = [
        `ID: ${meal.id}`,
        `Time: ${meal.logged_at}`,
        meal.meal_type ? `Type: ${meal.meal_type}` : null,
        `Description: ${meal.description}`,
        meal.calories != null ? `Calories: ${meal.calories}` : null,
        meal.protein_g != null ? `Protein: ${meal.protein_g}g` : null,
        meal.carbs_g != null ? `Carbs: ${meal.carbs_g}g` : null,
        meal.fat_g != null ? `Fat: ${meal.fat_g}g` : null,
        meal.notes ? `Notes: ${meal.notes}` : null,
    ];
    return parts.filter(Boolean).join("\n");
}

function registerTools(server: McpServer, userId: string) {
    server.registerTool(
        "log_meal",
        {
            title: "Log Meal",
            description:
                "Log a meal entry with nutritional information. If the user doesn't specify the quantity or portion size, ask how much they ate before estimating calories and macros. Use web search to look up accurate nutritional data when appropriate, especially for branded products or barcode scans.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                description: z.string().describe("What was eaten"),
                meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .describe(
                        "Type of meal (breakfast, lunch, dinner, or snack). Always ask the user if not provided.",
                    ),
                calories: z.coerce.number().optional().describe("Total calories"),
                protein_g: z.coerce.number().optional().describe("Protein in grams"),
                carbs_g: z
                    .coerce.number()
                    .optional()
                    .describe("Carbohydrates in grams"),
                fat_g: z.coerce.number().optional().describe("Fat in grams"),
                logged_at: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 timestamp (defaults to now). If you don't know the current date or time, ask the user before calling this tool.",
                    ),
                notes: z.string().optional().describe("Additional notes"),
            },
        },
        async (args) => {
            return withAnalytics(
                "log_meal",
                async () => {
                    const meal = await insertMeal(userId, args);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Meal logged:\n${formatMeal(meal)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_meals_today",
        {
            title: "Get Today's Meals",
            description: "Get all meals logged today",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "get_meals_today",
                async () => {
                    const meals = await getMealsByDate(userId, todayDate());
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No meals logged today.",
                                },
                            ],
                        };
                    }
                    const text = meals.map(formatMeal).join("\n\n---\n\n");
                    return { content: [{ type: "text", text }] };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_meals_by_date",
        {
            title: "Get Meals by Date",
            description: "Get all meals for a specific date",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                date: z.string().describe("Date in YYYY-MM-DD format"),
            },
        },
        async ({ date }) => {
            return withAnalytics(
                "get_meals_by_date",
                async () => {
                    const meals = await getMealsByDate(userId, date);
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No meals logged on ${date}.`,
                                },
                            ],
                        };
                    }
                    const text = meals.map(formatMeal).join("\n\n---\n\n");
                    return { content: [{ type: "text", text }] };
                },
                { userId },
                { date },
            );
        },
    );

    server.registerTool(
        "get_meals_by_date_range",
        {
            title: "Get Meals by Date Range",
            description:
                "Get all meals between two dates (inclusive). Use this instead of multiple get_meals_by_date calls when you need meals for more than one day.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                start_date: z.string().describe("Start date (YYYY-MM-DD)"),
                end_date: z.string().describe("End date (YYYY-MM-DD)"),
            },
        },
        async ({ start_date, end_date }) => {
            return withAnalytics(
                "get_meals_by_date_range",
                async () => {
                    const meals = await getMealsInRange(
                        userId,
                        start_date,
                        end_date,
                    );
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No meals found between ${start_date} and ${end_date}.`,
                                },
                            ],
                        };
                    }

                    // Group by date for readability
                    const byDate = new Map<string, Meal[]>();
                    for (const meal of meals) {
                        const date = meal.logged_at.slice(0, 10);
                        const existing = byDate.get(date) ?? [];
                        existing.push(meal);
                        byDate.set(date, existing);
                    }

                    const sections: string[] = [];
                    for (const [date, dateMeals] of [
                        ...byDate.entries(),
                    ].sort()) {
                        const header = `## ${date} (${dateMeals.length} meal${dateMeals.length === 1 ? "" : "s"})`;
                        const formatted = dateMeals
                            .map(formatMeal)
                            .join("\n\n---\n\n");
                        sections.push(`${header}\n\n${formatted}`);
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: sections.join("\n\n===\n\n"),
                            },
                        ],
                    };
                },
                { userId },
                { start_date, end_date },
            );
        },
    );

    server.registerTool(
        "get_nutrition_summary",
        {
            title: "Get Nutrition Summary",
            description: "Get daily nutrition totals for a date range",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                start_date: z.string().describe("Start date (YYYY-MM-DD)"),
                end_date: z.string().describe("End date (YYYY-MM-DD)"),
            },
        },
        async ({ start_date, end_date }) => {
            return withAnalytics(
                "get_nutrition_summary",
                async () => {
                    const meals = await getMealsInRange(
                        userId,
                        start_date,
                        end_date,
                    );
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No meals found between ${start_date} and ${end_date}.`,
                                },
                            ],
                        };
                    }

                    // Group by date
                    const byDate = new Map<string, Meal[]>();
                    for (const meal of meals) {
                        const date = meal.logged_at.slice(0, 10);
                        const existing = byDate.get(date) ?? [];
                        existing.push(meal);
                        byDate.set(date, existing);
                    }

                    const summaries: string[] = [];
                    for (const [date, dateMeals] of [
                        ...byDate.entries(),
                    ].sort()) {
                        const totals = {
                            calories: 0,
                            protein_g: 0,
                            carbs_g: 0,
                            fat_g: 0,
                            count: dateMeals.length,
                        };
                        for (const m of dateMeals) {
                            totals.calories += m.calories ?? 0;
                            totals.protein_g += m.protein_g ?? 0;
                            totals.carbs_g += m.carbs_g ?? 0;
                            totals.fat_g += m.fat_g ?? 0;
                        }
                        summaries.push(
                            `${date} (${totals.count} meals): ${totals.calories} kcal | P: ${totals.protein_g}g | C: ${totals.carbs_g}g | F: ${totals.fat_g}g`,
                        );
                    }

                    return {
                        content: [{ type: "text", text: summaries.join("\n") }],
                    };
                },
                { userId },
                { start_date, end_date },
            );
        },
    );

    server.registerTool(
        "delete_meal",
        {
            title: "Delete Meal",
            description: "Delete a meal entry by ID",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the meal to delete"),
            },
        },
        async ({ id }) => {
            return withAnalytics(
                "delete_meal",
                async () => {
                    await deleteMeal(userId, id);
                    return {
                        content: [
                            { type: "text", text: `Meal ${id} deleted.` },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "update_meal",
        {
            title: "Update Meal",
            description: "Update fields of an existing meal entry",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the meal to update"),
                description: z.string().optional(),
                meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .optional(),
                calories: z.coerce.number().optional(),
                protein_g: z.coerce.number().optional(),
                carbs_g: z.coerce.number().optional(),
                fat_g: z.coerce.number().optional(),
                logged_at: z.string().optional(),
                notes: z.string().optional(),
            },
        },
        async ({ id, ...fields }) => {
            return withAnalytics(
                "update_meal",
                async () => {
                    const meal = await updateMeal(userId, id, fields);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Meal updated:\n${formatMeal(meal)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );
    // ---------- Profile Tools ----------

    server.registerTool(
        "set_profile",
        {
            title: "Set User Profile",
            description:
                "Set or update your profile (age, sex, height, weight, activity level). This is used to calculate your daily calorie needs (EER), DRI targets, and step calorie burn estimates.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                age: z.coerce.number().int().min(19).max(120).describe("Age in years (19+)"),
                sex: z.enum(["male", "female"]).describe("Biological sex"),
                height_cm: z.coerce.number().positive().describe("Height in centimeters"),
                weight_kg: z.coerce.number().positive().describe("Weight in kilograms"),
                activity_level: z
                    .enum(["inactive", "low_active", "active", "very_active"])
                    .describe(
                        "Physical activity level: inactive (sedentary), low_active (30-60 min/day moderate), active (60+ min/day), very_active (60+ min/day intense)",
                    ),
            },
        },
        async (args) => {
            return withAnalytics(
                "set_profile",
                async () => {
                    const profile = await upsertProfile(userId, args);
                    const eer = calculateEER(args as ProfileData);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Profile saved!\nAge: ${profile.age} | Sex: ${profile.sex} | Height: ${profile.height_cm}cm | Weight: ${profile.weight_kg}kg | Activity: ${profile.activity_level}\nEstimated daily calorie needs (EER): ${eer} kcal`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_profile",
        {
            title: "Get User Profile",
            description: "Get your current profile (age, sex, height, weight, activity level) and estimated daily calorie needs.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "get_profile",
                async () => {
                    const profile = await getProfile(userId);
                    if (!profile) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No profile set yet. Use set_profile to create one.",
                                },
                            ],
                        };
                    }
                    const eer = calculateEER(profile as ProfileData);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Age: ${profile.age} | Sex: ${profile.sex} | Height: ${profile.height_cm}cm | Weight: ${profile.weight_kg}kg | Activity: ${profile.activity_level}\nEstimated daily calorie needs (EER): ${eer} kcal`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    // ---------- Weight Tools ----------

    server.registerTool(
        "log_weight",
        {
            title: "Log Weight",
            description: "Log a weight entry. Defaults to now if no timestamp provided.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                weight_kg: z.coerce.number().positive().describe("Weight in kilograms"),
                logged_at: z
                    .string()
                    .optional()
                    .describe("ISO 8601 timestamp (defaults to now)"),
            },
        },
        async ({ weight_kg, logged_at }) => {
            return withAnalytics(
                "log_weight",
                async () => {
                    const entry = await insertWeight(userId, weight_kg, logged_at);

                    // Sync weight to profile
                    const profile = await getProfile(userId);
                    if (profile) {
                        await upsertProfile(userId, {
                            age: profile.age,
                            sex: profile.sex as "male" | "female",
                            height_cm: profile.height_cm,
                            weight_kg,
                            activity_level: profile.activity_level as "inactive" | "low_active" | "active" | "very_active",
                        });
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Weight logged: ${entry.weight_kg}kg at ${entry.logged_at}. Profile weight updated.`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_weight_history",
        {
            title: "Get Weight History",
            description: "Get weight entries for a date range, sorted chronologically.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                start_date: z.string().describe("Start date (YYYY-MM-DD)"),
                end_date: z.string().describe("End date (YYYY-MM-DD)"),
            },
        },
        async ({ start_date, end_date }) => {
            return withAnalytics(
                "get_weight_history",
                async () => {
                    const entries = await getWeightInRange(userId, start_date, end_date);
                    if (entries.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No weight entries between ${start_date} and ${end_date}.`,
                                },
                            ],
                        };
                    }
                    const lines = entries.map(
                        (e) => `${e.logged_at.slice(0, 10)}: ${e.weight_kg}kg`,
                    );
                    const first = entries[0]!.weight_kg;
                    const last = entries[entries.length - 1]!.weight_kg;
                    const diff = last - first;
                    const trend =
                        diff > 0 ? `+${diff.toFixed(1)}kg` : `${diff.toFixed(1)}kg`;
                    lines.push(`\nChange over period: ${trend}`);
                    return {
                        content: [{ type: "text", text: lines.join("\n") }],
                    };
                },
                { userId },
                { start_date, end_date },
            );
        },
    );

    // ---------- Steps Tools ----------

    server.registerTool(
        "log_steps",
        {
            title: "Log Steps",
            description:
                "Log a step count entry. Automatically estimates calories burned based on your profile weight. Set up your profile first with set_profile for accurate estimates.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                step_count: z.coerce.number().int().positive().describe("Number of steps"),
                logged_at: z
                    .string()
                    .optional()
                    .describe("ISO 8601 timestamp (defaults to now)"),
            },
        },
        async ({ step_count, logged_at }) => {
            return withAnalytics(
                "log_steps",
                async () => {
                    const profile = await getProfile(userId);
                    const weightKg = profile?.weight_kg ?? 70; // fallback to 70kg
                    const caloriesBurned = calculateStepCalories(step_count, weightKg);
                    const entry = await insertSteps(
                        userId,
                        step_count,
                        caloriesBurned,
                        logged_at,
                    );
                    const note = profile
                        ? ""
                        : " (using default 70kg — set your profile for accurate estimates)";
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Steps logged: ${entry.step_count} steps | ~${caloriesBurned} cal burned${note} at ${entry.logged_at}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_steps_history",
        {
            title: "Get Steps History",
            description: "Get step entries for a date range with calories burned.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                start_date: z.string().describe("Start date (YYYY-MM-DD)"),
                end_date: z.string().describe("End date (YYYY-MM-DD)"),
            },
        },
        async ({ start_date, end_date }) => {
            return withAnalytics(
                "get_steps_history",
                async () => {
                    const entries = await getStepsInRange(userId, start_date, end_date);
                    if (entries.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No step entries between ${start_date} and ${end_date}.`,
                                },
                            ],
                        };
                    }
                    const lines = entries.map(
                        (e) =>
                            `${e.logged_at.slice(0, 10)}: ${e.step_count} steps | ~${e.calories_burned ?? 0} cal burned`,
                    );
                    const totalSteps = entries.reduce((s, e) => s + e.step_count, 0);
                    const totalCal = entries.reduce(
                        (s, e) => s + (e.calories_burned ?? 0),
                        0,
                    );
                    lines.push(`\nTotal: ${totalSteps} steps | ~${totalCal} cal burned`);
                    return {
                        content: [{ type: "text", text: lines.join("\n") }],
                    };
                },
                { userId },
                { start_date, end_date },
            );
        },
    );

    // ---------- DRI & Nutrition Tools ----------

    server.registerTool(
        "get_dri_targets",
        {
            title: "Get DRI Targets",
            description:
                "Get your personalized daily nutrient targets (calories, protein, carbs, fat, fibre, water) based on your profile. Requires a profile to be set first.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "get_dri_targets",
                async () => {
                    const profile = await getProfile(userId);
                    if (!profile) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No profile set. Use set_profile first to get personalized targets.",
                                },
                            ],
                        };
                    }
                    const targets = getDRITargets(profile as ProfileData);
                    const text = [
                        `Daily targets for ${profile.sex}, age ${profile.age}, ${profile.activity_level}:`,
                        `Calories: ${targets.calories_kcal} kcal`,
                        `Protein: ${targets.protein_g.rda}g RDA (range: ${targets.protein_g.min}-${targets.protein_g.max}g)`,
                        `Carbs: ${targets.carbs_g.rda}g RDA (range: ${targets.carbs_g.min}-${targets.carbs_g.max}g)`,
                        `Fat: ${targets.fat_g.min}-${targets.fat_g.max}g`,
                        `Fibre: ${targets.fibre_g}g`,
                        `Water: ${targets.water_l}L`,
                    ].join("\n");
                    return { content: [{ type: "text", text }] };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_daily_summary",
        {
            title: "Get Daily Summary",
            description:
                "Get a full daily summary: calories in (meals) vs calories out (EER + step burn), deficit/surplus, and macro totals vs DRI targets. Requires a profile to be set.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                date: z
                    .string()
                    .optional()
                    .describe("Date in YYYY-MM-DD format (defaults to today)"),
            },
        },
        async ({ date }) => {
            return withAnalytics(
                "get_daily_summary",
                async () => {
                    const targetDate = date ?? todayDate();
                    const profile = await getProfile(userId);
                    if (!profile) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No profile set. Use set_profile first for a full daily summary.",
                                },
                            ],
                        };
                    }

                    const [meals, steps] = await Promise.all([
                        getMealsByDate(userId, targetDate),
                        getStepsInRange(userId, targetDate, targetDate),
                    ]);

                    const profileData = profile as ProfileData;
                    const eer = calculateEER(profileData);
                    const targets = getDRITargets(profileData);

                    // Calories in
                    const caloriesIn = meals.reduce(
                        (s, m) => s + (m.calories ?? 0),
                        0,
                    );
                    const proteinIn = meals.reduce(
                        (s, m) => s + (m.protein_g ?? 0),
                        0,
                    );
                    const carbsIn = meals.reduce(
                        (s, m) => s + (m.carbs_g ?? 0),
                        0,
                    );
                    const fatIn = meals.reduce(
                        (s, m) => s + (m.fat_g ?? 0),
                        0,
                    );

                    // Calories out
                    const stepCalories = steps.reduce(
                        (s, e) => s + (e.calories_burned ?? 0),
                        0,
                    );
                    const totalSteps = steps.reduce(
                        (s, e) => s + e.step_count,
                        0,
                    );
                    const caloriesOut = eer + stepCalories;

                    // Deficit/surplus
                    const balance = caloriesIn - caloriesOut;
                    const balanceLabel =
                        balance < 0
                            ? `${balance} kcal (DEFICIT)`
                            : balance > 0
                              ? `+${balance} kcal (SURPLUS)`
                              : "0 kcal (BALANCED)";

                    const text = [
                        `=== Daily Summary for ${targetDate} ===`,
                        ``,
                        `CALORIES IN:  ${caloriesIn} kcal (${meals.length} meals)`,
                        `CALORIES OUT: ${caloriesOut} kcal (EER: ${eer} + Steps: ${stepCalories})`,
                        `BALANCE:      ${balanceLabel}`,
                        ``,
                        `STEPS: ${totalSteps} steps (~${stepCalories} cal burned)`,
                        ``,
                        `MACROS vs TARGETS:`,
                        `  Protein: ${proteinIn}g / ${targets.protein_g.rda}g RDA`,
                        `  Carbs:   ${carbsIn}g / ${targets.carbs_g.rda}g RDA`,
                        `  Fat:     ${fatIn}g / ${targets.fat_g.min}-${targets.fat_g.max}g range`,
                    ].join("\n");

                    return { content: [{ type: "text", text }] };
                },
                { userId },
                { date },
            );
        },
    );

    server.registerTool(
        "lookup_nutrient",
        {
            title: "Lookup Nutrient Info",
            description:
                "Look up nutritional information for a food item using Canada's Canadian Nutrient File. Returns macros per 100g for matching foods.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
            inputSchema: {
                query: z.string().describe("Food name to search for (e.g. 'chicken breast', 'banana', 'cheddar cheese')"),
            },
        },
        async ({ query }) => {
            return withAnalytics(
                "lookup_nutrient",
                async () => {
                    const results = await lookupNutrient(query);
                    if (results.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No results found for "${query}" in the Canadian Nutrient File.`,
                                },
                            ],
                        };
                    }
                    const sections = results.map((r) => {
                        const nutrients = r.nutrients
                            .map((n) => `  ${n.name}: ${n.value} ${n.unit}`)
                            .join("\n");
                        return `${r.food_description} (per 100g):\n${nutrients}`;
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Results for "${query}" (per 100g):\n\n${sections.join("\n\n---\n\n")}`,
                            },
                        ],
                    };
                },
                { userId },
                { query },
            );
        },
    );

    server.registerTool(
        "delete_account",
        {
            title: "Delete Account",
            description:
                "Permanently delete the user's account and all associated data (meals, tokens, auth). This action is irreversible. Always confirm with the user before calling this tool.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                confirm: z
                    .boolean()
                    .describe(
                        "Must be true to confirm deletion. Always ask the user for explicit confirmation before setting this to true.",
                    ),
            },
        },
        async ({ confirm }) => {
            return withAnalytics(
                "delete_account",
                async () => {
                    if (!confirm) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Account deletion cancelled. No data was removed.",
                                },
                            ],
                        };
                    }
                    await deleteAllUserData(userId);
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Your account and all associated data have been permanently deleted.",
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );
}

export const handleMcp = async (c: Context) => {
    const mcpToken = c.get("accessToken") as string;
    const userId = c.get("userId") as string;
    const sessionId = c.req.header("mcp-session-id");

    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (sessionId && !session) {
        return c.json({ error: "invalid_session" }, 404);
    }

    if (session && session.mcpToken !== mcpToken) {
        return c.json({ error: "forbidden" }, 403);
    }

    if (session) {
        session.lastActivity = Date.now();
        return session.transport.handleRequest(c.req.raw);
    }

    if (c.req.method !== "POST") {
        return c.json({ error: "invalid_request" }, 400);
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
            sessions.set(id, {
                transport,
                mcpToken,
                lastActivity: Date.now(),
            });
        },
        onsessionclosed: (id) => {
            sessions.delete(id);
        },
    });

    const proto = c.req.header("x-forwarded-proto") || "http";
    const host =
        c.req.header("x-forwarded-host") || c.req.header("host") || "localhost";
    const baseUrl = `${proto}://${host}`;

    const server = new McpServer(
        {
            name: "nutrition-mcp",
            version: "2.0.0",
            icons: [
                {
                    src: `${baseUrl}/favicon.ico`,
                    mimeType: "image/x-icon",
                },
            ],
        },
        { capabilities: { tools: {} } },
    );

    registerTools(server, userId);
    await server.connect(transport);

    return transport.handleRequest(c.req.raw);
};
