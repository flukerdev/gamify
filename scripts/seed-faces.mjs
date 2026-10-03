// Create (or top up) a passcode-protected photo game from a folder of face
// crops. Server-side only: it talks to Supabase with the service-role key from
// .env, exactly like the API does. Safe to re-run: students already in the
// game (matched by name) are skipped, and passcodes are only set on creation.
//
//   node scripts/seed-faces.mjs <dir>
//
// <dir> must contain:
//   roster.json   { "title": "...", "staffPasscode": "...", "adminPasscode": "...",
//                   "students": [{ "name": "Mason", "file": "mason.jpg" }, ...] }
//   the JPEG files it names (square, a few hundred px)
//
// Photos never belong in the git repo. Keep <dir> outside it.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const { supabase, assertEnv } = await import('../api/_lib/supabase.js');
const { hashPasscode, normalizePasscode } = await import('../api/_lib/session.js');

const dir = process.argv[2];
if (!dir) { console.error('usage: node scripts/seed-faces.mjs <dir>'); process.exit(1); }
assertEnv();
const roster = JSON.parse(fs.readFileSync(path.join(dir, 'roster.json'), 'utf8'));
const die = (label, error) => { console.error(`FAILED ${label}:`, error?.message || error); process.exit(1); };

// Passcodes may come from the environment so they never have to be written
// into a file: STS_STAFF_PASSCODE / STS_ADMIN_PASSCODE override roster.json.
roster.staffPasscode = process.env.STS_STAFF_PASSCODE || roster.staffPasscode;
roster.adminPasscode = process.env.STS_ADMIN_PASSCODE || roster.adminPasscode;
const staffHash = hashPasscode(roster.staffPasscode);
const adminHash = hashPasscode(roster.adminPasscode);
// adminPasscode is the admin PIN. staffPasscode is no longer typed by anyone
// (sign-in is by name); it only fills the required staff_code_hash column.
if (normalizePasscode(roster.staffPasscode).length < 8) die('roster', 'staffPasscode needs at least 8 characters');
if (normalizePasscode(roster.adminPasscode).length < 4) die('roster', 'adminPasscode (the admin PIN) needs at least 4 characters');
if (staffHash === adminHash) die('roster', 'staff and admin passcodes must differ');

// 1. The game (found by title among faces games, else created).
let { data: game, error: gErr } = await supabase.from('games').select('*')
  .eq('kind', 'faces').eq('title', roster.title).maybeSingle();
if (gErr) die('find game', gErr);
if (!game) {
  // The owner row is a placeholder nobody can sign in as (no phone, no
  // login_key). Admin rights come from the admin passcode instead.
  const { data: owner, error: oErr } = await supabase.from('users')
    .insert({ first_name: roster.title, last_name: '(owner)', onboarded_at: new Date().toISOString() })
    .select('*').single();
  if (oErr) die('create owner', oErr);
  const { data: created, error: cErr } = await supabase.from('games').insert({
    // share_code is required and unique but unused by photo games (people
    // sign in with just their name). A lowercase value can never match the
    // classic join-by-code route, which upper-cases what is typed.
    title: roster.title, admin_user_id: owner.id,
    share_code: `photo-${normalizePasscode(roster.staffPasscode)}`,
    direction: 'term', kind: 'faces',
    staff_code_hash: staffHash, admin_code_hash: adminHash,
  }).select('*').single();
  if (cErr) die('create game', cErr);
  game = created;
  console.log('created game', game.id, JSON.stringify(game.title));
} else {
  console.log('found game', game.id, JSON.stringify(game.title), '(passcodes left as they are)');
}

// 2. Students.
const { data: existing, error: eErr } = await supabase.from('pairs')
  .select('definition, sort_order').eq('game_id', game.id).is('deleted_at', null);
if (eErr) die('load students', eErr);
const have = new Set((existing || []).map(p => p.definition.toLowerCase()));
let order = Math.max(0, ...(existing || []).map(p => p.sort_order || 0));
let added = 0, skipped = 0;
for (const s of roster.students) {
  if (have.has(s.name.toLowerCase())) { skipped++; continue; }
  const buf = fs.readFileSync(path.join(dir, s.file));
  if (buf[0] !== 0xff || buf[1] !== 0xd8) die(s.file, 'not a JPEG');
  if (buf.length > 300 * 1024) die(s.file, 'larger than 300KB; crop and resize it first');
  const { data: pair, error: pErr } = await supabase.from('pairs').insert({
    game_id: game.id, term: '(photo)', definition: s.name, sort_order: ++order, photo_version: 1,
  }).select('id').single();
  if (pErr) die(`add ${s.name}`, pErr);
  const { error: phErr } = await supabase.from('pair_photos')
    .insert({ pair_id: pair.id, game_id: game.id, data: buf.toString('base64') });
  if (phErr) {
    await supabase.from('pairs').delete().eq('id', pair.id);
    die(`photo for ${s.name}`, phErr);
  }
  added++;
}
console.log(`students: ${added} added, ${skipped} already there, ${have.size + added} total`);
