import { getSupabase } from "./supabase.js";

// ---------- Meal favorites ----------

export interface MealFavorite {
    id: string;
    user_id: string;
    name: string;
    description: string;
    default_meal_type: "breakfast" | "lunch" | "dinner" | "snack" | null;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    notes: string | null;
    use_count: number;
    last_used_at: string | null;
    created_at: string;
}

export interface MealFavoriteInput {
    name: string;
    description: string;
    default_meal_type?: "breakfast" | "lunch" | "dinner" | "snack";
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    notes?: string;
}

export async function upsertMealFavorite(
    userId: string,
    input: MealFavoriteInput,
): Promise<MealFavorite> {
    const { data, error } = await getSupabase()
        .from("meal_favorites")
        .upsert(
            {
                user_id: userId,
                name: input.name,
                description: input.description,
                default_meal_type: input.default_meal_type ?? null,
                calories: input.calories ?? null,
                protein_g: input.protein_g ?? null,
                carbs_g: input.carbs_g ?? null,
                fat_g: input.fat_g ?? null,
                notes: input.notes ?? null,
            },
            { onConflict: "user_id,name" },
        )
        .select()
        .single();

    if (error) throw new Error(`Failed to save favorite: ${error.message}`);
    return data as MealFavorite;
}

export async function listMealFavorites(
    userId: string,
): Promise<MealFavorite[]> {
    // Sort by last-used desc (nulls last), then by created_at desc so the
    // most relevant favorites surface first.
    const { data, error } = await getSupabase()
        .from("meal_favorites")
        .select("*")
        .eq("user_id", userId)
        .order("last_used_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });

    if (error) throw new Error(`Failed to list favorites: ${error.message}`);
    return (data as MealFavorite[]) ?? [];
}

export async function getMealFavoriteByName(
    userId: string,
    name: string,
): Promise<MealFavorite | null> {
    const { data, error } = await getSupabase()
        .from("meal_favorites")
        .select("*")
        .eq("user_id", userId)
        .eq("name", name)
        .maybeSingle();

    if (error) throw new Error(`Failed to get favorite: ${error.message}`);
    return (data as MealFavorite | null) ?? null;
}

export async function deleteMealFavorite(
    userId: string,
    name: string,
): Promise<void> {
    const { error } = await getSupabase()
        .from("meal_favorites")
        .delete()
        .eq("user_id", userId)
        .eq("name", name);

    if (error) throw new Error(`Failed to delete favorite: ${error.message}`);
}

export async function bumpFavoriteUsage(
    userId: string,
    name: string,
): Promise<void> {
    // Get current count, then increment. Two queries instead of an RPC keeps
    // the migration footprint smaller; not hot enough to matter.
    const fav = await getMealFavoriteByName(userId, name);
    if (!fav) return;
    const { error } = await getSupabase()
        .from("meal_favorites")
        .update({
            use_count: fav.use_count + 1,
            last_used_at: new Date().toISOString(),
        })
        .eq("id", fav.id);

    if (error) throw new Error(`Failed to bump favorite usage: ${error.message}`);
}

// ---------- Recipes ----------

export interface Recipe {
    id: string;
    user_id: string;
    name: string;
    description: string | null;
    servings: number;
    calories_per_serving: number | null;
    protein_g_per_serving: number | null;
    carbs_g_per_serving: number | null;
    fat_g_per_serving: number | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

export interface RecipeIngredient {
    id?: string;
    name: string;
    amount: string | null;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    sort_order: number;
}

export interface RecipeWithIngredients extends Recipe {
    ingredients: RecipeIngredient[];
}

export interface RecipeInput {
    name: string;
    description?: string;
    servings?: number;
    calories_per_serving?: number;
    protein_g_per_serving?: number;
    carbs_g_per_serving?: number;
    fat_g_per_serving?: number;
    notes?: string;
    ingredients?: Array<{
        name: string;
        amount?: string;
        calories?: number;
        protein_g?: number;
        carbs_g?: number;
        fat_g?: number;
    }>;
}

export async function saveRecipe(
    userId: string,
    input: RecipeInput,
): Promise<RecipeWithIngredients> {
    const sb = getSupabase();
    const now = new Date().toISOString();

    // Compute per-serving macros from ingredients if they weren't passed
    // explicitly — handy when the caller itemizes a recipe and lets us do
    // the math.
    const hasIngredients =
        input.ingredients !== undefined && input.ingredients.length > 0;
    const macrosProvided =
        input.calories_per_serving !== undefined ||
        input.protein_g_per_serving !== undefined ||
        input.carbs_g_per_serving !== undefined ||
        input.fat_g_per_serving !== undefined;

    const servings = input.servings ?? 1;
    let computed = {
        calories_per_serving: input.calories_per_serving ?? null,
        protein_g_per_serving: input.protein_g_per_serving ?? null,
        carbs_g_per_serving: input.carbs_g_per_serving ?? null,
        fat_g_per_serving: input.fat_g_per_serving ?? null,
    };
    if (hasIngredients && !macrosProvided) {
        const totals = (input.ingredients ?? []).reduce(
            (acc, i) => ({
                calories: acc.calories + (i.calories ?? 0),
                protein_g: acc.protein_g + (i.protein_g ?? 0),
                carbs_g: acc.carbs_g + (i.carbs_g ?? 0),
                fat_g: acc.fat_g + (i.fat_g ?? 0),
            }),
            { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
        );
        computed = {
            calories_per_serving: Math.round(totals.calories / servings),
            protein_g_per_serving:
                Math.round((totals.protein_g / servings) * 10) / 10,
            carbs_g_per_serving:
                Math.round((totals.carbs_g / servings) * 10) / 10,
            fat_g_per_serving: Math.round((totals.fat_g / servings) * 10) / 10,
        };
    }

    const { data: recipe, error } = await sb
        .from("recipes")
        .upsert(
            {
                user_id: userId,
                name: input.name,
                description: input.description ?? null,
                servings,
                calories_per_serving: computed.calories_per_serving,
                protein_g_per_serving: computed.protein_g_per_serving,
                carbs_g_per_serving: computed.carbs_g_per_serving,
                fat_g_per_serving: computed.fat_g_per_serving,
                notes: input.notes ?? null,
                updated_at: now,
            },
            { onConflict: "user_id,name" },
        )
        .select()
        .single();

    if (error) throw new Error(`Failed to save recipe: ${error.message}`);
    const recipeRow = recipe as Recipe;

    // Replace ingredients on every save — simpler than diffing, and recipes
    // are user-owned so an extra delete/insert pair is fine.
    if (input.ingredients !== undefined) {
        const { error: delErr } = await sb
            .from("recipe_ingredients")
            .delete()
            .eq("recipe_id", recipeRow.id);
        if (delErr)
            throw new Error(
                `Failed to clear recipe ingredients: ${delErr.message}`,
            );

        if (input.ingredients.length > 0) {
            const rows = input.ingredients.map((ing, idx) => ({
                recipe_id: recipeRow.id,
                name: ing.name,
                amount: ing.amount ?? null,
                calories: ing.calories ?? null,
                protein_g: ing.protein_g ?? null,
                carbs_g: ing.carbs_g ?? null,
                fat_g: ing.fat_g ?? null,
                sort_order: idx,
            }));
            const { error: insErr } = await sb
                .from("recipe_ingredients")
                .insert(rows);
            if (insErr)
                throw new Error(
                    `Failed to insert recipe ingredients: ${insErr.message}`,
                );
        }
    }

    return await getRecipeWithIngredients(userId, recipeRow.id);
}

export async function listRecipes(userId: string): Promise<Recipe[]> {
    const { data, error } = await getSupabase()
        .from("recipes")
        .select("*")
        .eq("user_id", userId)
        .order("name", { ascending: true });

    if (error) throw new Error(`Failed to list recipes: ${error.message}`);
    return (data as Recipe[]) ?? [];
}

export async function getRecipeByName(
    userId: string,
    name: string,
): Promise<RecipeWithIngredients | null> {
    const { data: recipe, error } = await getSupabase()
        .from("recipes")
        .select("*")
        .eq("user_id", userId)
        .eq("name", name)
        .maybeSingle();

    if (error) throw new Error(`Failed to get recipe: ${error.message}`);
    if (!recipe) return null;

    return getRecipeWithIngredients(userId, (recipe as Recipe).id);
}

export async function getRecipeWithIngredients(
    userId: string,
    recipeId: string,
): Promise<RecipeWithIngredients> {
    const sb = getSupabase();
    const { data: recipe, error } = await sb
        .from("recipes")
        .select("*")
        .eq("id", recipeId)
        .eq("user_id", userId)
        .single();

    if (error) throw new Error(`Failed to get recipe: ${error.message}`);

    const { data: ingredients, error: ingErr } = await sb
        .from("recipe_ingredients")
        .select("*")
        .eq("recipe_id", recipeId)
        .order("sort_order", { ascending: true });

    if (ingErr)
        throw new Error(`Failed to get ingredients: ${ingErr.message}`);

    return {
        ...(recipe as Recipe),
        ingredients: (ingredients as RecipeIngredient[]) ?? [],
    };
}

export async function deleteRecipe(
    userId: string,
    name: string,
): Promise<void> {
    const { error } = await getSupabase()
        .from("recipes")
        .delete()
        .eq("user_id", userId)
        .eq("name", name);

    if (error) throw new Error(`Failed to delete recipe: ${error.message}`);
}

// ---------- Cleanup hook for delete_account ----------

export async function deleteAllFavoritesAndRecipes(
    userId: string,
): Promise<void> {
    const sb = getSupabase();

    // recipe_ingredients cascades on recipe deletion, but we still need to
    // clear recipes and favorites explicitly.
    const { error: recipesErr } = await sb
        .from("recipes")
        .delete()
        .eq("user_id", userId);
    if (recipesErr)
        throw new Error(`Failed to delete recipes: ${recipesErr.message}`);

    const { error: favErr } = await sb
        .from("meal_favorites")
        .delete()
        .eq("user_id", userId);
    if (favErr)
        throw new Error(`Failed to delete favorites: ${favErr.message}`);
}
