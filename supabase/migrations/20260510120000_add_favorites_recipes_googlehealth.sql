-- v2.2.0: Adds three feature areas.
--
-- 1. meal_favorites — quick re-log of frequently eaten meals
-- 2. recipes + recipe_ingredients — composed meals with per-serving macros
-- 3. google_health_* — OAuth tokens, raw data points, and sync state for the
--    Google Health API (Fitbit Air / Google Health app data ingestion)

-- ========== Favorites ==========

CREATE TABLE IF NOT EXISTS meal_favorites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    name text NOT NULL,
    description text NOT NULL,
    default_meal_type text CHECK (default_meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
    calories integer,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    notes text,
    use_count integer NOT NULL DEFAULT 0,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_meal_favorites_user_lastused
    ON meal_favorites (user_id, last_used_at DESC NULLS LAST);

ALTER TABLE meal_favorites ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "Allow all for service role" ON meal_favorites
        FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ========== Recipes ==========

CREATE TABLE IF NOT EXISTS recipes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    name text NOT NULL,
    description text,
    servings numeric NOT NULL DEFAULT 1 CHECK (servings > 0),
    calories_per_serving integer,
    protein_g_per_serving numeric,
    carbs_g_per_serving numeric,
    fat_g_per_serving numeric,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_recipes_user ON recipes (user_id, name);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    name text NOT NULL,
    amount text,
    calories integer,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    sort_order integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe
    ON recipe_ingredients (recipe_id, sort_order);

ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "Allow all for service role" ON recipes
        FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "Allow all for service role" ON recipe_ingredients
        FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ========== Google Health API ==========

-- OAuth credentials. Refresh tokens currently stored as plaintext, protected by
-- service-role-only access. If we ever expose the DB beyond service role, wrap
-- these in pgcrypto.
CREATE TABLE IF NOT EXISTS google_health_tokens (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id),
    access_token text NOT NULL,
    refresh_token text,
    expires_at timestamptz NOT NULL,
    scopes text[] NOT NULL DEFAULT '{}',
    google_user_id text,
    legacy_fitbit_user_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Short-lived OAuth state tokens (CSRF protection during /authorize handshake)
CREATE TABLE IF NOT EXISTS google_health_oauth_states (
    state text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users(id),
    code_verifier text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Generic data point storage. We use one row per data point and store the
-- raw payload in `value` so we can support all 30+ Google Health data types
-- without a table per type.
CREATE TABLE IF NOT EXISTS google_health_data_points (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    data_type text NOT NULL,
    point_id text NOT NULL,
    start_time timestamptz NOT NULL,
    end_time timestamptz,
    value jsonb NOT NULL,
    source jsonb,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, data_type, point_id)
);

CREATE INDEX IF NOT EXISTS idx_ghealth_dp_user_type_time
    ON google_health_data_points (user_id, data_type, start_time DESC);

-- Per-data-type sync cursor + last-error tracking
CREATE TABLE IF NOT EXISTS google_health_sync_state (
    user_id uuid NOT NULL REFERENCES auth.users(id),
    data_type text NOT NULL,
    last_synced_through timestamptz,
    last_attempt_at timestamptz,
    last_error text,
    PRIMARY KEY (user_id, data_type)
);

ALTER TABLE google_health_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_health_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_health_data_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_health_sync_state ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "Allow all for service role" ON google_health_tokens
        FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "Allow all for service role" ON google_health_oauth_states
        FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "Allow all for service role" ON google_health_data_points
        FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "Allow all for service role" ON google_health_sync_state
        FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
