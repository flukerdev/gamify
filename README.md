# Gamify

A competitive learning platform. An admin creates a "game" with term/definition pairs; participants join via a 6-character share code and compete on a live leaderboard by earning points through a Quizlet-style **Learn** mode, daily **Quizzes**, and daily **Tests**. First use case: memorizing Bible verses with family and friends.

**This deployment is branded "STS - Know your Names!"** It hosts a *photo game*: each card is a student's photo (front) and name (back), so ministry staff can learn every student's name. See [Photo games](#photo-games-sts---know-your-names) below.

- **Frontend:** React + Vite
- **Backend:** Express, deployed as a Vercel serverless function
- **Database:** Supabase (Postgres) — used for data only; no Supabase Auth. RLS is ENABLED on every table with no policies, so only the service-role key (the API) can read or write.
- **Auth:** signed session tokens. Photo games sign in by invite link + your name; classic games keep phone-number sign-in at `/?legacy=1`.

## Photo games (STS - Know your Names!)

- `games.kind = 'faces'`. The name is `pairs.definition`; `pairs.term` is the placeholder `(photo)`; direction is always `term` (show the photo, recall the name), so Learn / Quiz / Test run unchanged.
- **Photos are private.** Each is a 512px JPEG stored base64 in `pair_photos` and served only by `GET /api/games/:id/photos/:pairId` to signed-in members. They are never in the repo (which is public) and never in public storage.
- **Entry is by link, not by typing a passcode.** A photo game is *protected* (`staff_code_hash` set). The staff invite link is `/?k=<games.share_code>`; opening it asks only for your name, once (`POST /api/auth/passcode`). The name is the identity (same name on a new phone = same person). After sign-in the address becomes `/?k=<code>&n=<name>`, so an iPhone home-screen icon made from it signs in with no typing (there is deliberately no web manifest, so "Add to Home Screen" uses the current address). A separate **admin link** (`/?k=<admin code>`, stored only as a hash) also opens the Manage screen. Anyone holding a link can get in; "Make new links" in Manage replaces both codes, bumps `code_version` and signs every device out. Bad codes are throttled per IP.
- **Tabs:** Flashcards (tap to flip, unscored), Learn, Daily Quiz, Daily Test, Leaderboard, My Progress, Invite (the staff link, with Copy and Share).
- **Manage** (admin passcode only, in the menu): add a student (choose photo, drag / pinch / slider to crop, type the name), edit or re-crop, remove (deletes the photo for good), remove a person from the leaderboard, copy the staff link or make new links.
- **Seeding:** `node scripts/seed-faces.mjs <dir>` creates the game and loads a folder of face crops (see the header of that file). Keep the folder outside the repo.
- **Install:** PNG touch icon plus Apple web-app meta tags; staff add it to their home screen from Safari (Share, Add to Home Screen) or Chrome (menu, Add to Home screen).

---

## 1. Run it locally

### Prerequisites
- Node 18+
- A free Supabase project (https://supabase.com)

### Steps
1. **Install deps**
   ```bash
   npm install
   ```

2. **Create your Supabase project**
   - In Supabase, open **SQL editor**.
   - Paste the contents of `schema.sql` and run.
   - Paste the contents of `seed.sql` and run (creates a sample Bible-verse game with share code `BIBLE1`).
   - **Upgrading an existing DB from an older schema?** Just re-run `schema.sql`. It's idempotent — every `CREATE TABLE` uses `IF NOT EXISTS`, missing columns are added via `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, and the `users.phone` unique constraint is backfilled by a guarded `DO` block. Drift is what caused the "cards disappear after creating a game" class of bug; see Troubleshooting §6.
   - **RLS stays ENABLED on every table** (`schema.sql` turns it on, with no policies). The API uses the service-role key, which bypasses RLS, and no client ever talks to Supabase directly, so the public anon key can read nothing. If writes fail with a row-count error, `SUPABASE_SERVICE_ROLE_KEY` is the anon key by mistake.

3. **Configure env vars**
   ```bash
   cp .env.example .env
   ```
   Fill in:
   - `SUPABASE_URL` — from Supabase **Settings → API → Project URL**
   - `SUPABASE_SERVICE_ROLE_KEY` — from Supabase **Settings → API → service_role** (server-only; never expose to the browser)

4. **Start dev (frontend + API in parallel)**
   ```bash
   npm run dev
   ```
   - Frontend: http://localhost:5173
   - API: http://localhost:3001 (Vite proxies `/api/*` to it)

5. **Try it**
   - Sign in with any phone number (e.g. `4045551234`). First-time users are prompted for first/last name.
   - On the hub, click **Join with code** and enter `BIBLE1` to drop into the sample game.
   - Or click **+ Create new Gamify** to make your own.

---

## 2. Deploy to Vercel

1. Push this repo to GitHub.
2. In Vercel: **New Project → Import** the repo. Framework preset: **Other** (Vercel auto-detects Vite).
3. **Environment Variables** (Project Settings → Environment Variables):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Deploy. Vercel runs `vite build` and serves:
   - `dist/` as the static site
   - `api/index.js` as a serverless function (Express) — `vercel.json` rewrites `/api/*` to it and all other paths to `index.html` for client routing.

That's it. No build server, no extra config.

---

## 3. Files and where things live

```
api/
  _app.js            Express app. All routes. Imported by both Vercel and local server.
  index.js           Vercel function entry. Re-exports _app.js; vercel.json rewrites /api/* to /api.
  _lib/
    supabase.js      Service-role Supabase client (server-only).
    util.js          phone normalize, share-code gen, seeded RNG, ET-date helper,
                     expectRead / expectWrite (throw on Supabase errors / row-count
                     mismatch so schema drift and RLS misconfig fail loudly).
    config.js        Server-side constants (mirror of src/config.js).
src/
  config.js          SINGLE SOURCE OF TRUTH for tunable constants. Edit here.
  main.jsx           React entry.
  App.jsx            Routes between login → profile completion → hub → game shell.
  api.js             Tiny fetch wrapper. Sends the signed session token (X-Session).
  auth.js            localStorage-backed session.
  utils/
    phone.js         normalize / validate / format
    similarity.js    Levenshtein + "close enough" check for type-it-out
    seededRandom.js  deterministic RNG (matches server)
    easternTime.js   ET-date strings, month grid, weekly streak counter
    tiers.js         points -> tier name
  components/
    LoginScreen, CompleteProfile, GameHub, CreateGame, JoinGame, InviteJoin
    GameShell, Monogram, EditPairs, InviteFriends
    ProfileTab, LeaderboardTab, TierIcon
    QuizzesTab, TestsTab, QuizOrTest
    LearnTab, SessionChart
  styles.css         All styling. B&W minimalist, mobile-first.
schema.sql           Run in Supabase SQL editor.
seed.sql             Sample Bible-verse game.
vercel.json          Rewrites + function config.
vite.config.js       Vite + dev proxy to local Express.
server-local.js      Local-only port binding for the Express app.
```

---

## 4. How the major features work

### Auth
- Every API call carries a signed session token (`X-Session`, see `api/_lib/session.js`); a bare user id is never trusted. All `/api/games/:id/*` routes pass one guard that checks membership and, for protected games, that the session was issued for that game under its current passcodes.
- Classic games: login is by phone number only (reachable at `/?legacy=1`). Numbers are normalized (`(404) 555-1234`, `404-555-1234`, `+1 404 555 1234`, and `4045551234` all collapse to `4045551234`).
- If the normalized phone exists, the user logs in **and their saved name comes back with them** — they don't re-enter it. Otherwise a new row is created, and the user is asked for first/last name.
- The DB enforces `unique(phone)` so a single phone always resolves to a single user. As a belt-and-suspenders measure for any DB that's missing the constraint, `POST /api/auth/login` picks the canonical row (prefers one with a complete profile, then the oldest) and merges any duplicates' memberships / points / activity into it before deleting them — see `mergeUserInto` in `api/_app.js`.
- The session (user + token) is persisted in `localStorage`. To swap in real SMS verification later, replace `POST /api/auth/login`.

### Daily Quizzes & Tests
- 5-question quiz; 20-question test. One attempt per user per day per game (locked once taken).
- The question set is **frozen per day**: the first user to open today's quiz/test triggers a server-side build (seeded by `kind + gameId + ET-date`), and the result is stored in `daily_question_sets` so that mid-day pair edits don't change what's already been answered. No cron job — the row is created lazily.
- If the game has fewer than 5 / 20 pairs, the corresponding feature shows a clean "Not enough content yet" state.
- Day boundaries everywhere are **US Eastern**.

### Learn engine (highest-priority correctness)
Each card has a progression state per run:
- `phase`: `'mc'` or `'tio'`
- `missedInPhase`: have they missed this card in the current phase?
- `consecutiveCorrect`: streak in this phase
- `mastered`, `paidOut`: terminal flags

Rules implemented exactly per spec:
- MC correct on first try → graduates to TIO.
- MC missed → must get correct **twice in a row** to graduate.
- TIO correct on first try → Mastered.
- TIO missed → must get correct **twice in a row** to be Mastered.

Sessions are 10 cards. After answering, the card (if not mastered) is re-appended to the queue with its updated phase/state. The post-session screen shows X/10 correct, a smoothed bar chart over the last 5 sessions, an estimated-minutes-remaining stat, and the Mastered / Learning / To Be Learned buckets.

**Scoring:** a fully completed run is worth exactly **50 points**, split evenly across all cards. Each card pays `50 / total` when it Masters. Exiting mid-run banks only the cards that have already Mastered; resuming pays the remaining slices so the run still totals exactly 50.

**Reset on completion:** when all cards Master, the run state is cleared and a new run can begin. Unlimited runs per day. 10 completed runs = 500 points.

**Type-it-out leniency:** lowercased, punctuation/whitespace stripped, then compared with normalized Levenshtein. Threshold lives in `src/config.js` (`SIMILARITY_THRESHOLD = 0.9`). After grading:
- Marked incorrect → show user's answer in red, correct answer in green, one button "I was actually correct".
- Marked correct but not exact match → show in green, one button "I was actually incorrect".
- Exact match → green only, no override button.

### Leaderboard
- Live polling every 5 seconds.
- Ranks 1/2/3 use grayscale medal SVGs (single-color theme); ranks 4+ show the numeric rank.
- Daily delta vs the snapshot taken at first leaderboard access each ET day (lazy snapshot — no cron required).

### Profile
- Name, tier, total points.
- Monthly calendar: a square per day, filled solid green (with a white number) if the user made any progress that day (quiz, test, or any Learn answer).
- Weekly streak: shown two ways — a large numeric count of consecutive Sun–Sat ET weeks with at least one active day, and a vertical rail to the right of the calendar that puts a green dot next to every active week and a connecting green bar between consecutive active weeks. Inactive weeks show nothing on the rail. The rail is centered between the calendar's right edge and the card's right padding.

### Game creation
- Title + 5 blank rows on the content page, with `+ Add 5 more` and per-row delete. A "Paste from a spreadsheet" textarea ingests tab-separated `term<TAB>definition` lines in one shot — malformed lines are added but visually flagged so the user can fix them before saving.
- Prompt direction is no longer a per-game setting: each card in Learn / Quiz / Test is randomly presented term-first or definition-first. The `games.direction` column is preserved for backward compatibility and is always written as `'term'`.
- Logo is an auto-generated monogram (first letter of the title in a black circle).
- The admin can **edit** existing pairs and **soft-delete** them via the "Edit Pairs" modal (sidebar). Edits and deletes only affect FUTURE Learn runs and FUTURE days — active Learn runs use the term/definition text snapshotted at run start, and today's quiz/test is frozen in `daily_question_sets`. Newly added pairs join everyone's "To Be Learned" set the next run.

---

## 5. Tuning constants

All tunable values are in `src/config.js`:

```js
QUIZ_LENGTH, QUIZ_MAX_POINTS   // 5, 5
TEST_LENGTH, TEST_MAX_POINTS   // 20, 20
LEARN_RUN_POINTS               // 50
TIER_THRESHOLDS                // [100, 200, 350, 600] — four cut points → five tiers
TIERS                          // Master, Veteran, Elite, Professional, Rookie (top-to-bottom)
CARDS_PER_SESSION              // 10
MC_OPTION_COUNT                // 4
EST_SECONDS_PER_MC             // 10
EST_SECONDS_PER_TIO            // 30
RECENT_SESSIONS_CHART_COUNT    // 5
SIMILARITY_THRESHOLD           // 0.9
SHARE_CODE_LENGTH              // 6
APP_TIMEZONE                   // 'America/New_York'
```

The server has a mirror of these constants in `api/_lib/config.js` — keep the two in sync if you change values.

---

## 6. Troubleshooting

- **"Server is missing SUPABASE_URL …"** — `.env` not loaded. Make sure you ran `cp .env.example .env` and filled it in, and that you started the dev server with `npm run dev` (which loads `.env` via dotenv).
- **"Not in this game"** when opening a game — the share code is wrong, or the user hasn't joined. Use the join screen to enter the code.
- **Quiz says "Not enough content yet"** — the game needs at least 5 pairs (or 20 for a test). The admin can use **Edit Pairs** in the sidebar.
- **Calendar/streak looks off** — day boundaries are US Eastern. A late-night activity counts toward the ET date it occurred on.
- **A game shows 0 cards even though you added some / Edit Pairs is empty / Quiz says "Have 0 of 20"** — schema drift. The deployed DB is missing a column or table that the API queries. Almost always one of:
  - `pairs.deleted_at` doesn't exist (every pair-read filters `is('deleted_at', null)`).
  - `daily_question_sets` table doesn't exist (today's quiz/test can't be frozen).

  Fix: re-run `schema.sql` in the Supabase SQL editor. It's idempotent and will backfill anything missing. If you want to confirm before re-running, this query shows what's there:
  ```sql
  SELECT column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name='pairs' AND column_name='deleted_at';
  SELECT table_name FROM information_schema.tables
   WHERE table_schema='public' AND table_name='daily_question_sets';
  ```
  After the bug fix above, the API now wraps every pair-read in `expectRead()` (see `api/_lib/util.js`), so any future schema-mismatch read error will throw a real error in the server log and the UI instead of silently rendering an empty list.
- **Writes appear to succeed but no rows appear in the DB** — your `SUPABASE_SERVICE_ROLE_KEY` env var is set to the **anon** key, not the **service-role** key. With RLS enabled and no policies (Supabase's default for new tables), the anon key silently produces 0 rows on insert/update. Decode the JWT body at jwt.io: it must show `"role":"service_role"`. The right service-role key lives in Supabase **Project Settings → API → service_role** (red "secret" badge). The other guardrail is to disable RLS on every table per the setup instructions in §1 — the API is the only client and uses the service-role key.
- **User keeps getting re-prompted for first/last name after signing in with the same phone** — the DB is missing the `unique(phone)` constraint on `users`, so duplicates accumulated and login was returning a different row each time. Re-running `schema.sql` will add the constraint (the script's guarded `DO` block handles the existing-data case). The login endpoint also merges duplicates on the fly, so the next sign-in will heal the data automatically.
