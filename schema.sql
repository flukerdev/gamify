-- Gamify schema. Run in the Supabase SQL editor.
-- Safe to re-run: drops are commented; uncomment if you want a clean slate.

-- drop table if exists daily_rank_snapshots cascade;
-- drop table if exists test_attempts cascade;
-- drop table if exists quiz_attempts cascade;
-- drop table if exists learn_runs cascade;
-- drop table if exists points_ledger cascade;
-- drop table if exists activity_log cascade;
-- drop table if exists memberships cascade;
-- drop table if exists pairs cascade;
-- drop table if exists games cascade;
-- drop table if exists users cascade;

create extension if not exists "pgcrypto";

-- USERS: one row per phone (normalized). No password / no auth provider yet.
-- onboarded_at: stamped the first time the user completes the welcome tour.
-- Null means the 4-slide tour should still be shown.
create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  phone           text not null unique,         -- normalized digits, US 10-digit form when possible
  first_name      text,
  last_name       text,
  onboarded_at    timestamptz,
  created_at      timestamptz not null default now()
);
alter table users add column if not exists onboarded_at timestamptz;
-- Existing users with a complete profile have already used the app; skip the
-- welcome tour for them. New users (created after this migration) start with
-- null and will see the 4-slide tour exactly once.
update users
   set onboarded_at = created_at
 where onboarded_at is null
   and first_name is not null
   and last_name  is not null;
-- Backfill the unique(phone) constraint on databases that were created from an
-- earlier version of this schema (where it was missing). The API merges
-- duplicates on login, but the constraint stops new ones from being created
-- in race conditions. Run after the dedup query below.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'users'::regclass and contype = 'u'
      and conkey = (
        select array_agg(attnum) from pg_attribute
        where attrelid = 'users'::regclass and attname = 'phone'
      )
  ) then
    alter table users add constraint users_phone_key unique (phone);
  end if;
end $$;

-- GAMES: each Gamify game.
-- direction controls how prompts are shown in Quiz / Test / Learn:
--   'term'       -> always show the term, user recalls the definition
--   'definition' -> always show the definition, user recalls the term
--   'shuffle'    -> per-card random direction (the original Gamify default)
-- Admin can change this at any time; the API regenerates today's quiz/test
-- and rewrites direction on active Learn runs so the change is immediate.
create table if not exists games (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  admin_user_id   uuid not null references users(id) on delete cascade,
  share_code      text not null unique,
  direction       text not null default 'shuffle' check (direction in ('term','definition','shuffle')),
  created_at      timestamptz not null default now()
);
create index if not exists idx_games_admin on games(admin_user_id);

-- Backfill direction column for databases created before 'shuffle' existed.
-- Legacy code ignored the column and behaved as shuffle; treat existing rows
-- the same so user-perceived behavior doesn't change.
alter table games drop constraint if exists games_direction_check;
alter table games alter column direction set default 'shuffle';
update games set direction = 'shuffle' where direction not in ('term','definition','shuffle');
alter table games add constraint games_direction_check
  check (direction in ('term','definition','shuffle'));

-- PAIRS: term/definition pairs that belong to a game.
-- deleted_at: soft-delete marker. Pairs are NEVER hard-deleted because active
-- Learn runs and already-seeded daily quizzes/tests may still reference them.
-- Admin "Edit Pairs" UX hides soft-deleted pairs from new content.
create table if not exists pairs (
  id              uuid primary key default gen_random_uuid(),
  game_id         uuid not null references games(id) on delete cascade,
  term            text not null,
  definition      text not null,
  sort_order      int not null default 0,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now()
);
alter table pairs add column if not exists deleted_at timestamptz;
create index if not exists idx_pairs_game on pairs(game_id);

-- DAILY QUESTION SETS: snapshot of the quiz/test questions for a given day.
-- Lazily created when the first user opens that day's quiz or test. Once
-- created, the set is frozen for the day, so a later admin edit to pair
-- text won't change today's questions.
create table if not exists daily_question_sets (
  game_id     uuid not null references games(id) on delete cascade,
  kind        text not null check (kind in ('quiz', 'test')),
  date_et     date not null,
  questions   jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (game_id, kind, date_et)
);

-- MEMBERSHIPS: which users have joined which games.
create table if not exists memberships (
  user_id         uuid not null references users(id) on delete cascade,
  game_id         uuid not null references games(id) on delete cascade,
  joined_at       timestamptz not null default now(),
  primary key (user_id, game_id)
);
create index if not exists idx_memberships_game on memberships(game_id);

-- POINTS LEDGER: append-only log of every points-earning event.
-- source: 'learn_master' (card mastered slice), 'quiz', 'test'.
create table if not exists points_ledger (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  game_id         uuid not null references games(id) on delete cascade,
  points          numeric(10,4) not null,
  source          text not null,
  ref_id          text,                          -- pair id for learn, attempt id for quiz/test
  earned_at       timestamptz not null default now(),
  earned_date_et  date not null                  -- the US/Eastern calendar date the event counts for
);
create index if not exists idx_ledger_user_game on points_ledger(user_id, game_id);
create index if not exists idx_ledger_game_date on points_ledger(game_id, earned_date_et);

-- LEARN RUNS: one row per (user, game). Stores the current run state (in-progress or last completed).
-- state is jsonb so we don't lock the shape in the DB. Includes:
--   cards: { [pair_id]: { phase, missedInPhase, consecutiveCorrect, mastered, paidOut } }
--   queue: ordered array of pair_ids still to be shown this run
--   sessionHistory: array of last N { correct, total }
--   currentSessionAnswers: number answered this 10-card session
--   currentSessionCorrect: number correct in this 10-card session
--   totalCards: snapshot of card count when run started (admin can add later; new cards join the next run)
--   newPairsSinceStart: array of pair_ids added mid-run, awaiting next run
create table if not exists learn_runs (
  user_id         uuid not null references users(id) on delete cascade,
  game_id         uuid not null references games(id) on delete cascade,
  state           jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  primary key (user_id, game_id)
);

-- QUIZ ATTEMPTS: one per user/game/day. Locked once recorded.
create table if not exists quiz_attempts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  game_id         uuid not null references games(id) on delete cascade,
  date_et         date not null,
  total           int not null,
  correct         int not null,
  answers         jsonb not null,                -- [{pairId, chosen, correct, isCorrect}]
  taken_at        timestamptz not null default now(),
  unique (user_id, game_id, date_et)
);

-- TEST ATTEMPTS: one per user/game/day. Locked once recorded.
create table if not exists test_attempts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  game_id         uuid not null references games(id) on delete cascade,
  date_et         date not null,
  total           int not null,
  correct         int not null,
  answers         jsonb not null,
  taken_at        timestamptz not null default now(),
  unique (user_id, game_id, date_et)
);

-- DAILY RANK SNAPSHOTS: rank captured at the start of each US/Eastern day.
-- Used to compute the daily rank movement indicator on the leaderboard.
create table if not exists daily_rank_snapshots (
  game_id         uuid not null references games(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  date_et         date not null,
  rank            int not null,
  total_points    numeric(10,4) not null,
  primary key (game_id, user_id, date_et)
);
create index if not exists idx_snapshots_game_date on daily_rank_snapshots(game_id, date_et);

-- ACTIVITY LOG: per user/game/day, did the user make ANY progress?
-- Used for the profile calendar and weekly streak.
create table if not exists activity_log (
  user_id         uuid not null references users(id) on delete cascade,
  game_id         uuid not null references games(id) on delete cascade,
  date_et         date not null,
  primary key (user_id, game_id, date_et)
);
create index if not exists idx_activity_user_date on activity_log(user_id, date_et);

-- Helpful view: total points per user per game.
create or replace view v_user_game_totals as
  select user_id, game_id, sum(points)::numeric(10,4) as total_points
  from points_ledger
  group by user_id, game_id;

-- ============================================================================
-- iOS migration (Phase 1 of docs/IOS_MIGRATION_PLAN.md)
-- All additions are additive and idempotent. Existing web rows keep `phone`
-- set; iOS-only rows will have `phone IS NULL` and use one of the new identity
-- columns instead. Postgres treats NULLs as distinct in unique constraints,
-- so multiple iOS-only rows with NULL phone coexist safely.
-- ============================================================================

-- Phone is no longer required: iOS users sign in with Apple / Google / email.
alter table users alter column phone drop not null;

-- New identity columns. The inline `unique` is applied only on first run
-- (when the column doesn't yet exist) — re-runs no-op safely.
alter table users add column if not exists apple_user_id     text unique;
alter table users add column if not exists google_user_id    text unique;
alter table users add column if not exists email             text unique;
alter table users add column if not exists apns_device_token text;
alter table users add column if not exists notification_prefs jsonb
  not null default '{"daily": true, "passed": true, "streak": true}'::jsonb;
alter table users add column if not exists timezone          text;
alter table users add column if not exists deleted_at        timestamptz;
alter table users add column if not exists last_seen_at      timestamptz;

-- Partial indexes for fast lookup by each identity column.
create index if not exists idx_users_email           on users(email)           where email is not null;
create index if not exists idx_users_apple_user_id   on users(apple_user_id)   where apple_user_id is not null;
create index if not exists idx_users_google_user_id  on users(google_user_id)  where google_user_id is not null;
-- Cron handlers iterate over notifiable users by timezone; index scopes to
-- live users with a registered device token.
create index if not exists idx_users_timezone_active on users(timezone)
  where deleted_at is null and apns_device_token is not null;

-- Per-game JSONB { user_id: rank } captured after each leaderboard-changes
-- cron run. Used to detect rank drops and send "X passed you" pushes.
alter table games add column if not exists last_notified_ranks jsonb
  not null default '{}'::jsonb;

-- Per-game JSONB { user_id: iso-timestamp } of the last "X passed you" push we
-- sent each member. Used to throttle: at most one passed-you push per member
-- per game within PASSED_NOTIFY_COOLDOWN_MS (see api/_app.js).
alter table games add column if not exists last_passed_notified jsonb
  not null default '{}'::jsonb;

-- Email magic-code OTPs. We store sha256(code), never plaintext.
-- TTL is enforced in the verify endpoint (10 min) and via the expires_at index
-- for cleanup. attempts caps brute-force guessing.
create table if not exists email_otp_codes (
  email       text not null,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  created_at  timestamptz not null default now(),
  primary key (email)
);
create index if not exists idx_email_otp_expires on email_otp_codes(expires_at);

-- ============================================================================
-- Photo games ("faces") + passcode-protected games.
-- Added for "STS - Know your Names!": a game whose cards are a student's photo
-- (front) and name (back). All additions are additive and idempotent.
-- ============================================================================

-- kind: 'standard' (term/definition text) or 'faces' (photo -> name).
alter table games add column if not exists kind text not null default 'standard';
alter table games drop constraint if exists games_kind_check;
alter table games add constraint games_kind_check check (kind in ('standard', 'faces'));

-- Passcode protection. When staff_code_hash is set the game is "protected":
--   - it cannot be joined by share code or invite link
--   - people sign in with the shared staff passcode + their name
--   - the admin passcode (not a user id) is what grants admin rights
-- Hashes are sha256('gamify-passcode:' || normalized passcode), hex. They are
-- never sent to the client. Bumping code_version signs everyone out.
alter table games add column if not exists staff_code_hash text;
alter table games add column if not exists admin_code_hash text;
alter table games add column if not exists code_version int not null default 1;
create unique index if not exists idx_games_staff_code on games(staff_code_hash) where staff_code_hash is not null;
create unique index if not exists idx_games_admin_code on games(admin_code_hash) where admin_code_hash is not null;

-- Name-based identity for passcode sign-in: '<game id>:<first>|<last>', lowercased.
alter table users add column if not exists login_key text;
create unique index if not exists idx_users_login_key on users(login_key) where login_key is not null;

-- photo_version: null = no photo. Bumped on every photo change so clients can
-- cache photos forever by (pair, version).
alter table pairs add column if not exists photo_version int;

-- One square JPEG per card, base64. Lives in the database (not public storage)
-- so it is only ever served through the API to signed-in members of the game.
create table if not exists pair_photos (
  pair_id     uuid primary key references pairs(id) on delete cascade,
  game_id     uuid not null references games(id) on delete cascade,
  data        text not null,
  updated_at  timestamptz not null default now()
);
create index if not exists idx_pair_photos_game on pair_photos(game_id);

-- Failed passcode attempts, for throttling guesses.
create table if not exists login_attempts (
  id          bigserial primary key,
  ip          text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_login_attempts_ip on login_attempts(ip, created_at);

-- Lock every table down to the service role. The API is the only client and it
-- uses the service-role key (which bypasses RLS), so enabling RLS with no
-- policies means the public anon key can read and write nothing. This matters
-- now that the database holds photos of minors.
-- IMPORTANT: SUPABASE_SERVICE_ROLE_KEY must really be the service-role key.
alter table users                enable row level security;
alter table games                enable row level security;
alter table pairs                enable row level security;
alter table memberships          enable row level security;
alter table points_ledger        enable row level security;
alter table quiz_attempts        enable row level security;
alter table test_attempts        enable row level security;
alter table learn_runs           enable row level security;
alter table daily_question_sets  enable row level security;
alter table daily_rank_snapshots enable row level security;
alter table activity_log         enable row level security;
alter table email_otp_codes      enable row level security;
alter table pair_photos          enable row level security;
alter table login_attempts       enable row level security;
-- Views run as their owner and would bypass RLS, so take the totals view away
-- from the public roles explicitly.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on v_user_game_totals from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on v_user_game_totals from authenticated;
  end if;
end $$;
