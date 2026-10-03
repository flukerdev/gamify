// Single Supabase client for the API (service-role key, server-only).
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  // Don't throw at import time on Vercel cold start (would 500 every route);
  // throw on first use so the message reaches the response.
  console.warn('[gamify] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.');
}

export const supabase = createClient(url || 'http://localhost', key || 'placeholder', {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 'service' | 'anon' | 'unknown'. Legacy Supabase keys are JWTs with a `role`
// claim; the newer ones are prefixed (sb_secret_... / sb_publishable_...).
export function keyKind(k = key) {
  if (!k) return 'unknown';
  if (k.startsWith('sb_secret_')) return 'service';
  if (k.startsWith('sb_publishable_')) return 'anon';
  try {
    const role = JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString('utf8')).role;
    if (role === 'service_role') return 'service';
    if (role === 'anon') return 'anon';
  } catch { /* not a JWT */ }
  return 'unknown';
}

export function assertEnv() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const err = new Error('Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    err.status = 500;
    throw err;
  }
  // The anon key is public by design. With RLS on it reads nothing, and it
  // must never be what session tokens are signed with.
  if (keyKind() === 'anon') {
    const err = new Error('Server is misconfigured: SUPABASE_SERVICE_ROLE_KEY holds the anon key.');
    err.status = 500;
    throw err;
  }
}
