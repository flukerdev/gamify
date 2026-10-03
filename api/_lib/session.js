// Signed sessions + passcode hashing.
//
// Every API call carries an `X-Session` token: base64url(JSON payload) + '.' +
// base64url(HMAC-SHA256). The server never trusts a bare user id any more, so
// knowing someone's id (the leaderboard exposes them) is not enough to act as
// them.
//
// Payload:
//   u   user id
//   g   game id          (passcode sign-ins only)
//   cv  code_version     (passcode sign-ins only; a passcode change bumps it
//                         and thereby signs every device out)
//   a   1 when the ADMIN passcode was used (passcode sign-ins only)
//   iat issued-at (ms)
import crypto from 'node:crypto';

function secret() {
  const base = process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base) {
    const e = new Error('Server is missing a session secret.'); e.status = 500; throw e;
  }
  return crypto.createHash('sha256').update(`gamify-session:${base}`).digest();
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signSession(payload) {
  const body = b64u(JSON.stringify({ ...payload, iat: Date.now() }));
  const sig = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.u !== 'string') return null;
    return payload;
  } catch { return null; }
}

// Passcodes are compared case-insensitively and ignore spaces, so "Sts 2026"
// and "sts2026" are the same passcode. Keep in sync with the SQL used to seed
// a protected game:
//   encode(digest('gamify-passcode:' || lower(regexp_replace(code, '\s+', '', 'g')), 'sha256'), 'hex')
export function normalizePasscode(input) {
  return String(input ?? '').replace(/\s+/g, '').toLowerCase();
}
export function hashPasscode(input) {
  return crypto.createHash('sha256')
    .update(`gamify-passcode:${normalizePasscode(input)}`).digest('hex');
}

// Collapse a typed name to its display form ("  mary   laura " -> "mary laura").
// A name typed entirely in lowercase is capitalized ("pat smith" -> "Pat
// Smith"); anything with its own capitals ("McKenzie", "JD") is left alone.
export function cleanName(input) {
  const s = String(input ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (s && s === s.toLowerCase()) {
    return s.replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
  }
  return s;
}
// Identity key for name-based sign-in within one game.
export function loginKey(gameId, firstName, lastName) {
  return `${gameId}:${cleanName(firstName).toLowerCase()}|${cleanName(lastName).toLowerCase()}`;
}
