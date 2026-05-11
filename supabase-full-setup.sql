-- Full Supabase setup for Health Tracker MCP
-- Paste this entire file into Supabase SQL Editor and click "Run"

-- ========== Original tables (from upstream nutrition-mcp) ==========

-- Meals
CREATE TABLE meals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    logged_at timestamptz NOT NULL DEFAULT now(),
    meal_type text CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
    description text NOT NULL,
    calories integer,
    protein_g numeric,
    carbs_g numeric,
    fat_g numeric,
    notes text
);

-- OAuth access tokens
CREATE TABLE oauth_tokens (
    token text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users(id),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- OAuth authorization codes (short-lived, single-use)
CREATE TABLE auth_codes (
    code text PRIMARY KEY,
    redirect_uri text NOT NULL,
    user_id uuid NOT NULL REFERENCES auth.users(id),
    code_challenge text,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens
CREATE TABLE refresh_tokens (
    token text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users(id),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Tool analytics
CREATE TABLE tool_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,
    tool_name VARCHAR(100) NOT NULL,
    success BOOLEAN NOT NULL,
    duration_ms INTEGER NOT NULL,
    error_category VARCHAR(50),
    date_range_days INTEGER,
    mcp_session_id VARCHAR(255),
    invoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tool_analytics_user_id ON tool_analytics(user_id);
CREATE INDEX idx_tool_analytics_tool_name ON tool_analytics(tool_name);
CREATE INDEX idx_tool_analytics_invoked_at ON tool_analytics(invoked_at);
CREATE INDEX idx_tool_analytics_user_tool ON tool_analytics(user_id, tool_name);

-- ========== New tables (weight, steps, profiles) ==========

-- User profiles (one per user)
CREATE TABLE user_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE,
    age integer NOT NULL,
    sex text NOT NULL CHECK (sex IN ('male', 'female')),
    height_cm numeric NOT NULL,
    weight_kg numeric NOT NULL,
    activity_level text NOT NULL CHECK (activity_level IN ('inactive', 'low_active', 'active', 'very_active')),
    timezone text NOT NULL DEFAULT 'America/New_York',
    updated_at timestamptz DEFAULT now()
);

-- Weight tracking entries
CREATE TABLE weight_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    weight_kg numeric NOT NULL,
    logged_at timestamptz DEFAULT now()
);

-- Step tracking entries
CREATE TABLE step_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    step_count integer NOT NULL,
    calories_burned numeric,
    logged_at timestamptz DEFAULT now()
);

CREATE INDEX idx_weight_entries_user_date ON weight_entries (user_id, logged_at);
CREATE INDEX idx_step_entries_user_date ON step_entries (user_id, logged_at);
CREATE INDEX idx_user_profiles_user_id ON user_profiles (user_id);

-- ========== Row Level Security ==========

ALTER TABLE meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE step_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON meals
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON oauth_tokens
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON auth_codes
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON refresh_tokens
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role has full access to tool_analytics" ON tool_analytics
    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON user_profiles
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON weight_entries
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON step_entries
    FOR ALL USING (true) WITH CHECK (true);

-- ========== v2.2.0: Favorites, recipes, Google Health ==========

CREATE TABLE meal_favorites (
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

CREATE INDEX idx_meal_favorites_user_lastused
    ON meal_favorites (user_id, last_used_at DESC NULLS LAST);

CREATE TABLE recipes (
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

CREATE INDEX idx_recipes_user ON recipes (user_id, name);

CREATE TABLE recipe_ingredients (
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

CREATE INDEX idx_recipe_ingredients_recipe
    ON recipe_ingredients (recipe_id, sort_order);

CREATE TABLE google_health_tokens (
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

CREATE TABLE google_health_oauth_states (
    state text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users(id),
    code_verifier text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE google_health_data_points (
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

CREATE INDEX idx_ghealth_dp_user_type_time
    ON google_health_data_points (user_id, data_type, start_time DESC);

CREATE TABLE google_health_sync_state (
    user_id uuid NOT NULL REFERENCES auth.users(id),
    data_type text NOT NULL,
    last_synced_through timestamptz,
    last_attempt_at timestamptz,
    last_error text,
    PRIMARY KEY (user_id, data_type)
);

ALTER TABLE meal_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_health_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_health_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_health_data_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_health_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON meal_favorites
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON recipes
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON recipe_ingredients
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON google_health_tokens
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON google_health_oauth_states
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON google_health_data_points
    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON google_health_sync_state
    FOR ALL USING (true) WITH CHECK (true);
