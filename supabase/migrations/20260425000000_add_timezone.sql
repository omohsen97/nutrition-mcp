-- Adds per-user timezone preference (IANA name, e.g. "America/New_York").
-- Used for "today", date-range queries, and timestamp formatting.

ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/New_York';
