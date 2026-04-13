-- Migration: Add user profiles, weight entries, and step entries tables
-- Run this in your Supabase SQL editor

-- User profiles (one per user)
create table if not exists user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  age integer not null,
  sex text not null check (sex in ('male', 'female')),
  height_cm numeric not null,
  weight_kg numeric not null,
  activity_level text not null check (activity_level in ('inactive', 'low_active', 'active', 'very_active')),
  updated_at timestamptz default now()
);

-- Weight tracking entries
create table if not exists weight_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  weight_kg numeric not null,
  logged_at timestamptz default now()
);

-- Step tracking entries
create table if not exists step_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  step_count integer not null,
  calories_burned numeric,
  logged_at timestamptz default now()
);

-- Indexes for common queries
create index if not exists idx_weight_entries_user_date on weight_entries (user_id, logged_at);
create index if not exists idx_step_entries_user_date on step_entries (user_id, logged_at);
create index if not exists idx_user_profiles_user_id on user_profiles (user_id);
