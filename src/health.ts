// Pure calculation functions for EER, DRI targets, step calories, and CNF nutrient lookup.
// EER equations and DRI data sourced from Health Canada.

export type Sex = "male" | "female";
export type ActivityLevel = "inactive" | "low_active" | "active" | "very_active";

export interface ProfileData {
    age: number;
    sex: Sex;
    height_cm: number;
    weight_kg: number;
    activity_level: ActivityLevel;
}

// ---------- EER (Estimated Energy Requirements) ----------
// Source: Health Canada — Equations to Estimate Energy Requirement (adults 19+)

const EER_COEFFICIENTS: Record<
    Sex,
    Record<ActivityLevel, { intercept: number; age: number; height: number; weight: number }>
> = {
    male: {
        inactive:    { intercept: 753.07,  age: -10.83, height: 6.50,  weight: 14.10 },
        low_active:  { intercept: 581.47,  age: -10.83, height: 8.30,  weight: 14.94 },
        active:      { intercept: 1004.82, age: -10.83, height: 6.52,  weight: 17.16 },
        very_active: { intercept: -517.88, age: -10.83, height: 15.61, weight: 19.11 },
    },
    female: {
        inactive:    { intercept: 584.90,  age: -7.01, height: 5.72,  weight: 11.71 },
        low_active:  { intercept: 693.35,  age: -7.01, height: 5.01,  weight: 12.55 },
        active:      { intercept: 512.13,  age: -7.01, height: 6.89,  weight: 12.15 },
        very_active: { intercept: -356.85, age: -7.01, height: 11.03, weight: 13.52 },
    },
};

export function calculateEER(profile: ProfileData): number {
    const c = EER_COEFFICIENTS[profile.sex][profile.activity_level];
    const eer =
        c.intercept +
        c.age * profile.age +
        c.height * profile.height_cm +
        c.weight * profile.weight_kg;
    return Math.round(eer);
}

// ---------- Step Calories ----------
// Approximation: ~0.0005 * weight_kg per step (ACE fitness estimate)
// ~35 cal per 1000 steps for a 70kg person

export function calculateStepCalories(steps: number, weightKg: number): number {
    return Math.round(steps * 0.0005 * weightKg);
}

// ---------- DRI Macronutrient Targets ----------
// Source: Health Canada — Dietary Reference Intakes, Macronutrients
// Simplified for adults. Returns absolute gram targets based on EER.

interface DRITargets {
    calories_kcal: number;
    protein_g: { min: number; max: number; rda: number };
    carbs_g: { min: number; max: number; rda: number };
    fat_g: { min: number; max: number };
    fibre_g: number;
    water_l: number;
}

// AMDR percentages (adults 19+)
const AMDR = {
    protein: { min: 0.10, max: 0.35 },
    carbs: { min: 0.45, max: 0.65 },
    fat: { min: 0.20, max: 0.35 },
};

// RDA for protein: 0.8 g/kg/day (adults)
const PROTEIN_RDA_PER_KG = 0.8;

// Fibre AI (g/day) and Water AI (L/day) by sex and age group
const FIBRE_AI: Record<Sex, Record<string, number>> = {
    male:   { "19-30": 38, "31-50": 38, "51-70": 30, "70+": 30 },
    female: { "19-30": 25, "31-50": 25, "51-70": 21, "70+": 21 },
};

const WATER_AI: Record<Sex, Record<string, number>> = {
    male:   { "19-30": 3.7, "31-50": 3.7, "51-70": 3.7, "70+": 3.7 },
    female: { "19-30": 2.7, "31-50": 2.7, "51-70": 2.7, "70+": 2.7 },
};

function getAgeGroup(age: number): string {
    if (age <= 30) return "19-30";
    if (age <= 50) return "31-50";
    if (age <= 70) return "51-70";
    return "70+";
}

export function getDRITargets(profile: ProfileData): DRITargets {
    const eer = calculateEER(profile);
    const ageGroup = getAgeGroup(profile.age);

    // Convert AMDR percentages to grams (protein/carbs = 4 cal/g, fat = 9 cal/g)
    const proteinMin = Math.round((eer * AMDR.protein.min) / 4);
    const proteinMax = Math.round((eer * AMDR.protein.max) / 4);
    const proteinRDA = Math.round(profile.weight_kg * PROTEIN_RDA_PER_KG);

    const carbsMin = Math.round((eer * AMDR.carbs.min) / 4);
    const carbsMax = Math.round((eer * AMDR.carbs.max) / 4);
    const carbsRDA = 130; // Health Canada RDA for carbs (adults)

    const fatMin = Math.round((eer * AMDR.fat.min) / 9);
    const fatMax = Math.round((eer * AMDR.fat.max) / 9);

    return {
        calories_kcal: eer,
        protein_g: { min: proteinMin, max: proteinMax, rda: proteinRDA },
        carbs_g: { min: carbsMin, max: carbsMax, rda: carbsRDA },
        fat_g: { min: fatMin, max: fatMax },
        fibre_g: FIBRE_AI[profile.sex][ageGroup] ?? 30,
        water_l: WATER_AI[profile.sex][ageGroup] ?? 3.0,
    };
}

// ---------- CNF Nutrient Lookup ----------
// Canada's Canadian Nutrient File — public API, no key needed

const CNF_BASE = "https://food-nutrition.canada.ca/api/canadian-nutrient-file";

// Core macronutrient IDs from CNF
const MACRO_NUTRIENT_IDS: Record<number, string> = {
    208: "Energy (kcal)",
    203: "Protein (g)",
    204: "Fat (g)",
    205: "Carbohydrate (g)",
    291: "Fibre (g)",
    269: "Sugars (g)",
    606: "Saturated Fat (g)",
    307: "Sodium (mg)",
};

interface CNFFood {
    food_code: number;
    food_description: string;
}

interface CNFNutrient {
    nutrient_name_id: number;
    nutrient_value: number;
    nutrient_name: string;
    unit: string;
}

export interface NutrientResult {
    food_code: number;
    food_description: string;
    nutrients: { name: string; value: number; unit: string }[];
}

export async function lookupNutrient(query: string): Promise<NutrientResult[]> {
    // Fetch all foods and search locally (API has no search endpoint)
    const res = await fetch(`${CNF_BASE}/food/?lang=en`);
    if (!res.ok) throw new Error(`CNF API error: ${res.status}`);
    const foods = (await res.json()) as CNFFood[];

    // Tiered matching: exact substring first, then token matching
    const q = query.toLowerCase();
    const tokens = q.split(/\s+/);

    let matches = foods.filter((f) =>
        f.food_description.toLowerCase().includes(q),
    );

    if (matches.length === 0) {
        matches = foods.filter((f) => {
            const desc = f.food_description.toLowerCase();
            return tokens.every((t) => desc.includes(t));
        });
    }

    if (matches.length === 0) {
        matches = foods
            .filter((f) => {
                const desc = f.food_description.toLowerCase();
                return tokens.some((t) => desc.includes(t));
            })
            .slice(0, 10);
    }

    // Limit to top 5 matches
    const top = matches.slice(0, 5);

    // Fetch nutrient data for each match
    const results: NutrientResult[] = [];
    for (const food of top) {
        const nRes = await fetch(
            `${CNF_BASE}/nutrientamount/?id=${food.food_code}&lang=en`,
        );
        if (!nRes.ok) continue;
        const allNutrients = (await nRes.json()) as CNFNutrient[];

        const macros = allNutrients
            .filter((n) => n.nutrient_name_id in MACRO_NUTRIENT_IDS)
            .map((n) => ({
                name: MACRO_NUTRIENT_IDS[n.nutrient_name_id] as string,
                value: n.nutrient_value,
                unit: n.unit || "g",
            }));

        results.push({
            food_code: food.food_code,
            food_description: food.food_description,
            nutrients: macros,
        });
    }

    return results;
}
