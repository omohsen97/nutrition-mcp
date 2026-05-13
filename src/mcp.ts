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
    getUserTimezone,
    setUserTimezone,
    insertWeight,
    getWeightInRange,
    deleteWeight,
    insertSteps,
    getStepsInRange,
    deleteSteps,
    type Meal,
} from "./supabase.js";
import { withAnalytics } from "./analytics.js";
import {
    calculateEER,
    calculateStepCalories,
    getDRITargets,
    lookupNutrient,
    type ProfileData,
} from "./health.js";
import {
    DEFAULT_TIMEZONE,
    dateInZone,
    todayInZone,
    formatInstantInZone,
    isValidTimezone,
} from "./timezone.js";
import {
    upsertMealFavorite,
    listMealFavorites,
    getMealFavoriteByName,
    deleteMealFavorite,
    bumpFavoriteUsage,
    saveRecipe,
    listRecipes,
    getRecipeByName,
    deleteRecipe,
    type RecipeWithIngredients,
} from "./favorites.js";
import {
    GOOGLE_HEALTH_DATA_TYPES,
    createAuthorizeUrl,
    getStoredTokens,
    getSyncState,
    queryStoredDataPoints,
    revokeAndDisconnect,
    syncDataType,
} from "./googleHealth.js";

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

function formatMeal(meal: Meal, tz: string): string {
    const parts = [
        `ID: ${meal.id}`,
        `Time: ${formatInstantInZone(meal.logged_at, tz)}`,
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

function formatRecipe(recipe: RecipeWithIngredients): string {
    const macros = [
        recipe.calories_per_serving != null
            ? `${recipe.calories_per_serving} kcal`
            : null,
        recipe.protein_g_per_serving != null
            ? `P:${recipe.protein_g_per_serving}g`
            : null,
        recipe.carbs_g_per_serving != null
            ? `C:${recipe.carbs_g_per_serving}g`
            : null,
        recipe.fat_g_per_serving != null
            ? `F:${recipe.fat_g_per_serving}g`
            : null,
    ]
        .filter(Boolean)
        .join(" | ");

    const lines: string[] = [
        `Recipe: ${recipe.name} (${recipe.servings} serving${recipe.servings === 1 ? "" : "s"})`,
    ];
    if (recipe.description) lines.push(recipe.description);
    if (macros) lines.push(`Per serving: ${macros}`);
    if (recipe.ingredients.length > 0) {
        lines.push("", "Ingredients:");
        for (const ing of recipe.ingredients) {
            const ingMacros = [
                ing.calories != null ? `${ing.calories} kcal` : null,
                ing.protein_g != null ? `P:${ing.protein_g}g` : null,
                ing.carbs_g != null ? `C:${ing.carbs_g}g` : null,
                ing.fat_g != null ? `F:${ing.fat_g}g` : null,
            ]
                .filter(Boolean)
                .join(" | ");
            const amount = ing.amount ? ` (${ing.amount})` : "";
            lines.push(
                `  • ${ing.name}${amount}${ingMacros ? ` — ${ingMacros}` : ""}`,
            );
        }
    }
    if (recipe.notes) lines.push("", `Notes: ${recipe.notes}`);
    return lines.join("\n");
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
                    const tz = await getUserTimezone(userId);
                    const meal = await insertMeal(userId, args);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Meal logged:\n${formatMeal(meal, tz)}`,
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
                    const tz = await getUserTimezone(userId);
                    const meals = await getMealsByDate(
                        userId,
                        todayInZone(tz),
                        tz,
                    );
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
                    const text = meals
                        .map((m) => formatMeal(m, tz))
                        .join("\n\n---\n\n");
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
                    const tz = await getUserTimezone(userId);
                    const meals = await getMealsByDate(userId, date, tz);
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
                    const text = meals
                        .map((m) => formatMeal(m, tz))
                        .join("\n\n---\n\n");
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
                    const tz = await getUserTimezone(userId);
                    const meals = await getMealsInRange(
                        userId,
                        start_date,
                        end_date,
                        tz,
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

                    // Group by local-zone date so the headers match the user's "day"
                    const byDate = new Map<string, Meal[]>();
                    for (const meal of meals) {
                        const date = dateInZone(new Date(meal.logged_at), tz);
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
                            .map((m) => formatMeal(m, tz))
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
                    const tz = await getUserTimezone(userId);
                    const meals = await getMealsInRange(
                        userId,
                        start_date,
                        end_date,
                        tz,
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

                    // Group by local-zone date
                    const byDate = new Map<string, Meal[]>();
                    for (const meal of meals) {
                        const date = dateInZone(new Date(meal.logged_at), tz);
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
                    const tz = await getUserTimezone(userId);
                    const meal = await updateMeal(userId, id, fields);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Meal updated:\n${formatMeal(meal, tz)}`,
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
                timezone: z
                    .string()
                    .optional()
                    .describe(
                        `IANA timezone name (e.g. "America/New_York", "UTC"). Optional — only set if you want to change it. Defaults to ${DEFAULT_TIMEZONE} on first profile.`,
                    ),
            },
        },
        async (args) => {
            return withAnalytics(
                "set_profile",
                async () => {
                    if (args.timezone && !isValidTimezone(args.timezone)) {
                        throw new Error(
                            `Invalid timezone "${args.timezone}". Use an IANA name like "America/New_York" or "UTC".`,
                        );
                    }
                    const profile = await upsertProfile(userId, args);
                    const eer = calculateEER(args as ProfileData);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Profile saved!\nAge: ${profile.age} | Sex: ${profile.sex} | Height: ${profile.height_cm}cm | Weight: ${profile.weight_kg}kg | Activity: ${profile.activity_level} | Timezone: ${profile.timezone}\nEstimated daily calorie needs (EER): ${eer} kcal`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "set_timezone",
        {
            title: "Set Timezone",
            description:
                'Change the timezone used for "today", date-range queries, and timestamp display. Pass an IANA name like "America/New_York", "America/Los_Angeles", or "UTC". Requires a profile to exist first.',
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                timezone: z
                    .string()
                    .describe(
                        'IANA timezone name (e.g. "America/New_York", "UTC"). EDT/EST are not valid — use "America/New_York" which auto-handles DST.',
                    ),
            },
        },
        async ({ timezone }) => {
            return withAnalytics(
                "set_timezone",
                async () => {
                    if (!isValidTimezone(timezone)) {
                        throw new Error(
                            `Invalid timezone "${timezone}". Use an IANA name like "America/New_York" or "UTC".`,
                        );
                    }
                    const saved = await setUserTimezone(userId, timezone);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Timezone set to ${saved}. "Today" is now ${todayInZone(saved)} for you.`,
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
                                text: `Age: ${profile.age} | Sex: ${profile.sex} | Height: ${profile.height_cm}cm | Weight: ${profile.weight_kg}kg | Activity: ${profile.activity_level} | Timezone: ${profile.timezone}\nEstimated daily calorie needs (EER): ${eer} kcal`,
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
                    const tz = profile?.timezone ?? DEFAULT_TIMEZONE;

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Weight logged: ${entry.weight_kg}kg at ${formatInstantInZone(entry.logged_at, tz)}. Profile weight updated.`,
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
                    const tz = await getUserTimezone(userId);
                    const entries = await getWeightInRange(
                        userId,
                        start_date,
                        end_date,
                        tz,
                    );
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
                        (e) =>
                            `ID: ${e.id} | ${dateInZone(new Date(e.logged_at), tz)}: ${e.weight_kg}kg`,
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

    server.registerTool(
        "delete_weight",
        {
            title: "Delete Weight",
            description: "Delete a weight entry by ID",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the weight entry to delete"),
            },
        },
        async ({ id }) => {
            return withAnalytics(
                "delete_weight",
                async () => {
                    await deleteWeight(userId, id);
                    return {
                        content: [
                            { type: "text", text: `Weight entry ${id} deleted.` },
                        ],
                    };
                },
                { userId },
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
                    const tz = profile?.timezone ?? DEFAULT_TIMEZONE;
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Steps logged: ${entry.step_count} steps | ~${caloriesBurned} cal burned${note} at ${formatInstantInZone(entry.logged_at, tz)}`,
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
                    const tz = await getUserTimezone(userId);
                    const entries = await getStepsInRange(
                        userId,
                        start_date,
                        end_date,
                        tz,
                    );
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
                            `ID: ${e.id} | ${dateInZone(new Date(e.logged_at), tz)}: ${e.step_count} steps | ~${e.calories_burned ?? 0} cal burned`,
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

    server.registerTool(
        "delete_steps",
        {
            title: "Delete Steps",
            description: "Delete a step entry by ID",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the step entry to delete"),
            },
        },
        async ({ id }) => {
            return withAnalytics(
                "delete_steps",
                async () => {
                    await deleteSteps(userId, id);
                    return {
                        content: [
                            { type: "text", text: `Step entry ${id} deleted.` },
                        ],
                    };
                },
                { userId },
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
                    const tz = profile.timezone ?? DEFAULT_TIMEZONE;
                    const targetDate = date ?? todayInZone(tz);

                    const [meals, steps] = await Promise.all([
                        getMealsByDate(userId, targetDate, tz),
                        getStepsInRange(userId, targetDate, targetDate, tz),
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

    // ---------- Meal Favorites ----------

    server.registerTool(
        "save_meal_favorite",
        {
            title: "Save Meal Favorite",
            description:
                "Save a meal as a named favorite for quick re-logging. Use this whenever the user mentions a meal they eat regularly so they don't have to re-describe it later. The 'name' is a short identifier the user (or you) will reference later (e.g. 'morning oatmeal', 'go-to chipotle bowl'). If a favorite with that name already exists, it is updated.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                name: z
                    .string()
                    .min(1)
                    .max(80)
                    .describe(
                        "Short identifier for the favorite (e.g. 'morning oatmeal'). Used to look it up later.",
                    ),
                description: z
                    .string()
                    .describe("What the meal is — same shape as log_meal description"),
                default_meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .optional()
                    .describe(
                        "Default meal type for this favorite. Can be overridden when logging.",
                    ),
                calories: z.coerce.number().optional(),
                protein_g: z.coerce.number().optional(),
                carbs_g: z.coerce.number().optional(),
                fat_g: z.coerce.number().optional(),
                notes: z.string().optional(),
            },
        },
        async (args) => {
            return withAnalytics(
                "save_meal_favorite",
                async () => {
                    const fav = await upsertMealFavorite(userId, args);
                    const macros = [
                        fav.calories != null ? `${fav.calories} kcal` : null,
                        fav.protein_g != null ? `P:${fav.protein_g}g` : null,
                        fav.carbs_g != null ? `C:${fav.carbs_g}g` : null,
                        fav.fat_g != null ? `F:${fav.fat_g}g` : null,
                    ]
                        .filter(Boolean)
                        .join(" | ");
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Favorite saved: "${fav.name}"\n${fav.description}${macros ? `\n${macros}` : ""}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "list_meal_favorites",
        {
            title: "List Meal Favorites",
            description:
                "List all saved meal favorites, sorted by most recently used. Call this when the user wants to see their favorites or when you need to find the right name to log_meal_from_favorite.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "list_meal_favorites",
                async () => {
                    const favs = await listMealFavorites(userId);
                    if (favs.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No meal favorites yet. Use save_meal_favorite to add one.",
                                },
                            ],
                        };
                    }
                    const lines = favs.map((f) => {
                        const macros = [
                            f.calories != null ? `${f.calories} kcal` : null,
                            f.protein_g != null ? `P:${f.protein_g}g` : null,
                            f.carbs_g != null ? `C:${f.carbs_g}g` : null,
                            f.fat_g != null ? `F:${f.fat_g}g` : null,
                        ]
                            .filter(Boolean)
                            .join(" | ");
                        const used =
                            f.use_count > 0
                                ? ` (used ${f.use_count}x)`
                                : "";
                        return `• "${f.name}"${used}\n  ${f.description}${macros ? `\n  ${macros}` : ""}`;
                    });
                    return {
                        content: [
                            { type: "text", text: lines.join("\n\n") },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "log_meal_from_favorite",
        {
            title: "Log Meal From Favorite",
            description:
                "Log a meal entry by referencing a saved favorite by name. Creates a new meal entry using the favorite's stored macros. Bumps the favorite's use count so frequently-logged meals stay near the top.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                name: z
                    .string()
                    .describe("Name of the favorite to log (case-sensitive)"),
                meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .optional()
                    .describe(
                        "Override the favorite's default meal type for this log entry",
                    ),
                logged_at: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 timestamp (defaults to now). If you don't know the current time, ask the user.",
                    ),
                notes: z
                    .string()
                    .optional()
                    .describe(
                        "Optional one-off notes to attach to this specific log entry",
                    ),
            },
        },
        async ({ name, meal_type, logged_at, notes }) => {
            return withAnalytics(
                "log_meal_from_favorite",
                async () => {
                    const fav = await getMealFavoriteByName(userId, name);
                    if (!fav) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No favorite named "${name}". Use list_meal_favorites to see available names.`,
                                },
                            ],
                            isError: true,
                        };
                    }
                    const resolvedType =
                        meal_type ?? fav.default_meal_type ?? "snack";
                    const meal = await insertMeal(userId, {
                        description: fav.description,
                        meal_type: resolvedType as
                            | "breakfast"
                            | "lunch"
                            | "dinner"
                            | "snack",
                        calories: fav.calories ?? undefined,
                        protein_g: fav.protein_g ?? undefined,
                        carbs_g: fav.carbs_g ?? undefined,
                        fat_g: fav.fat_g ?? undefined,
                        logged_at,
                        notes: notes ?? fav.notes ?? undefined,
                    });
                    await bumpFavoriteUsage(userId, name);

                    const tz = await getUserTimezone(userId);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Logged from favorite "${fav.name}":\n${formatMeal(meal, tz)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "delete_meal_favorite",
        {
            title: "Delete Meal Favorite",
            description: "Delete a saved meal favorite by name.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                name: z
                    .string()
                    .describe("Name of the favorite to delete (case-sensitive)"),
            },
        },
        async ({ name }) => {
            return withAnalytics(
                "delete_meal_favorite",
                async () => {
                    await deleteMealFavorite(userId, name);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Favorite "${name}" deleted.`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    // ---------- Recipes ----------

    server.registerTool(
        "save_recipe",
        {
            title: "Save Recipe",
            description:
                "Save a recipe — a composed meal with multiple ingredients and a serving size. Use this for things the user cooks regularly. You can either supply per-serving macros directly, or list ingredients with their individual macros and the per-serving values will be computed for you (totals divided by servings). Saving a recipe with the same name updates it and replaces all ingredients.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                name: z
                    .string()
                    .min(1)
                    .max(80)
                    .describe("Short recipe identifier (e.g. 'turkey chili')"),
                description: z
                    .string()
                    .optional()
                    .describe("Free-form description of the recipe"),
                servings: z
                    .coerce.number()
                    .positive()
                    .optional()
                    .describe(
                        "How many servings the full recipe yields (default: 1)",
                    ),
                calories_per_serving: z.coerce.number().optional(),
                protein_g_per_serving: z.coerce.number().optional(),
                carbs_g_per_serving: z.coerce.number().optional(),
                fat_g_per_serving: z.coerce.number().optional(),
                notes: z.string().optional(),
                ingredients: z
                    .array(
                        z.object({
                            name: z.string(),
                            amount: z.string().optional(),
                            calories: z.coerce.number().optional(),
                            protein_g: z.coerce.number().optional(),
                            carbs_g: z.coerce.number().optional(),
                            fat_g: z.coerce.number().optional(),
                        }),
                    )
                    .optional()
                    .describe(
                        "Optional list of ingredients. If provided without explicit per-serving macros, totals are summed and divided by servings to compute per-serving values.",
                    ),
            },
        },
        async (args) => {
            return withAnalytics(
                "save_recipe",
                async () => {
                    const recipe = await saveRecipe(userId, args);
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatRecipe(recipe),
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "list_recipes",
        {
            title: "List Recipes",
            description:
                "List all saved recipes (name, servings, per-serving macros). Use get_recipe for full ingredient breakdown.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "list_recipes",
                async () => {
                    const recipes = await listRecipes(userId);
                    if (recipes.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No recipes yet. Use save_recipe to add one.",
                                },
                            ],
                        };
                    }
                    const lines = recipes.map((r) => {
                        const macros = [
                            r.calories_per_serving != null
                                ? `${r.calories_per_serving} kcal`
                                : null,
                            r.protein_g_per_serving != null
                                ? `P:${r.protein_g_per_serving}g`
                                : null,
                            r.carbs_g_per_serving != null
                                ? `C:${r.carbs_g_per_serving}g`
                                : null,
                            r.fat_g_per_serving != null
                                ? `F:${r.fat_g_per_serving}g`
                                : null,
                        ]
                            .filter(Boolean)
                            .join(" | ");
                        return `• "${r.name}" — ${r.servings} serving${r.servings === 1 ? "" : "s"}${macros ? ` | per serving: ${macros}` : ""}`;
                    });
                    return {
                        content: [{ type: "text", text: lines.join("\n") }],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_recipe",
        {
            title: "Get Recipe",
            description:
                "Get full recipe details including all ingredients with their amounts and macros.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                name: z
                    .string()
                    .describe("Recipe name (case-sensitive)"),
            },
        },
        async ({ name }) => {
            return withAnalytics(
                "get_recipe",
                async () => {
                    const recipe = await getRecipeByName(userId, name);
                    if (!recipe) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No recipe named "${name}".`,
                                },
                            ],
                            isError: true,
                        };
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatRecipe(recipe),
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "log_recipe",
        {
            title: "Log Recipe as Meal",
            description:
                "Log a meal entry from a saved recipe, scaled by servings eaten. Macros are multiplied by servings_eaten and inserted as a new meal entry.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                name: z
                    .string()
                    .describe("Name of the recipe (case-sensitive)"),
                servings_eaten: z
                    .coerce.number()
                    .positive()
                    .default(1)
                    .describe(
                        "How many servings of the recipe were eaten (default: 1)",
                    ),
                meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .describe("Type of meal"),
                logged_at: z
                    .string()
                    .optional()
                    .describe("ISO 8601 timestamp (defaults to now)"),
                notes: z.string().optional(),
            },
        },
        async ({ name, servings_eaten, meal_type, logged_at, notes }) => {
            return withAnalytics(
                "log_recipe",
                async () => {
                    const recipe = await getRecipeByName(userId, name);
                    if (!recipe) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No recipe named "${name}".`,
                                },
                            ],
                            isError: true,
                        };
                    }
                    const factor = servings_eaten;
                    const scale = (
                        v: number | null,
                        round: (n: number) => number,
                    ) => (v == null ? undefined : round(v * factor));

                    const meal = await insertMeal(userId, {
                        description: `${recipe.name} (${servings_eaten} serving${servings_eaten === 1 ? "" : "s"})`,
                        meal_type,
                        calories: scale(recipe.calories_per_serving, Math.round),
                        protein_g: scale(
                            recipe.protein_g_per_serving,
                            (n) => Math.round(n * 10) / 10,
                        ),
                        carbs_g: scale(
                            recipe.carbs_g_per_serving,
                            (n) => Math.round(n * 10) / 10,
                        ),
                        fat_g: scale(
                            recipe.fat_g_per_serving,
                            (n) => Math.round(n * 10) / 10,
                        ),
                        logged_at,
                        notes:
                            notes ??
                            recipe.notes ??
                            recipe.description ??
                            undefined,
                    });
                    const tz = await getUserTimezone(userId);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Logged ${servings_eaten} serving(s) of recipe "${recipe.name}":\n${formatMeal(meal, tz)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "delete_recipe",
        {
            title: "Delete Recipe",
            description:
                "Delete a recipe by name. Ingredients are removed automatically.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                name: z
                    .string()
                    .describe("Recipe name (case-sensitive)"),
            },
        },
        async ({ name }) => {
            return withAnalytics(
                "delete_recipe",
                async () => {
                    await deleteRecipe(userId, name);
                    return {
                        content: [
                            { type: "text", text: `Recipe "${name}" deleted.` },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    // ---------- Google Health (Fitbit Air) ----------

    server.registerTool(
        "google_health_connect",
        {
            title: "Connect Google Health",
            description:
                "Returns a URL the user must visit in a browser to authorize this server to read their Google Health data (Fitbit Air, Google Health app). On approval the user is redirected back to the server, which stores their tokens. Tell the user to open the returned URL, sign in to Google, approve the requested scopes, and then come back here.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async () => {
            return withAnalytics(
                "google_health_connect",
                async () => {
                    const url = await createAuthorizeUrl(userId);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Open this URL in your browser to authorize Google Health access:\n\n${url}\n\nAfter approval, return here and run google_health_sync.`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "google_health_status",
        {
            title: "Google Health Connection Status",
            description:
                "Check whether Google Health is connected, when the access token expires, what scopes were granted, and the last-sync state for each data type.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "google_health_status",
                async () => {
                    const tokens = await getStoredTokens(userId);
                    if (!tokens) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Not connected. Run google_health_connect to start.",
                                },
                            ],
                        };
                    }
                    const expiresAt = new Date(tokens.expires_at);
                    const expired = expiresAt.getTime() < Date.now();
                    const syncRows = await getSyncState(userId);

                    const lines: string[] = [
                        `Connected: yes`,
                        `Access token ${expired ? "EXPIRED" : "valid until"} ${expiresAt.toISOString()}`,
                        `Refresh token: ${tokens.refresh_token ? "stored" : "MISSING (re-auth required)"}`,
                        `Scopes: ${tokens.scopes.join(", ")}`,
                    ];
                    if (tokens.google_user_id)
                        lines.push(`Google user ID: ${tokens.google_user_id}`);
                    if (tokens.legacy_fitbit_user_id)
                        lines.push(
                            `Legacy Fitbit user ID: ${tokens.legacy_fitbit_user_id}`,
                        );
                    if (syncRows.length > 0) {
                        lines.push("", "Sync state:");
                        for (const r of syncRows) {
                            const last = r.last_synced_through ?? "never";
                            const err = r.last_error
                                ? ` ERROR: ${r.last_error}`
                                : "";
                            lines.push(
                                `  ${r.data_type}: synced through ${last}${err}`,
                            );
                        }
                    } else {
                        lines.push("", "Sync state: nothing synced yet");
                    }
                    return {
                        content: [{ type: "text", text: lines.join("\n") }],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "google_health_sync",
        {
            title: "Sync Google Health Data",
            description:
                "Pull data points from Google Health for the given time range and store them locally. By default syncs all 30+ supported data types. Pass `data_types` to limit to a subset (e.g. ['sleep','heart-rate','steps']). Use start_time/end_time as ISO 8601 timestamps. For most use cases, sync 1-7 days at a time to stay under page-size limits.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                start_time: z
                    .string()
                    .describe(
                        "ISO 8601 start timestamp (e.g. '2026-05-01T00:00:00Z')",
                    ),
                end_time: z
                    .string()
                    .describe("ISO 8601 end timestamp"),
                data_types: z
                    .array(z.string())
                    .optional()
                    .describe(
                        "Specific data type identifiers to sync (e.g. ['sleep','heart-rate']). Omit to sync all 30+ supported types.",
                    ),
            },
        },
        async ({ start_time, end_time, data_types }) => {
            return withAnalytics(
                "google_health_sync",
                async () => {
                    const allTypes: string[] = Object.values(
                        GOOGLE_HEALTH_DATA_TYPES,
                    ).flatMap((arr) => [...arr]);
                    const targets =
                        data_types && data_types.length > 0
                            ? data_types
                            : allTypes;

                    const results = [];
                    for (const dt of targets) {
                        const r = await syncDataType(userId, dt, {
                            startTime: start_time,
                            endTime: end_time,
                        });
                        results.push(r);
                    }

                    const summary = results.map((r) => {
                        const status = r.error
                            ? `ERROR: ${r.error}`
                            : `${r.inserted} inserted, ${r.skipped} skipped`;
                        return `  ${r.dataType}: ${status}`;
                    });
                    const totalInserted = results.reduce(
                        (s, r) => s + r.inserted,
                        0,
                    );
                    const errCount = results.filter((r) => r.error).length;

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Sync complete: ${totalInserted} points inserted across ${targets.length} data types${errCount > 0 ? ` (${errCount} errored)` : ""}.\n\n${summary.join("\n")}`,
                            },
                        ],
                    };
                },
                { userId },
                { start_date: start_time, end_date: end_time },
            );
        },
    );

    server.registerTool(
        "google_health_get_data_points",
        {
            title: "Query Stored Google Health Data Points",
            description:
                "Read previously-synced Google Health data points from local storage. Run google_health_sync first to populate. Returns raw data points with their full payload — useful for inspecting heart rate samples, sleep stages, etc.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                data_type: z
                    .string()
                    .describe(
                        "Data type identifier (e.g. 'sleep', 'heart-rate', 'steps'). See list_google_health_data_types for the full list.",
                    ),
                start_time: z
                    .string()
                    .describe("ISO 8601 start timestamp"),
                end_time: z.string().describe("ISO 8601 end timestamp"),
                limit: z
                    .coerce.number()
                    .int()
                    .positive()
                    .max(1000)
                    .optional()
                    .describe("Max points to return (default 200, max 1000)"),
            },
        },
        async ({ data_type, start_time, end_time, limit }) => {
            return withAnalytics(
                "google_health_get_data_points",
                async () => {
                    const points = await queryStoredDataPoints(
                        userId,
                        data_type,
                        start_time,
                        end_time,
                        limit ?? 200,
                    );
                    if (points.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No stored ${data_type} points between ${start_time} and ${end_time}. Run google_health_sync to fetch from Google.`,
                                },
                            ],
                        };
                    }
                    const lines = points.map(
                        (p) =>
                            `${p.start_time}${p.end_time ? ` → ${p.end_time}` : ""}: ${JSON.stringify(p.value)}`,
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${points.length} ${data_type} points:\n\n${lines.join("\n")}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "list_google_health_data_types",
        {
            title: "List Google Health Data Types",
            description:
                "List all 30+ data types the Google Health API exposes, grouped by OAuth scope. Useful for picking which types to sync.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            return withAnalytics(
                "list_google_health_data_types",
                async () => {
                    const sections = Object.entries(
                        GOOGLE_HEALTH_DATA_TYPES,
                    ).map(([scope, types]) => {
                        return `${scope}:\n  ${[...types].join(", ")}`;
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: sections.join("\n\n"),
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "google_health_disconnect",
        {
            title: "Disconnect Google Health",
            description:
                "Revoke the stored Google Health refresh token and delete tokens from this server. Synced data points are preserved (use delete_account to wipe everything).",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                confirm: z
                    .boolean()
                    .describe(
                        "Must be true. Always confirm with the user before calling.",
                    ),
            },
        },
        async ({ confirm }) => {
            return withAnalytics(
                "google_health_disconnect",
                async () => {
                    if (!confirm) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Disconnect cancelled.",
                                },
                            ],
                        };
                    }
                    await revokeAndDisconnect(userId);
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Google Health disconnected. Stored data points preserved.",
                            },
                        ],
                    };
                },
                { userId },
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
            version: "5.0.0",
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
