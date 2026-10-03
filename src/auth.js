// Session lives in localStorage: the user row plus the signed session token
// the server issued at sign-in (sent as X-Session on every call; see
// api/_lib/session.js). The rest of the app reads getCurrentUser().

const KEY = 'gamify.user';
const TOKEN_KEY = 'gamify.token';
const GAME_KEY = 'gamify.currentGameId';

// Private browsing / locked-down browsers can throw on any storage access.
// Fall back to memory so the app still works for the life of the tab.
const mem = new Map();
function read(k) {
  try { return localStorage.getItem(k); } catch { return mem.has(k) ? mem.get(k) : null; }
}
function write(k, v) {
  try {
    if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  } catch {
    if (v == null) mem.delete(k); else mem.set(k, v);
  }
}

const listeners = new Set();
function emit() { listeners.forEach(fn => fn()); }
export function onAuthChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function getCurrentUser() {
  // A user without a token is a session from before tokens existed; treat it
  // as signed out so the person lands on the sign-in screen, not on errors.
  if (!read(TOKEN_KEY)) return null;
  try { return JSON.parse(read(KEY) || 'null'); }
  catch { return null; }
}
export function setCurrentUser(user) {
  write(KEY, user ? JSON.stringify(user) : null);
  emit();
}

export function getToken() { return read(TOKEN_KEY) || null; }
// Called by the api wrapper whenever a response carries a fresh token.
export function setToken(token) { write(TOKEN_KEY, token || null); }

export function logout() {
  write(KEY, null);
  write(TOKEN_KEY, null);
  write(GAME_KEY, null);
  emit();
}

export function getCurrentGameId() {
  return read(GAME_KEY) || null;
}
export function setCurrentGameId(id) {
  write(GAME_KEY, id || null);
  emit();
}
