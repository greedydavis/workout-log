-- 訓練紀錄 App — Supabase schema
-- 在 Supabase 專案的 SQL Editor 貼上整份執行一次即可。

create extension if not exists pgcrypto;

-- 動作（依部位分類）
create table public.exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  category text not null default 'other' check (category in ('push','pull','legs','core','other')),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

-- 單組紀錄（重量／次數／RPE）
create table public.sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  exercise_id uuid not null references public.exercises(id) on delete cascade,
  date date not null,
  position int not null default 0,
  weight numeric,
  reps int,
  rpe numeric,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 體組成數據（體重／體脂率／骨骼肌重）
create table public.body_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  weight numeric,
  body_fat numeric,
  muscle_mass numeric,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

-- 飲食紀錄（自由文字，沿用 v0）
create table public.food_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  text text not null default '',
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);

-- 釘選的核心動作（記錄頁快速入口用）
create table public.pinned_exercises (
  user_id uuid not null references auth.users(id) on delete cascade,
  exercise_id uuid not null references public.exercises(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, exercise_id)
);

create index sets_user_ex_date_idx on public.sets (user_id, exercise_id, date);
create index sets_user_date_idx on public.sets (user_id, date);
create index body_metrics_user_date_idx on public.body_metrics (user_id, date);

-- Row Level Security：每個人只能讀寫自己的資料
alter table public.exercises enable row level security;
alter table public.sets enable row level security;
alter table public.body_metrics enable row level security;
alter table public.food_logs enable row level security;
alter table public.pinned_exercises enable row level security;

create policy "own rows" on public.exercises
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.sets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.body_metrics
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.food_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows" on public.pinned_exercises
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
