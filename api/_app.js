// Gamify API — single Express app exported as a Vercel serverless function.
// Local dev: imported by server-local.js and bound to a port.

import express from 'express';
import cors from 'cors';
import { OAuth2Client } from 'google-auth-library';
import { supabase, assertEnv } from './_lib/supabase.js';
import { normalizePhone, easternDateString, easternWeekRange, genShareCode, seededRng, shuffleWith, sendError, expectWrite, expectRead } from './_lib/util.js';
import { verifyAppleIdentityToken } from './_lib/appleAuth.js';
import { sendPush } from './_lib/apns.js';
import {
  QUIZ_LENGTH, QUIZ_MAX_POINTS, TEST_LENGTH, TEST_MAX_POINTS,
  LEARN_RUN_POINTS, CARDS_PER_SESSION, MC_OPTION_COUNT,
} from './_lib/config.js';

// google-auth-library only needs the iOS client ID at verify-time, so a
// zero-config client is fine here.
const googleAuthClient = new OAuth2Client();

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------------------
// "Auth": the client sends the current user's id as a header. Per spec, MVP
// has no password / no SMS verification. We still verify the user exists.
// ---------------------------------------------------------------------------
async function requireUser(req) {
  const userId = req.header('x-user-id');
  if (!userId) {
    const e = new Error('Not authenticated'); e.status = 401; throw e;
  }
  const { data, error } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  if (!data) { const e = new Error('User not found'); e.status = 401; throw e; }
  return data;
}

// ===========================================================================
// AUTH
// ===========================================================================

// When the deployed DB is missing the `unique(phone)` constraint declared in
// schema.sql, duplicate rows for the same phone can accumulate (one from
// /auth/login that created a stub before CompleteProfile, another from
// /auth/invite-join falling through .maybeSingle(), etc). Returning a
// different row each login is what caused users to be re-prompted for their
// name and to re-join games as a "new" account. The helpers below find the
// canonical row (prefer a complete profile, then the oldest) and fold every
// duplicate's memberships/points/activity into it before deleting the dupe,
// so a single phone always resolves to a single user.

function pickCanonicalUser(matches) {
  const complete = matches.filter(m => m.first_name && m.last_name);
  const pool = complete.length ? complete : matches;
  return pool.slice().sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  )[0];
}

// Move every child row from fromId to toId, then delete fromId. For tables
// whose unique key includes user_id we insert-then-delete and swallow 23505
// (unique violation) so canonical's existing row wins on conflict.
async function mergeUserInto(fromId, toId) {
  // memberships: pk (user_id, game_id)
  const { data: mems } = await supabase.from('memberships')
    .select('game_id, joined_at').eq('user_id', fromId);
  for (const m of mems || []) {
    const { error } = await supabase.from('memberships')
      .insert({ user_id: toId, game_id: m.game_id, joined_at: m.joined_at });
    if (error && error.code !== '23505') throw error;
  }
  await supabase.from('memberships').delete().eq('user_id', fromId);

  // activity_log: pk (user_id, game_id, date_et)
  const { data: acts } = await supabase.from('activity_log')
    .select('game_id, date_et').eq('user_id', fromId);
  for (const a of acts || []) {
    const { error } = await supabase.from('activity_log')
      .insert({ user_id: toId, game_id: a.game_id, date_et: a.date_et });
    if (error && error.code !== '23505') throw error;
  }
  await supabase.from('activity_log').delete().eq('user_id', fromId);

  // quiz_attempts: unique (user_id, game_id, date_et)
  const { data: quizzes } = await supabase.from('quiz_attempts')
    .select('*').eq('user_id', fromId);
  for (const q of quizzes || []) {
    const { error } = await supabase.from('quiz_attempts').insert({
      user_id: toId, game_id: q.game_id, date_et: q.date_et,
      total: q.total, correct: q.correct, answers: q.answers, taken_at: q.taken_at,
    });
    if (error && error.code !== '23505') throw error;
  }
  await supabase.from('quiz_attempts').delete().eq('user_id', fromId);

  // test_attempts: same shape as quiz_attempts
  const { data: tests } = await supabase.from('test_attempts')
    .select('*').eq('user_id', fromId);
  for (const t of tests || []) {
    const { error } = await supabase.from('test_attempts').insert({
      user_id: toId, game_id: t.game_id, date_et: t.date_et,
      total: t.total, correct: t.correct, answers: t.answers, taken_at: t.taken_at,
    });
    if (error && error.code !== '23505') throw error;
  }
  await supabase.from('test_attempts').delete().eq('user_id', fromId);

  // learn_runs: pk (user_id, game_id) — canonical's run wins if both exist.
  const { data: runs } = await supabase.from('learn_runs')
    .select('*').eq('user_id', fromId);
  for (const r of runs || []) {
    const { error } = await supabase.from('learn_runs').insert({
      user_id: toId, game_id: r.game_id, state: r.state, updated_at: r.updated_at,
    });
    if (error && error.code !== '23505') throw error;
  }
  await supabase.from('learn_runs').delete().eq('user_id', fromId);

  // daily_rank_snapshots: pk (game_id, user_id, date_et)
  const { data: snaps } = await supabase.from('daily_rank_snapshots')
    .select('*').eq('user_id', fromId);
  for (const s of snaps || []) {
    const { error } = await supabase.from('daily_rank_snapshots').insert({
      game_id: s.game_id, user_id: toId, date_et: s.date_et,
      rank: s.rank, total_points: s.total_points,
    });
    if (error && error.code !== '23505') throw error;
  }
  await supabase.from('daily_rank_snapshots').delete().eq('user_id', fromId);

  // points_ledger: id is pk, just reassign user_id (no conflict possible).
  await supabase.from('points_ledger')
    .update({ user_id: toId }).eq('user_id', fromId);

  // games: dup may have created some as admin.
  await supabase.from('games')
    .update({ admin_user_id: toId }).eq('admin_user_id', fromId);

  // Finally the row itself.
  await supabase.from('users').delete().eq('id', fromId);
}

// Resolve a phone to a single canonical user, merging duplicates if any.
// firstName/lastName are only written when the canonical row is brand-new or
// is missing those fields — we never overwrite a returning user's name.
async function findOrCreateUserByPhone({ phone, firstName, lastName }) {
  const { data: matches, error: selErr } = await supabase
    .from('users').select('*').eq('phone', phone);
  if (selErr) throw selErr;

  if (!matches || matches.length === 0) {
    const row = { phone };
    if (firstName) row.first_name = firstName;
    if (lastName)  row.last_name  = lastName;
    const [created] = await expectWrite(
      `create user for phone ${phone}`,
      1,
      supabase.from('users').insert(row).select('*'),
    );
    return { user: created, isNew: true };
  }

  const canonical = pickCanonicalUser(matches);
  const dups = matches.filter(m => m.id !== canonical.id);
  if (dups.length) {
    console.warn('[gamify api] merging duplicate users for phone', phone,
      'canonical:', canonical.id, 'merging:', dups.map(d => d.id),
      '— add `unique(phone)` to the users table to prevent recurrence.');
    for (const d of dups) await mergeUserInto(d.id, canonical.id);
  }

  let user = canonical;
  const wantFirst = !user.first_name && firstName;
  const wantLast  = !user.last_name  && lastName;
  if (wantFirst || wantLast) {
    const { data: updated } = await supabase.from('users').update({
      first_name: user.first_name || firstName || null,
      last_name:  user.last_name  || lastName  || null,
    }).eq('id', user.id).select('*').single();
    if (updated) user = updated;
  }
  return { user, isNew: false };
}

// iOS analogue of findOrCreateUserByPhone. The caller verifies the OAuth
// token (Apple JWT or Google ID token) and passes the resulting identifiers.
// At least one of appleUserId / googleUserId / email must be present.
//
// Resolution rules (mirror of the phone version):
//   0 matches  -> insert a fresh row with the provided fields.
//   1 match    -> backfill missing identifier and name columns onto it.
//   2+ matches -> the same human signed in via two providers and ended up on
//                 different rows (e.g. Google first with their real email,
//                 then Apple with a private-relay email that later got tied
//                 back). Pick a canonical row, capture identifier columns
//                 from the dupes, merge child rows via mergeUserInto (which
//                 also deletes the dupes — that frees the unique values),
//                 THEN write the captured identifiers onto canonical so they
//                 don't get lost.
async function findOrCreateUserByIdentity({ appleUserId, googleUserId, email, firstName, lastName }) {
  // Look up by every provided identifier and de-dup the result set.
  const seen = new Set();
  const matches = [];
  async function gather(column, value) {
    if (!value) return;
    const { data, error } = await supabase.from('users').select('*').eq(column, value);
    if (error) throw error;
    for (const u of data || []) {
      if (!seen.has(u.id)) { seen.add(u.id); matches.push(u); }
    }
  }
  await gather('apple_user_id', appleUserId);
  await gather('google_user_id', googleUserId);
  await gather('email', email);

  if (matches.length === 0) {
    const row = {};
    if (appleUserId)  row.apple_user_id  = appleUserId;
    if (googleUserId) row.google_user_id = googleUserId;
    if (email)        row.email          = email;
    if (firstName)    row.first_name     = firstName;
    if (lastName)     row.last_name      = lastName;
    const [created] = await expectWrite(
      `create user for identity (apple=${appleUserId || '-'} google=${googleUserId || '-'} email=${email || '-'})`,
      1,
      supabase.from('users').insert(row).select('*'),
    );
    return { user: created, isNew: true };
  }

  let canonical = pickCanonicalUser(matches);
  const dups = matches.filter(m => m.id !== canonical.id);

  // Capture each dup's identifier values so we can re-attach them to canonical
  // after mergeUserInto deletes the dup row. Only capture fields canonical is
  // currently missing; never overwrite canonical's existing values.
  const fromDups = {};
  for (const d of dups) {
    if (d.apple_user_id  && !canonical.apple_user_id  && !fromDups.apple_user_id)  fromDups.apple_user_id  = d.apple_user_id;
    if (d.google_user_id && !canonical.google_user_id && !fromDups.google_user_id) fromDups.google_user_id = d.google_user_id;
    if (d.email          && !canonical.email          && !fromDups.email)          fromDups.email          = d.email;
    if (d.phone          && !canonical.phone          && !fromDups.phone)          fromDups.phone          = d.phone;
    if (d.first_name     && !canonical.first_name     && !fromDups.first_name)     fromDups.first_name     = d.first_name;
    if (d.last_name      && !canonical.last_name      && !fromDups.last_name)      fromDups.last_name      = d.last_name;
  }

  if (dups.length) {
    console.warn('[gamify api] merging duplicate users on identity sign-in',
      'canonical:', canonical.id, 'merging:', dups.map(d => d.id));
    for (const d of dups) await mergeUserInto(d.id, canonical.id);
  }

  // Build the canonical update from captured dup fields + caller-supplied
  // identifiers, never overwriting canonical's existing values.
  const updates = { ...fromDups };
  if (!canonical.apple_user_id  && updates.apple_user_id  === undefined && appleUserId)  updates.apple_user_id  = appleUserId;
  if (!canonical.google_user_id && updates.google_user_id === undefined && googleUserId) updates.google_user_id = googleUserId;
  if (!canonical.email          && updates.email          === undefined && email)        updates.email          = email;
  if (!canonical.first_name     && updates.first_name     === undefined && firstName)    updates.first_name     = firstName;
  if (!canonical.last_name      && updates.last_name      === undefined && lastName)     updates.last_name      = lastName;

  if (Object.keys(updates).length > 0) {
    const { data: updated, error: uErr } = await supabase.from('users')
      .update(updates).eq('id', canonical.id).select('*').single();
    if (uErr) throw uErr;
    if (updated) canonical = updated;
  }
  return { user: canonical, isNew: false };
}

// POST /api/auth/login  body: { phone }
// If a user already exists for this phone, return it (with their name intact
// so the client skips CompleteProfile). Otherwise create a stub row.
app.post('/api/auth/login', async (req, res) => {
  try {
    assertEnv();
    const phone = normalizePhone(req.body?.phone);
    if (!phone || phone.length < 7) {
      return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }
    const { user, isNew } = await findOrCreateUserByPhone({ phone });
    console.log('[gamify api] login: phone', phone,
      isNew ? '-> NEW user' : '-> existing user', user.id,
      user.first_name ? '(profile complete)' : '(no name yet)');
    res.json({ user, isNew });
  } catch (e) { sendError(res, e); }
});

// POST /api/auth/lookup  body: { phone }
// Lightweight "do you know me?" check used by the invite-join screen so a
// returning user only sees a Join button (no name fields). Does not create
// rows. Returns { exists, hasName, firstName, lastName }.
app.post('/api/auth/lookup', async (req, res) => {
  try {
    assertEnv();
    const phone = normalizePhone(req.body?.phone);
    if (!phone || phone.length < 7) {
      return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }
    const { data: matches } = await supabase
      .from('users').select('*').eq('phone', phone);
    if (!matches || matches.length === 0) {
      return res.json({ exists: false, hasName: false });
    }
    const canonical = pickCanonicalUser(matches);
    res.json({
      exists: true,
      hasName: !!(canonical.first_name && canonical.last_name),
      firstName: canonical.first_name || '',
      lastName:  canonical.last_name  || '',
    });
  } catch (e) { sendError(res, e); }
});

// POST /api/auth/invite-join  body: { shareCode, firstName, lastName, phone }
// Magic-link entry path: the invite link skips the code-entry step. If the
// phone is already a returning user, their existing profile + memberships are
// reused (names in the body are ignored). Only new phones need to supply a
// first + last name. Returns { user, game } so the client can sign in and
// land on the game shell.
app.post('/api/auth/invite-join', async (req, res) => {
  try {
    assertEnv();
    const shareCode = String(req.body?.shareCode || '').trim().toUpperCase();
    const firstName = String(req.body?.firstName || '').trim();
    const lastName  = String(req.body?.lastName  || '').trim();
    const phone     = normalizePhone(req.body?.phone);
    if (!shareCode) return res.status(400).json({ error: 'Missing invite code.' });
    if (!phone || phone.length < 7) return res.status(400).json({ error: 'Please enter a valid phone number.' });

    const { data: game } = await supabase.from('games').select('*').eq('share_code', shareCode).maybeSingle();
    if (!game) return res.status(404).json({ error: 'Invite link is no longer valid.' });

    // Require name only when this phone is brand-new (or has no name yet).
    const { data: existing } = await supabase
      .from('users').select('first_name, last_name').eq('phone', phone);
    const hasCompleteProfile = (existing || []).some(u => u.first_name && u.last_name);
    if (!hasCompleteProfile && (!firstName || !lastName)) {
      return res.status(400).json({ error: 'First and last name are required.' });
    }

    const { user } = await findOrCreateUserByPhone({ phone, firstName, lastName });

    const { error: memErr } = await supabase.from('memberships')
      .insert({ user_id: user.id, game_id: game.id });
    if (memErr && memErr.code !== '23505') throw memErr;

    res.json({ user, game });
  } catch (e) { sendError(res, e); }
});

// GET /api/auth/me — return the freshest user row. Used on app mount so
// stale localStorage data (e.g. missing onboarded_at on returning users)
// gets refreshed without a re-login.
app.get('/api/auth/me', async (req, res) => {
  try {
    const user = await requireUser(req);
    res.json({ user });
  } catch (e) { sendError(res, e); }
});

// POST /api/auth/complete-onboarding — stamp users.onboarded_at so the
// welcome tour doesn't show again on any device.
app.post('/api/auth/complete-onboarding', async (req, res) => {
  try {
    const user = await requireUser(req);
    if (user.onboarded_at) return res.json({ user });
    const [updated] = await expectWrite(
      `mark onboarded for user ${user.id}`,
      1,
      supabase.from('users')
        .update({ onboarded_at: new Date().toISOString() })
        .eq('id', user.id)
        .select('*'),
    );
    res.json({ user: updated });
  } catch (e) { sendError(res, e); }
});

// POST /api/auth/complete-profile  body: { firstName, lastName }
app.post('/api/auth/complete-profile', async (req, res) => {
  try {
    const user = await requireUser(req);
    const firstName = String(req.body?.firstName || '').trim();
    const lastName  = String(req.body?.lastName  || '').trim();
    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'First and last name are required.' });
    }
    const [updated] = await expectWrite(
      `complete-profile update for user ${user.id}`,
      1,
      supabase.from('users')
        .update({ first_name: firstName, last_name: lastName })
        .eq('id', user.id)
        .select('*'),
    );
    res.json({ user: updated });
  } catch (e) { sendError(res, e); }
});

// ---------------------------------------------------------------------------
// iOS auth (Sign in with Apple, Sign in with Google, phone linking)
// ---------------------------------------------------------------------------

// POST /api/auth/apple  body: { identityToken, firstName?, lastName? }
// Apple ships first_name/last_name only on the FIRST sign-in (in the OAuth
// response, not the JWT). The native app must forward them on that one call;
// subsequent calls just send identityToken and we keep the name we already
// stored. The JWT itself is verified against Apple's published JWKS.
app.post('/api/auth/apple', async (req, res) => {
  try {
    assertEnv();
    const identityToken = String(req.body?.identityToken || '').trim();
    if (!identityToken) return res.status(400).json({ error: 'Missing identityToken.' });
    const payload = await verifyAppleIdentityToken(identityToken);
    const appleUserId = payload.sub;
    const tokenEmail = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    const firstName = String(req.body?.firstName || '').trim() || null;
    const lastName  = String(req.body?.lastName  || '').trim() || null;
    const { user, isNew } = await findOrCreateUserByIdentity({
      appleUserId, email: tokenEmail, firstName, lastName,
    });
    res.json({ user, isNew });
  } catch (e) { sendError(res, e); }
});

// POST /api/auth/google  body: { idToken }
// Google's verifyIdToken handles JWKS + audience + expiry; we just hand it
// the iOS client ID we registered in Google Cloud Console.
app.post('/api/auth/google', async (req, res) => {
  try {
    assertEnv();
    const idToken = String(req.body?.idToken || '').trim();
    if (!idToken) return res.status(400).json({ error: 'Missing idToken.' });
    const audience = process.env.GOOGLE_IOS_CLIENT_ID;
    if (!audience) return res.status(500).json({ error: 'GOOGLE_IOS_CLIENT_ID is not set on the server.' });
    let payload;
    try {
      const ticket = await googleAuthClient.verifyIdToken({ idToken, audience });
      payload = ticket.getPayload();
    } catch (err) {
      return res.status(400).json({ error: `Invalid Google ID token: ${err.message}` });
    }
    const googleUserId = payload?.sub;
    if (!googleUserId) return res.status(400).json({ error: 'Google ID token had no subject.' });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    const firstName = (payload.given_name || '').trim() || null;
    const lastName  = (payload.family_name || '').trim() || null;
    const { user, isNew } = await findOrCreateUserByIdentity({
      googleUserId, email, firstName, lastName,
    });
    res.json({ user, isNew });
  } catch (e) { sendError(res, e); }
});

// POST /api/auth/link-phone  body: { phone }  [authed]
// Lets a freshly-Apple/Google-signed-in iOS user attach their phone to an
// existing web account so they get all their web history (calendar, streak,
// points). If the phone matches a different user we merge iOS -> web: the
// web user's row survives (keeps its id), the iOS user's auth identifiers
// migrate onto it, and the iOS row + its child rows are absorbed via
// mergeUserInto. Client must replace its X-User-Id with the returned id.
app.post('/api/auth/link-phone', async (req, res) => {
  try {
    const user = await requireUser(req);
    const phone = normalizePhone(req.body?.phone);
    if (!phone || phone.length < 7) {
      return res.status(400).json({ error: 'Please enter a valid phone number.' });
    }
    const { data: matches } = await supabase.from('users').select('*').eq('phone', phone);
    const others = (matches || []).filter(m => m.id !== user.id);

    if (others.length === 0) {
      // No conflict — just stamp the phone onto the current iOS user.
      if (user.phone === phone) return res.json({ user });
      const [updated] = await expectWrite(
        `link phone ${phone} to user ${user.id}`,
        1,
        supabase.from('users').update({ phone }).eq('id', user.id).select('*'),
      );
      return res.json({ user: updated });
    }

    // Phone belongs to a different user (the web account). Merge iOS -> web.
    const webUser = pickCanonicalUser(others);

    // Move the iOS user's auth identifiers onto the web user. The unique
    // constraints on apple_user_id / google_user_id / email mean we have to
    // NULL them on the iOS row first, otherwise the update on the web row
    // would collide with the still-present value on the iOS row.
    const moves = {};
    if (user.apple_user_id     && !webUser.apple_user_id)     moves.apple_user_id     = user.apple_user_id;
    if (user.google_user_id    && !webUser.google_user_id)    moves.google_user_id    = user.google_user_id;
    if (user.email             && !webUser.email)             moves.email             = user.email;
    if (user.apns_device_token && !webUser.apns_device_token) moves.apns_device_token = user.apns_device_token;
    if (user.timezone          && !webUser.timezone)          moves.timezone          = user.timezone;
    if (user.first_name        && !webUser.first_name)        moves.first_name        = user.first_name;
    if (user.last_name         && !webUser.last_name)         moves.last_name         = user.last_name;

    const iosClears = {};
    if (moves.apple_user_id)  iosClears.apple_user_id  = null;
    if (moves.google_user_id) iosClears.google_user_id = null;
    if (moves.email)          iosClears.email          = null;
    if (Object.keys(iosClears).length > 0) {
      const { error } = await supabase.from('users').update(iosClears).eq('id', user.id);
      if (error) throw error;
    }
    if (Object.keys(moves).length > 0) {
      const { error } = await supabase.from('users').update(moves).eq('id', webUser.id);
      if (error) throw error;
    }

    // Absorb iOS row + all child rows into the web row.
    await mergeUserInto(user.id, webUser.id);

    const { data: fresh } = await supabase.from('users').select('*').eq('id', webUser.id).maybeSingle();
    res.json({ user: fresh || webUser });
  } catch (e) { sendError(res, e); }
});

// ---------------------------------------------------------------------------
// iOS "me" endpoints (push token, notification prefs, account deletion)
// ---------------------------------------------------------------------------

// POST /api/me/push-token  body: { apnsDeviceToken, timezone }
// Called by the native app on every launch (tokens rotate). Also stamps
// last_seen_at so the cron handlers can prefer recently-active devices.
app.post('/api/me/push-token', async (req, res) => {
  try {
    const user = await requireUser(req);
    const apnsDeviceToken = String(req.body?.apnsDeviceToken || '').trim();
    const timezone = String(req.body?.timezone || '').trim();
    if (!apnsDeviceToken) return res.status(400).json({ error: 'Missing apnsDeviceToken.' });
    const patch = {
      apns_device_token: apnsDeviceToken,
      last_seen_at: new Date().toISOString(),
    };
    if (timezone) patch.timezone = timezone;
    await expectWrite(
      `register push token for user ${user.id}`,
      1,
      supabase.from('users').update(patch).eq('id', user.id).select('id'),
    );
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

// DELETE /api/me/push-token — clears the stored device token (used when the
// user disables notifications system-wide or signs out). Cron handlers also
// call this server-side path indirectly when APNs returns 410 Unregistered.
app.delete('/api/me/push-token', async (req, res) => {
  try {
    const user = await requireUser(req);
    await expectWrite(
      `clear push token for user ${user.id}`,
      1,
      supabase.from('users').update({ apns_device_token: null }).eq('id', user.id).select('id'),
    );
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

// PUT /api/me/notification-prefs  body: { daily?, passed?, streak? }
// Each field is optional; we shallow-merge into the existing jsonb so a
// client only sending one toggle doesn't blow away the others.
app.put('/api/me/notification-prefs', async (req, res) => {
  try {
    const user = await requireUser(req);
    const prev = (user.notification_prefs && typeof user.notification_prefs === 'object') ? user.notification_prefs : {};
    const next = { ...prev };
    if (typeof req.body?.daily  === 'boolean') next.daily  = req.body.daily;
    if (typeof req.body?.passed === 'boolean') next.passed = req.body.passed;
    if (typeof req.body?.streak === 'boolean') next.streak = req.body.streak;
    const [updated] = await expectWrite(
      `update notification prefs for user ${user.id}`,
      1,
      supabase.from('users').update({ notification_prefs: next }).eq('id', user.id).select('*'),
    );
    res.json({ user: updated });
  } catch (e) { sendError(res, e); }
});

// POST /api/me/delete — hard delete per Apple 5.1.1(v). ON DELETE CASCADE on
// every child FK takes care of memberships, points_ledger, learn_runs,
// quiz_attempts, test_attempts, daily_rank_snapshots, activity_log. Games
// where this user is admin cascade-delete (which removes their pairs).
app.post('/api/me/delete', async (req, res) => {
  try {
    const user = await requireUser(req);
    await expectWrite(
      `delete user ${user.id}`,
      1,
      supabase.from('users').delete().eq('id', user.id).select('id'),
    );
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

// ===========================================================================
// CRON — push notification senders. Schedule lives in vercel.json. Each
// handler is idempotent: re-running it on the same hour won't double-send
// because targeting is recomputed from current DB state every invocation.
// ===========================================================================

// Vercel Cron Jobs send a GET request with `x-vercel-cron: 1`. For manual
// testing or local dev, accept `Authorization: Bearer $CRON_SECRET` instead.
function requireCron(req) {
  if (req.header('x-vercel-cron')) return;
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
  if (expected && req.header('authorization') === expected) return;
  const e = new Error('Cron auth required'); e.status = 401; throw e;
}

// Compute the wall-clock weekday/hour/date in the given IANA tz.
// Returns null for an unknown/invalid timezone.
function localPartsInTz(tz, date = new Date()) {
  if (!tz) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const map = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
    return {
      weekday: map.weekday,                  // 'Mon'..'Sun'
      hour: parseInt(map.hour, 10),          // 0..23
      date: `${map.year}-${map.month}-${map.day}`,
    };
  } catch {
    return null;
  }
}

// One send + 410-cleanup wrapper used by every cron handler. Bad/expired
// tokens get NULLed in the DB so the next cron doesn't keep retrying them.
async function sendOrCleanup(userId, deviceToken, payload) {
  try {
    await sendPush(deviceToken, payload);
    return true;
  } catch (err) {
    if (err.unregistered) {
      await supabase.from('users').update({ apns_device_token: null }).eq('id', userId);
      console.warn('[gamify cron] cleared unregistered token for user', userId);
    } else {
      console.error('[gamify cron] push failed for user', userId, err.message);
    }
    return false;
  }
}

// Read the full population of "send-eligible" users once per cron run: live
// users with a registered device token. We no longer exclude null-timezone
// users here — the daily-quiz handler falls back to Eastern, so a missing tz
// no longer silently drops a user from the reminder. (streak-danger keeps
// skipping null-tz users, since `localPartsInTz(null)` returns null.)
async function loadNotifiableUsers() {
  const { data, error } = await supabase.from('users')
    .select('id, first_name, apns_device_token, timezone, notification_prefs')
    .is('deleted_at', null)
    .not('apns_device_token', 'is', null);
  if (error) throw error;
  return data || [];
}

// Once a day at 07:00 Eastern. The GitHub Actions schedule fires at both 11:00
// and 12:00 UTC (to cover EDT/EST); this single ET-hour guard makes only the
// 7am-ET run actually send — no per-user timezone math. Targets every
// notifiable user whose notification_prefs.daily ≠ false and who has NOT
// logged any activity today (ET). `force` bypasses the hour guard for testing.
async function runDailyQuizCron({ force } = {}) {
  const now = new Date();
  const et = localPartsInTz('America/New_York', now);
  if (!force && (!et || et.hour !== 7)) {
    return { sent: 0, skipped: 0, considered: 0, skippedReason: 'off-hour' };
  }
  const today = easternDateString(now);
  const users = await loadNotifiableUsers();
  let sent = 0, skipped = 0;
  for (const u of users) {
    const prefs = u.notification_prefs || {};
    if (prefs.daily === false) { skipped++; continue; }
    const { count, error: cErr } = await supabase.from('activity_log')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', u.id).eq('date_et', today);
    if (cErr) throw cErr;
    if ((count || 0) > 0) { skipped++; continue; }
    const ok = await sendOrCleanup(u.id, u.apns_device_token, {
      title: 'Daily Quiz',
      body: u.first_name ? `${u.first_name}, your Daily Quiz is ready.` : 'Your Daily Quiz is ready.',
      data: { type: 'daily-quiz' },
    });
    if (ok) sent++;
  }
  return { sent, skipped, considered: users.length };
}

// Once a week, Saturday 12:00 Eastern. Schedule fires 16:00 & 17:00 UTC Sat
// (EDT/EST); the ET guard selects noon ET. Sends to users with a live streak
// last week (≥1 activity Sun-Sat last week) but no activity this week so far.
// `force` bypasses the day/hour guard for testing.
async function runStreakDangerCron({ force } = {}) {
  const now = new Date();
  const et = localPartsInTz('America/New_York', now);
  if (!force && (!et || et.weekday !== 'Sat' || et.hour !== 12)) {
    return { sent: 0, skipped: 0, considered: 0, skippedReason: 'off-hour' };
  }
  const week = easternWeekRange(now);
  const users = await loadNotifiableUsers();
  let sent = 0, skipped = 0;
  for (const u of users) {
    const prefs = u.notification_prefs || {};
    if (prefs.streak === false) { skipped++; continue; }

    const { count: thisCount, error: e1 } = await supabase.from('activity_log')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', u.id)
      .gte('date_et', week.thisStart).lte('date_et', week.thisEnd);
    if (e1) throw e1;
    if ((thisCount || 0) > 0) { skipped++; continue; }

    const { count: lastCount, error: e2 } = await supabase.from('activity_log')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', u.id)
      .gte('date_et', week.lastStart).lte('date_et', week.lastEnd);
    if (e2) throw e2;
    if ((lastCount || 0) < 1) { skipped++; continue; }

    const ok = await sendOrCleanup(u.id, u.apns_device_token, {
      title: 'Your streak ends tonight',
      body: 'Take a quick session before midnight to keep it alive.',
      data: { type: 'streak-danger' },
    });
    if (ok) sent++;
  }
  return { sent, skipped, considered: users.length };
}

// Once a day at 14:00 Eastern. Schedule fires 18:00 & 19:00 UTC (EDT/EST); the
// ET guard selects 2pm ET. For every game, compare current ranks to the
// snapshot taken at the previous daily run (≈24h ago) and notify each member
// who dropped, naming whoever now holds the rank they used to hold. The first
// run per game bootstraps the snapshot without sending. `force` bypasses the
// hour guard for testing.
async function runLeaderboardChangesCron({ force } = {}) {
  const now = new Date();
  const et = localPartsInTz('America/New_York', now);
  if (!force && (!et || et.hour !== 14)) {
    return { games: 0, sent: 0, skippedReason: 'off-hour' };
  }

  const { data: games, error: gErr } = await supabase.from('games')
    .select('id, title, last_notified_ranks');
  if (gErr) throw gErr;

  let sent = 0;
  for (const game of games || []) {
    const { data: mems } = await supabase.from('memberships')
      .select('user_id').eq('game_id', game.id);
    const memberIds = (mems || []).map(m => m.user_id);
    if (memberIds.length === 0) continue;

    const { data: members } = await supabase.from('users')
      .select('id, first_name, last_name, apns_device_token, notification_prefs, deleted_at')
      .in('id', memberIds);
    // Pre-aggregated per-user totals (see leaderboard route): avoids the
    // 1000-row truncation that would skew "X passed you" rank calculations.
    const { data: totalsRows } = await supabase.from('v_user_game_totals')
      .select('user_id, total_points').eq('game_id', game.id);
    const totals = new Map(
      (totalsRows || []).map(r => [r.user_id, Number(r.total_points)]),
    );

    const rows = (members || []).map(m => ({
      userId: m.id,
      firstName: m.first_name || '',
      lastName: m.last_name || '',
      apnsToken: m.apns_device_token,
      prefs: m.notification_prefs || {},
      deletedAt: m.deleted_at,
      totalPoints: Number(totals.get(m.id) || 0),
    }));
    rows.sort((a, b) => b.totalPoints - a.totalPoints
      || (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));

    const currentRanks = {};
    const userByRank = {};
    rows.forEach((r, i) => {
      currentRanks[r.userId] = i + 1;
      userByRank[i + 1] = r;
    });

    const prev = game.last_notified_ranks || {};
    const isBootstrap = Object.keys(prev).length === 0;

    if (!isBootstrap) {
      for (const r of rows) {
        if (r.deletedAt || !r.apnsToken) continue;
        if (r.prefs.passed === false) continue;
        const prevRank = prev[r.userId];
        const newRank = currentRanks[r.userId];
        if (prevRank == null) continue;       // brand-new member; nobody passed them
        if (newRank <= prevRank) continue;    // didn't drop since yesterday
        const passer = userByRank[prevRank];
        if (!passer || passer.userId === r.userId) continue;
        const passerName = passer.firstName || 'Someone';
        const ok = await sendOrCleanup(r.userId, r.apnsToken, {
          title: game.title || 'Leaderboard update',
          body: `${passerName} just passed you in ${game.title || 'your game'}.`,
          data: { type: 'leaderboard-changes', gameId: game.id },
        });
        if (ok) sent++;
      }
    }

    const { error: uErr } = await supabase.from('games')
      .update({ last_notified_ranks: currentRanks }).eq('id', game.id);
    if (uErr) throw uErr;
  }
  return { games: (games || []).length, sent };
}

// Register each cron on both GET (Vercel's default) and POST (curl smoke
// tests with --request POST).
function registerCron(path, handler) {
  const wrapped = async (req, res) => {
    try {
      requireCron(req);
      // `?force=1` bypasses a handler's time-of-day guard so a manual
      // workflow_dispatch (or curl) can exercise the send path outside the
      // scheduled ET window. Per-user guards (already-played, prefs) still apply.
      const force = req.query.force === '1' || req.query.force === 'true';
      const result = await handler({ force });
      res.json({ ok: true, ...result });
    } catch (e) { sendError(res, e); }
  };
  app.get(path, wrapped);
  app.post(path, wrapped);
}
registerCron('/api/cron/notifications/daily-quiz',          runDailyQuizCron);
registerCron('/api/cron/notifications/streak-danger',       runStreakDangerCron);
registerCron('/api/cron/notifications/leaderboard-changes', runLeaderboardChangesCron);

// ===========================================================================
// GAMES
// ===========================================================================

// GET /api/me/games — all games the user is a member of
app.get('/api/me/games', async (req, res) => {
  try {
    const user = await requireUser(req);
    const { data: mems, error: mErr } = await supabase
      .from('memberships').select('game_id, joined_at').eq('user_id', user.id);
    if (mErr) throw mErr;
    if (!mems.length) return res.json({ games: [] });
    const ids = mems.map(m => m.game_id);
    const { data: games, error: gErr } = await supabase
      .from('games').select('*').in('id', ids);
    if (gErr) throw gErr;
    res.json({ games });
  } catch (e) { sendError(res, e); }
});

// Allowed values for the per-game direction setting. See schema.sql for the
// behavior of each mode in Quiz / Test / Learn.
const DIRECTIONS = ['term', 'definition', 'shuffle'];
function normalizeDirection(v, fallback = 'shuffle') {
  return DIRECTIONS.includes(v) ? v : fallback;
}

// Resolve the card-level direction ('term'|'definition') from the game's
// direction setting. Shuffle picks per-card; the others are fixed.
function pickCardDirection(gameDirection) {
  if (gameDirection === 'term') return 'term';
  if (gameDirection === 'definition') return 'definition';
  return Math.random() < 0.5 ? 'definition' : 'term';
}

// POST /api/games — create a game. body: { title, pairs: [{term, definition}], direction }
app.post('/api/games', async (req, res) => {
  try {
    const user = await requireUser(req);
    const title = String(req.body?.title || '').trim();
    const pairs = Array.isArray(req.body?.pairs) ? req.body.pairs : [];
    const direction = normalizeDirection(req.body?.direction);
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const cleanPairs = pairs
      .map(p => ({ term: String(p.term || '').trim(), definition: String(p.definition || '').trim() }))
      .filter(p => p.term && p.definition);
    if (cleanPairs.length === 0) {
      return res.status(400).json({ error: 'Add at least one term/definition pair.' });
    }

    // Make a unique share code (collide-retry a few times).
    let shareCode = '';
    for (let i = 0; i < 8; i++) {
      const candidate = genShareCode();
      const { data: hit } = await supabase
        .from('games').select('id').eq('share_code', candidate).maybeSingle();
      if (!hit) { shareCode = candidate; break; }
    }
    if (!shareCode) return res.status(500).json({ error: 'Could not generate share code.' });

    const { data: game, error: gErr } = await supabase.from('games').insert({
      title, admin_user_id: user.id, share_code: shareCode, direction,
    }).select('*').single();
    if (gErr) throw gErr;

    const pairRows = cleanPairs.map((p, i) => ({
      game_id: game.id, term: p.term, definition: p.definition, sort_order: i + 1,
    }));
    await expectWrite(
      `insert pairs for game ${game.id}`,
      pairRows.length,
      supabase.from('pairs').insert(pairRows).select('id'),
    );

    const { error: memErr } = await supabase.from('memberships')
      .insert({ user_id: user.id, game_id: game.id });
    if (memErr && memErr.code !== '23505') throw memErr;

    res.json({ game });
  } catch (e) { sendError(res, e); }
});

// POST /api/games/join — body: { shareCode }
app.post('/api/games/join', async (req, res) => {
  try {
    const user = await requireUser(req);
    const code = String(req.body?.shareCode || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Enter a share code.' });
    const { data: game, error: gErr } = await supabase
      .from('games').select('*').eq('share_code', code).maybeSingle();
    if (gErr) throw gErr;
    if (!game) return res.status(404).json({ error: 'No game with that code.' });

    const { error: insErr } = await supabase.from('memberships')
      .insert({ user_id: user.id, game_id: game.id });
    if (insErr && insErr.code !== '23505') throw insErr;
    res.json({ game });
  } catch (e) { sendError(res, e); }
});

// GET /api/games/:id — full game (pairs + your role)
app.get('/api/games/:id', async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id } = req.params;
    const { data: game, error: gErr } = await supabase
      .from('games').select('*').eq('id', id).maybeSingle();
    if (gErr) throw gErr;
    if (!game) return res.status(404).json({ error: 'Game not found.' });

    const { data: mem } = await supabase.from('memberships')
      .select('*').eq('user_id', user.id).eq('game_id', id).maybeSingle();
    if (!mem) return res.status(403).json({ error: 'You are not in this game.' });

    const pairs = await expectRead(
      `load pairs for game ${id}`,
      supabase
        .from('pairs').select('*').eq('game_id', id).is('deleted_at', null)
        .order('sort_order', { ascending: true }),
    );

    res.json({ game, pairs, isAdmin: game.admin_user_id === user.id });
  } catch (e) { sendError(res, e); }
});

// PUT /api/games/:id — admin updates game-level settings (currently just
// direction). "Apply immediately to everything": today's frozen quiz/test
// sets are deleted (next access regenerates them with the new direction) and
// every active Learn run has its per-card direction rewritten.
app.put('/api/games/:id', async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id } = req.params;
    const { data: game } = await supabase.from('games').select('*').eq('id', id).maybeSingle();
    if (!game) return res.status(404).json({ error: 'Game not found.' });
    if (game.admin_user_id !== user.id) return res.status(403).json({ error: 'Only the admin can update this game.' });

    const newDirection = req.body?.direction;
    if (!newDirection || !DIRECTIONS.includes(newDirection)) {
      return res.status(400).json({ error: 'Invalid direction.' });
    }
    if (newDirection === game.direction) {
      return res.json({ game });
    }

    const [updated] = await expectWrite(
      `update direction for game ${id}`,
      1,
      supabase.from('games').update({ direction: newDirection }).eq('id', id).select('*'),
    );

    // Wipe today's (and any future) frozen daily sets so the next quiz/test
    // load builds a fresh set under the new direction.
    const today = easternDateString();
    await supabase.from('daily_question_sets').delete()
      .eq('game_id', id).gte('date_et', today);

    // Rewrite per-card direction on every active Learn run for this game.
    const { data: runs } = await supabase.from('learn_runs')
      .select('user_id, state').eq('game_id', id);
    for (const r of (runs || [])) {
      const state = r.state || {};
      if (!state.cards) continue;
      for (const cid of Object.keys(state.cards)) {
        state.cards[cid].direction = pickCardDirection(newDirection);
      }
      await supabase.from('learn_runs')
        .update({ state, updated_at: new Date().toISOString() })
        .eq('user_id', r.user_id).eq('game_id', id);
    }

    res.json({ game: updated });
  } catch (e) { sendError(res, e); }
});

// POST /api/games/:id/pairs — admin adds new pairs after launch.
app.post('/api/games/:id/pairs', async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id } = req.params;
    const newPairs = Array.isArray(req.body?.pairs) ? req.body.pairs : [];
    const { data: game } = await supabase.from('games').select('*').eq('id', id).maybeSingle();
    if (!game) return res.status(404).json({ error: 'Game not found.' });
    if (game.admin_user_id !== user.id) return res.status(403).json({ error: 'Only the admin can add pairs.' });

    const clean = newPairs.map(p => ({
      term: String(p.term || '').trim(), definition: String(p.definition || '').trim(),
    })).filter(p => p.term && p.definition);
    if (!clean.length) return res.status(400).json({ error: 'No valid pairs.' });

    const { data: last } = await supabase.from('pairs').select('sort_order')
      .eq('game_id', id).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const base = last?.sort_order || 0;

    const rows = clean.map((p, i) => ({
      game_id: id, term: p.term, definition: p.definition, sort_order: base + i + 1,
    }));
    await expectWrite(
      `insert pairs (admin add) for game ${id}`,
      rows.length,
      supabase.from('pairs').insert(rows).select('id'),
    );
    res.json({ ok: true, added: rows.length });
  } catch (e) { sendError(res, e); }
});

// PUT /api/games/:id/pairs — admin "Edit Pairs": diff-save the full editable
// list. Changes apply IMMEDIATELY:
//   - Today's (and future) daily_question_sets are deleted so the next quiz/
//     test load builds a fresh set. Already-submitted attempts keep their
//     locked score (we don't claw back or re-grade).
//   - Active Learn runs are updated in-place: edited text propagates into the
//     run's card snapshot; deleted pairs are dropped from cards + queue;
//     newly-inserted pairs are picked up the next time the run loads (via
//     syncNewPairs).
// Body: { pairs: [{ id?, term, definition }] }
// Rules:
//   - Rows without id and with content -> insert.
//   - Rows with id -> update term/definition (if changed).
//   - Pairs in DB (non-deleted) NOT present in body -> soft-delete.
app.put('/api/games/:id/pairs', async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id } = req.params;
    const incoming = Array.isArray(req.body?.pairs) ? req.body.pairs : [];

    const { data: game } = await supabase.from('games').select('*').eq('id', id).maybeSingle();
    if (!game) return res.status(404).json({ error: 'Game not found.' });
    if (game.admin_user_id !== user.id) return res.status(403).json({ error: 'Only the admin can edit pairs.' });

    const clean = incoming.map(p => ({
      id: p.id ? String(p.id) : null,
      term: String(p.term || '').trim(),
      definition: String(p.definition || '').trim(),
    })).filter(p => p.term && p.definition);
    if (!clean.length) return res.status(400).json({ error: 'At least one pair is required.' });

    const { data: existing } = await supabase.from('pairs')
      .select('id, term, definition, sort_order')
      .eq('game_id', id).is('deleted_at', null);
    const existingMap = new Map((existing || []).map(p => [p.id, p]));
    const incomingIds = new Set(clean.filter(p => p.id).map(p => p.id));

    // Soft-delete any pair not present in incoming.
    const toDelete = (existing || []).filter(p => !incomingIds.has(p.id)).map(p => p.id);
    if (toDelete.length) {
      await expectWrite(
        `soft-delete pairs for game ${id}`,
        toDelete.length,
        supabase.from('pairs')
          .update({ deleted_at: new Date().toISOString() })
          .in('id', toDelete)
          .select('id'),
      );
    }

    // Update changed rows.
    let updatedCount = 0;
    for (const row of clean) {
      if (!row.id) continue;
      const prev = existingMap.get(row.id);
      if (!prev) continue;
      if (prev.term === row.term && prev.definition === row.definition) continue;
      await expectWrite(
        `update pair ${row.id}`,
        1,
        supabase.from('pairs')
          .update({ term: row.term, definition: row.definition })
          .eq('id', row.id)
          .select('id'),
      );
      updatedCount += 1;
    }

    // Insert new rows.
    const { data: last } = await supabase.from('pairs').select('sort_order')
      .eq('game_id', id).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    let base = last?.sort_order || 0;
    const inserts = clean.filter(p => !p.id).map((p) => {
      base += 1;
      return { game_id: id, term: p.term, definition: p.definition, sort_order: base };
    });
    if (inserts.length) {
      await expectWrite(
        `insert new pairs for game ${id}`,
        inserts.length,
        supabase.from('pairs').insert(inserts).select('id'),
      );
    }

    // Apply immediately: regenerate today's quiz/test and push edits/deletes
    // into every active Learn run for this game.
    const today = easternDateString();
    await supabase.from('daily_question_sets').delete()
      .eq('game_id', id).gte('date_et', today);

    const deletedIds = new Set(toDelete);
    const updatedById = new Map();
    for (const row of clean) {
      if (!row.id) continue;
      const prev = existingMap.get(row.id);
      if (!prev) continue;
      if (prev.term !== row.term || prev.definition !== row.definition) {
        updatedById.set(row.id, { term: row.term, definition: row.definition });
      }
    }

    if (deletedIds.size > 0 || updatedById.size > 0) {
      const { data: runs } = await supabase.from('learn_runs')
        .select('user_id, state').eq('game_id', id);
      for (const r of (runs || [])) {
        const state = r.state || {};
        if (!state.cards) continue;
        let dirty = false;
        for (const cid of Object.keys(state.cards)) {
          if (deletedIds.has(cid)) {
            delete state.cards[cid];
            state.queue = (state.queue || []).filter(q => q !== cid);
            dirty = true;
          } else if (updatedById.has(cid)) {
            const u = updatedById.get(cid);
            state.cards[cid].term = u.term;
            state.cards[cid].definition = u.definition;
            dirty = true;
          }
        }
        if (!dirty) continue;
        state.totalCards = Object.keys(state.cards).length;
        // If every remaining card is mastered, mark the run complete so the
        // next load offers a reset rather than a stuck "next card".
        const remaining = Object.values(state.cards);
        if (remaining.length > 0 && remaining.every(c => c.mastered) && !state.completedAt) {
          state.completedAt = new Date().toISOString();
        }
        await supabase.from('learn_runs')
          .update({ state, updated_at: new Date().toISOString() })
          .eq('user_id', r.user_id).eq('game_id', id);
      }
    }

    res.json({ ok: true, deleted: toDelete.length, updated: updatedCount, inserted: inserts.length });
  } catch (e) { sendError(res, e); }
});

// ===========================================================================
// LEADERBOARD
// ===========================================================================

// GET /api/games/:id/leaderboard — ranked members with daily delta
app.get('/api/games/:id/leaderboard', async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id } = req.params;

    // membership check
    const { data: mem } = await supabase.from('memberships')
      .select('user_id').eq('user_id', user.id).eq('game_id', id).maybeSingle();
    if (!mem) return res.status(403).json({ error: 'Not in this game.' });

    const { data: members } = await supabase.from('memberships')
      .select('user_id').eq('game_id', id);
    const memberIds = (members || []).map(m => m.user_id);

    const { data: users } = await supabase.from('users')
      .select('id, first_name, last_name').in('id', memberIds.length ? memberIds : ['00000000-0000-0000-0000-000000000000']);

    // Read pre-aggregated per-user totals from the DB view (one row per user).
    // Summing raw points_ledger here instead would silently truncate at
    // PostgREST's 1000-row cap once a game exceeds 1000 ledger entries, which
    // is what made the leaderboard lag behind the (per-user) profile total.
    const { data: totalsRows } = await supabase.from('v_user_game_totals')
      .select('user_id, total_points').eq('game_id', id);
    const totals = new Map(
      (totalsRows || []).map(r => [r.user_id, Number(r.total_points)]),
    );

    let rows = (users || []).map(u => ({
      userId: u.id,
      firstName: u.first_name || '',
      lastName:  u.last_name  || '',
      totalPoints: Number(totals.get(u.id) || 0),
    }));
    rows.sort((a, b) => b.totalPoints - a.totalPoints
      || (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName));
    rows = rows.map((r, i) => ({ ...r, rank: i + 1 }));

    // Daily delta vs the most recent snapshot. Snapshot updates lazily here:
    // if the latest snapshot's date is older than ET-today, refresh it
    // (the snapshot represents "ranks as of midnight today" — i.e. the
    // pre-today state we compare against).
    const today = easternDateString();
    const { data: snapDates } = await supabase.from('daily_rank_snapshots')
      .select('date_et').eq('game_id', id).order('date_et', { ascending: false }).limit(1);
    const latestSnapDate = snapDates?.[0]?.date_et;
    if (latestSnapDate !== today) {
      // upsert today's snapshot using yesterday's totals (which equal the
      // pre-existing ledger totals for everyone whose first activity today
      // hasn't shifted ranks yet). The simplest interpretation: snapshot the
      // CURRENT ranks at first access of the new ET day. Subsequent accesses
      // today compare to that snapshot.
      const snapRows = rows.map(r => ({
        game_id: id, user_id: r.userId, date_et: today,
        rank: r.rank, total_points: r.totalPoints,
      }));
      if (snapRows.length) {
        await supabase.from('daily_rank_snapshots').upsert(snapRows,
          { onConflict: 'game_id,user_id,date_et' });
      }
    }

    const { data: snap } = await supabase.from('daily_rank_snapshots')
      .select('user_id, rank').eq('game_id', id).eq('date_et', today);
    const snapMap = new Map((snap || []).map(s => [s.user_id, s.rank]));
    rows = rows.map(r => {
      const prev = snapMap.get(r.userId);
      const delta = prev == null ? 0 : (prev - r.rank); // positive = moved up
      return { ...r, delta };
    });

    res.json({ leaderboard: rows });
  } catch (e) { sendError(res, e); }
});

// ===========================================================================
// QUIZ / TEST  (deterministic per-day question set)
// ===========================================================================

function buildDailyQuestions(pairs, length, seedStr, direction = 'shuffle') {
  if (pairs.length < length) return null;
  const rng = seededRng(seedStr);
  const chosen = shuffleWith(rng, pairs).slice(0, length);
  return chosen.map((p, i) => {
    // Consume the rng even when direction is fixed so the seeded sequence
    // stays stable (changing direction still produces a coherent set; we
    // delete cached sets on direction change so determinism is per-mode).
    const coin = rng();
    const showDefinition =
      direction === 'definition' ? true
      : direction === 'term' ? false
      : coin < 0.5;
    const promptKey = showDefinition ? 'definition' : 'term';
    const answerKey = showDefinition ? 'term' : 'definition';
    const distractors = shuffleWith(rng, pairs.filter(x => x.id !== p.id))
      .slice(0, MC_OPTION_COUNT - 1)
      .map(x => x[answerKey]);
    const opts = shuffleWith(rng, [p[answerKey], ...distractors]);
    return {
      pairId: p.id,
      prompt: p[promptKey],
      options: opts,
      correctAnswer: p[answerKey],
      index: i,
    };
  });
}

async function getDailyAttempt(table, userId, gameId, dateEt) {
  const { data } = await supabase.from(table).select('*')
    .eq('user_id', userId).eq('game_id', gameId).eq('date_et', dateEt).maybeSingle();
  return data;
}

// Get-or-create today's frozen question set. Once written, today's set
// never changes — admin edits to pairs only affect FUTURE days. The one
// exception is a direction change, which deletes today's row in the PUT
// /api/games/:id handler so the next access regenerates here.
async function getOrCreateDailyQuestions(gameId, kind, dateEt, length, direction) {
  const { data: snap } = await supabase.from('daily_question_sets')
    .select('questions').eq('game_id', gameId).eq('kind', kind).eq('date_et', dateEt).maybeSingle();
  if (snap?.questions && Array.isArray(snap.questions) && snap.questions.length === length) {
    return snap.questions;
  }
  const pairs = await expectRead(
    `load pairs for daily ${kind} on game ${gameId}`,
    supabase.from('pairs').select('*')
      .eq('game_id', gameId).is('deleted_at', null),
  );
  if (!pairs || pairs.length < length) return null;
  const seed = `${kind}|${gameId}|${dateEt}|${direction}`;
  const questions = buildDailyQuestions(pairs, length, seed, direction);
  if (!questions) return null;
  await supabase.from('daily_question_sets').upsert(
    { game_id: gameId, kind, date_et: dateEt, questions },
    { onConflict: 'game_id,kind,date_et' });
  return questions;
}

async function quizOrTestGet(req, res, kind) {
  const user = await requireUser(req);
  const { id } = req.params;
  const length = kind === 'quiz' ? QUIZ_LENGTH : TEST_LENGTH;
  const table  = kind === 'quiz' ? 'quiz_attempts' : 'test_attempts';

  const { data: game } = await supabase.from('games').select('*').eq('id', id).maybeSingle();
  if (!game) return res.status(404).json({ error: 'Game not found.' });
  const { data: mem } = await supabase.from('memberships')
    .select('user_id').eq('user_id', user.id).eq('game_id', id).maybeSingle();
  if (!mem) return res.status(403).json({ error: 'Not in this game.' });

  const dateEt = easternDateString();
  const direction = normalizeDirection(game.direction);
  const questions = await getOrCreateDailyQuestions(id, kind, dateEt, length, direction);
  if (!questions) {
    const pairs = await expectRead(
      `count pairs for ${kind} availability on game ${id}`,
      supabase.from('pairs').select('id')
        .eq('game_id', id).is('deleted_at', null),
    );
    return res.json({ available: false, needed: length, have: pairs?.length || 0 });
  }

  const attempt = await getDailyAttempt(table, user.id, id, dateEt);
  if (attempt) {
    return res.json({
      available: true,
      locked: true,
      attempt,
      questions: questions.map(q => ({ ...q, correctAnswer: undefined })),
    });
  }
  res.json({
    available: true,
    locked: false,
    questions: questions.map(q => ({ ...q, correctAnswer: undefined })),
  });
}

async function quizOrTestSubmit(req, res, kind) {
  const user = await requireUser(req);
  const { id } = req.params;
  const length = kind === 'quiz' ? QUIZ_LENGTH : TEST_LENGTH;
  const maxPts = kind === 'quiz' ? QUIZ_MAX_POINTS : TEST_MAX_POINTS;
  const table  = kind === 'quiz' ? 'quiz_attempts' : 'test_attempts';

  const { data: game } = await supabase.from('games').select('*').eq('id', id).maybeSingle();
  if (!game) return res.status(404).json({ error: 'Game not found.' });

  const dateEt = easternDateString();
  const existing = await getDailyAttempt(table, user.id, id, dateEt);
  if (existing) return res.status(409).json({ error: `Already taken today.`, attempt: existing });

  const direction = normalizeDirection(game.direction);
  const questions = await getOrCreateDailyQuestions(id, kind, dateEt, length, direction);
  if (!questions) return res.status(400).json({ error: 'Not enough content.' });
  const submitted = Array.isArray(req.body?.answers) ? req.body.answers : [];

  let correct = 0;
  const graded = questions.map((q, i) => {
    const chosen = submitted[i] ?? null;
    const isCorrect = chosen != null && chosen === q.correctAnswer;
    if (isCorrect) correct += 1;
    return { pairId: q.pairId, chosen, correct: q.correctAnswer, isCorrect };
  });

  const points = Math.min(correct, maxPts);

  const { data: attempt, error: aErr } = await supabase.from(table).insert({
    user_id: user.id, game_id: id, date_et: dateEt,
    total: length, correct, answers: graded,
  }).select('*').single();
  if (aErr) throw aErr;

  await supabase.from('points_ledger').insert({
    user_id: user.id, game_id: id, points,
    source: kind, ref_id: attempt.id, earned_date_et: dateEt,
  });
  await supabase.from('activity_log').upsert(
    { user_id: user.id, game_id: id, date_et: dateEt },
    { onConflict: 'user_id,game_id,date_et' }
  );

  res.json({ attempt, points, correct, total: length });
}

app.get('/api/games/:id/quiz',  (req, res) => quizOrTestGet(req, res, 'quiz').catch(e => sendError(res, e)));
app.post('/api/games/:id/quiz', (req, res) => quizOrTestSubmit(req, res, 'quiz').catch(e => sendError(res, e)));
app.get('/api/games/:id/test',  (req, res) => quizOrTestGet(req, res, 'test').catch(e => sendError(res, e)));
app.post('/api/games/:id/test', (req, res) => quizOrTestSubmit(req, res, 'test').catch(e => sendError(res, e)));

// ===========================================================================
// LEARN
// ===========================================================================

// Build a fresh run state for the given pairs. Term/definition are snapshotted
// into each card so future admin edits to a pair don't disturb an active run.
function newRunState(pairs, gameDirection = 'shuffle') {
  const cards = {};
  for (const p of pairs) {
    cards[p.id] = {
      phase: 'mc',
      missedInPhase: false,
      consecutiveCorrect: 0,
      mastered: false,
      paidOut: false,
      // Direction is assigned ONCE per card and kept for the card's entire life
      // in this run (across MC -> TIO and any repeats). For fixed-direction
      // games, every card uses that direction; for 'shuffle', per-card random.
      direction: pickCardDirection(gameDirection),
      term: p.term,
      definition: p.definition,
    };
  }
  // initial queue: every pair, in shuffled order — first pass is all MC.
  const ids = pairs.map(p => p.id);
  // simple Math.random shuffle (each user gets their own order; OK because
  // Learn is personal, not synchronized).
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return {
    cards,
    queue: ids,
    totalCards: ids.length,
    sessionHistory: [],          // [{correct, total}]
    currentSessionCorrect: 0,
    currentSessionAnswered: 0,
    mastersThisRun: 0,
    // mastersBankedAtLastExit: snapshot of mastersThisRun the last time the
    // user exited mid-run. Used to display the "points earned since last exit"
    // figure on the exit popup (which must show 0 if no new masters since).
    mastersBankedAtLastExit: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

async function loadOrInitRun(userId, gameId, gameDirection = 'shuffle') {
  const { data: row } = await supabase.from('learn_runs').select('*')
    .eq('user_id', userId).eq('game_id', gameId).maybeSingle();
  if (row?.state?.cards && row?.state?.queue) return { state: row.state, isNew: false };

  const pairs = await expectRead(
    `load pairs to init Learn run for game ${gameId}`,
    supabase.from('pairs').select('id, term, definition')
      .eq('game_id', gameId).is('deleted_at', null),
  );
  if (!pairs || pairs.length === 0) {
    const e = new Error('No content in this game yet.'); e.status = 400; throw e;
  }
  const state = newRunState(pairs, gameDirection);
  await supabase.from('learn_runs').upsert({
    user_id: userId, game_id: gameId, state, updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,game_id' });
  return { state, isNew: true };
}

async function saveRun(userId, gameId, state) {
  await supabase.from('learn_runs').upsert({
    user_id: userId, game_id: gameId, state, updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,game_id' });
}

// Sync new pairs added by the admin into the current run as "to be learned".
// Cards added mid-run join the queue and are eligible for the slice of points
// in the NEXT run (per spec: "new pairs simply appear in everyone's 'To Be
// Learned' set"). Here we add them to the queue so the run continues to cover
// them; the run's totalCards expands too, so each card slice is recomputed
// proportionally for the cards still unpaid. Active runs are immune to edits
// or deletes of already-known pairs — those only show up in the next run.
async function syncNewPairs(state, gameId, gameDirection = 'shuffle') {
  const pairs = await expectRead(
    `sync new pairs into active Learn run for game ${gameId}`,
    supabase.from('pairs').select('id, term, definition')
      .eq('game_id', gameId).is('deleted_at', null),
  );
  const known = new Set(Object.keys(state.cards));
  const fresh = (pairs || []).filter(p => !known.has(p.id));
  // Backfill direction + text snapshot on legacy cards (for runs created before
  // those landed).
  for (const id of Object.keys(state.cards)) {
    if (!state.cards[id].direction) {
      state.cards[id].direction = pickCardDirection(gameDirection);
    }
    if (state.cards[id].term == null || state.cards[id].definition == null) {
      const cur = (pairs || []).find(p => p.id === id);
      if (cur) {
        state.cards[id].term = cur.term;
        state.cards[id].definition = cur.definition;
      }
    }
  }
  if (fresh.length === 0) return state;
  for (const p of fresh) {
    state.cards[p.id] = {
      phase: 'mc', missedInPhase: false, consecutiveCorrect: 0,
      mastered: false, paidOut: false,
      direction: pickCardDirection(gameDirection),
      term: p.term, definition: p.definition,
    };
    state.queue.push(p.id);
  }
  state.totalCards = Object.keys(state.cards).length;
  return state;
}

// Build the payload the client needs to render the next card. Card text is
// read from the run's frozen snapshot (state.cards) — not the live pairs row —
// so admin edits/deletes don't disturb an in-progress run.
async function buildNextCardPayload(state, gameId) {
  if (state.queue.length === 0) return null;
  const nextId = state.queue[0];
  const cardState = state.cards[nextId];
  if (!cardState) return null;
  // Per-card direction, fixed for the card's life in this run.
  const dir = cardState.direction || 'term';
  const promptKey = dir === 'definition' ? 'definition' : 'term';
  const answerKey = dir === 'definition' ? 'term' : 'definition';

  if (cardState.phase === 'mc') {
    // Distractors come from the OTHER known cards in this run's snapshot so
    // they stay coherent with the snapshot's content.
    const pool = Object.entries(state.cards)
      .filter(([id, c]) => id !== nextId && c && c[answerKey])
      .map(([, c]) => c[answerKey]);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const distractors = pool.slice(0, MC_OPTION_COUNT - 1);
    const options = [...distractors, cardState[answerKey]];
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    return {
      pairId: nextId,
      kind: 'mc',
      prompt: cardState[promptKey],
      options,
      correctAnswer: cardState[answerKey],
    };
  } else {
    return {
      pairId: nextId,
      kind: 'tio',
      prompt: cardState[promptKey],
      correctAnswer: cardState[answerKey],
    };
  }
}

// Build the bucket counts used by the post-session screen.
function bucketCounts(state) {
  let mastered = 0, learning = 0, toBeLearned = 0;
  for (const id of Object.keys(state.cards)) {
    const c = state.cards[id];
    if (c.mastered) mastered++;
    else if (c.phase === 'tio') learning++;
    else toBeLearned++;
  }
  return { mastered, learning, toBeLearned };
}

function estimatedSecondsRemaining(state) {
  let mc = 0, tio = 0;
  for (const id of Object.keys(state.cards)) {
    const c = state.cards[id];
    if (c.mastered) continue;
    if (c.phase === 'mc') {
      // best-case: 1 if not missed; 2 - consecutive if missed
      mc += c.missedInPhase ? Math.max(2 - c.consecutiveCorrect, 1) : 1;
      tio += 1; // will need one tio after graduating
    } else {
      tio += c.missedInPhase ? Math.max(2 - c.consecutiveCorrect, 1) : 1;
    }
  }
  // EST_SECONDS values mirror src/config.js. Hardcoded here to keep this file
  // self-contained.
  return mc * 10 + tio * 30;
}

// GET /api/games/:id/learn — current state + next card (resumes if mid-run)
app.get('/api/games/:id/learn', async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id } = req.params;
    const { data: game } = await supabase.from('games').select('*').eq('id', id).maybeSingle();
    if (!game) return res.status(404).json({ error: 'Game not found.' });
    const { data: mem } = await supabase.from('memberships')
      .select('user_id').eq('user_id', user.id).eq('game_id', id).maybeSingle();
    if (!mem) return res.status(403).json({ error: 'Not in this game.' });

    const direction = normalizeDirection(game.direction);
    let { state } = await loadOrInitRun(user.id, id, direction);
    state = await syncNewPairs(state, id, direction);
    await saveRun(user.id, id, state);

    const nextCard = await buildNextCardPayload(state, id);
    res.json({
      state, nextCard,
      buckets: bucketCounts(state),
      secondsRemaining: estimatedSecondsRemaining(state),
      cardsRemaining: state.queue.length,
    });
  } catch (e) { sendError(res, e); }
});

// POST /api/games/:id/learn/answer  body: { pairId, isCorrect }
// Returns updated state + next card + (if 10 answered) session summary.
app.post('/api/games/:id/learn/answer', async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id } = req.params;
    const pairId = String(req.body?.pairId || '');
    const isCorrect = !!req.body?.isCorrect;

    const { data: game } = await supabase.from('games').select('*').eq('id', id).maybeSingle();
    if (!game) return res.status(404).json({ error: 'Game not found.' });

    const direction = normalizeDirection(game.direction);
    let { state } = await loadOrInitRun(user.id, id, direction);
    state = await syncNewPairs(state, id, direction);

    if (state.queue[0] !== pairId) {
      return res.status(409).json({ error: 'Card mismatch — refresh and continue.' });
    }
    state.queue.shift();
    const card = state.cards[pairId];
    if (!card) return res.status(400).json({ error: 'Unknown card.' });

    let pointsEarned = 0;
    let graduated = false;
    let mastered = false;

    if (isCorrect) {
      if (card.missedInPhase) {
        card.consecutiveCorrect += 1;
        if (card.consecutiveCorrect >= 2) {
          if (card.phase === 'mc') {
            card.phase = 'tio';
            card.missedInPhase = false;
            card.consecutiveCorrect = 0;
            graduated = true;
          } else {
            card.mastered = true;
            mastered = true;
          }
        }
      } else {
        // first-try correct
        if (card.phase === 'mc') {
          card.phase = 'tio';
          card.missedInPhase = false;
          card.consecutiveCorrect = 0;
          graduated = true;
        } else {
          card.mastered = true;
          mastered = true;
        }
      }
    } else {
      card.missedInPhase = true;
      card.consecutiveCorrect = 0;
    }

    // Pay the slice if newly mastered (and not already paid this run).
    if (mastered && !card.paidOut) {
      card.paidOut = true;
      state.mastersThisRun = (state.mastersThisRun || 0) + 1;
      const slice = LEARN_RUN_POINTS / state.totalCards;
      pointsEarned = slice;
      const dateEt = easternDateString();
      await supabase.from('points_ledger').insert({
        user_id: user.id, game_id: id, points: slice,
        source: 'learn_master', ref_id: pairId, earned_date_et: dateEt,
      });
      await supabase.from('activity_log').upsert(
        { user_id: user.id, game_id: id, date_et: dateEt },
        { onConflict: 'user_id,game_id,date_et' });
    } else {
      // Even an in-progress answer counts as activity for the streak/calendar.
      const dateEt = easternDateString();
      await supabase.from('activity_log').upsert(
        { user_id: user.id, game_id: id, date_et: dateEt },
        { onConflict: 'user_id,game_id,date_et' });
    }

    // Re-append the card if not mastered.
    if (!card.mastered) state.queue.push(pairId);

    // Session bookkeeping
    state.currentSessionAnswered = (state.currentSessionAnswered || 0) + 1;
    if (isCorrect) state.currentSessionCorrect = (state.currentSessionCorrect || 0) + 1;

    let sessionSummary = null;
    if (state.currentSessionAnswered >= CARDS_PER_SESSION) {
      sessionSummary = {
        correct: state.currentSessionCorrect,
        total: state.currentSessionAnswered,
      };
      state.sessionHistory = [...(state.sessionHistory || []), sessionSummary];
      state.currentSessionAnswered = 0;
      state.currentSessionCorrect = 0;
    }

    // Check for run completion
    const allMastered = Object.values(state.cards).every(c => c.mastered);
    if (allMastered) {
      state.completedAt = new Date().toISOString();
    }

    await saveRun(user.id, id, state);

    const nextCard = state.completedAt
      ? null
      : await buildNextCardPayload(state, id);

    res.json({
      state,
      nextCard,
      pointsEarned,
      graduated,
      mastered,
      sessionSummary,
      runComplete: !!state.completedAt,
      buckets: bucketCounts(state),
      secondsRemaining: estimatedSecondsRemaining(state),
      cardsRemaining: state.queue.length,
    });
  } catch (e) { sendError(res, e); }
});

// POST /api/games/:id/learn/exit — confirm exit. Points for mastered cards are
// already paid (per-card on mastery). The popup shows "points earned since the
// last bank" — i.e. points from cards mastered AFTER the previous exit. If the
// user re-enters and exits without mastering anything new, this is 0.
app.post('/api/games/:id/learn/exit', async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id } = req.params;
    const { data: game } = await supabase.from('games').select('direction').eq('id', id).maybeSingle();
    const direction = normalizeDirection(game?.direction);
    const { state } = await loadOrInitRun(user.id, id, direction);
    const masters = Object.values(state.cards).filter(c => c.mastered).length;
    const slice = LEARN_RUN_POINTS / Math.max(state.totalCards, 1);
    const bankedSinceLastExit = Math.max(0, masters - (state.mastersBankedAtLastExit || 0)) * slice;
    state.mastersBankedAtLastExit = masters;
    await saveRun(user.id, id, state);
    res.json({
      ok: true,
      bankedSinceLastExit,
      bankedTotalRun: masters * slice,
    });
  } catch (e) { sendError(res, e); }
});

// POST /api/games/:id/learn/reset — start a brand-new run (used after a run
// completes; the client confirms then calls this).
app.post('/api/games/:id/learn/reset', async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id } = req.params;
    const { data: game } = await supabase.from('games').select('direction').eq('id', id).maybeSingle();
    const direction = normalizeDirection(game?.direction);
    const pairs = await expectRead(
      `load pairs for Learn reset on game ${id}`,
      supabase.from('pairs').select('id, term, definition')
        .eq('game_id', id).is('deleted_at', null),
    );
    if (!pairs?.length) return res.status(400).json({ error: 'No content in game.' });
    const state = newRunState(pairs, direction);
    await saveRun(user.id, id, state);
    res.json({ ok: true, state });
  } catch (e) { sendError(res, e); }
});

// ===========================================================================
// PROFILE (calendar, streak, totals)
// ===========================================================================

app.get('/api/games/:id/profile', async (req, res) => {
  try {
    const user = await requireUser(req);
    const { id } = req.params;
    const { data: mem } = await supabase.from('memberships')
      .select('user_id').eq('user_id', user.id).eq('game_id', id).maybeSingle();
    if (!mem) return res.status(403).json({ error: 'Not in this game.' });

    // Same source as the leaderboard (v_user_game_totals) so the profile total
    // and the leaderboard total are identical by construction and can't drift.
    const { data: totalsRow } = await supabase.from('v_user_game_totals')
      .select('total_points').eq('user_id', user.id).eq('game_id', id).maybeSingle();
    const totalPoints = Number(totalsRow?.total_points || 0);

    const { data: activity } = await supabase.from('activity_log')
      .select('date_et').eq('user_id', user.id).eq('game_id', id);
    const activeDates = (activity || []).map(r => r.date_et);

    res.json({
      user: { id: user.id, firstName: user.first_name, lastName: user.last_name },
      totalPoints,
      activeDates,
    });
  } catch (e) { sendError(res, e); }
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 404 for /api/* misses
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

export default app;
