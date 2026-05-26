-- v5.2.5: dedicated Fitbit/Google-Health steps table.
-- Run this in the Supabase SQL editor against the same database the server
-- uses. The MCP keeps writing to google_health_data_points as well — this
-- table is a denormalized mirror for queries that want a clean steps series.

CREATE TABLE IF NOT EXISTS fitbit_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    point_id text NOT NULL,
    start_time timestamptz NOT NULL,
    end_time timestamptz,
    step_count integer NOT NULL,
    source jsonb,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, point_id)
);

CREATE INDEX IF NOT EXISTS idx_fitbit_steps_user_time
    ON fitbit_steps (user_id, start_time DESC);

ALTER TABLE fitbit_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON fitbit_steps
    FOR ALL USING (true) WITH CHECK (true);
