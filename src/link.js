// Invite links for photo games: /?k=<code>&n=<name>.
//
//   k  the link code. The staff code lets you in; the admin code also opens
//      the Manage screen. Nobody ever types it: it rides in the link.
//   n  the person's name, added to the address after they sign in.
//
// Why the name goes in the address: on an iPhone, a web app added to the home
// screen starts from the address it was added from and has its own separate
// storage. With k and n in that address, the home-screen app signs the person
// in by itself, so they type their name once, ever.
const KEY = 'gamify.linkKey';
const NAME = 'gamify.linkName';
const NO_AUTO = 'gamify.noAuto';

const mem = new Map();
function get(k) { try { return localStorage.getItem(k); } catch { return mem.get(k) ?? null; } }
function set(k, v) {
  try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
  catch { if (v == null) mem.delete(k); else mem.set(k, v); }
}

export function readLinkFromUrl() {
  try {
    const u = new URL(window.location.href);
    return { k: (u.searchParams.get('k') || '').trim(), n: (u.searchParams.get('n') || '').trim() };
  } catch { return { k: '', n: '' }; }
}
export function storedLink() {
  return { k: get(KEY) || '', n: get(NAME) || '' };
}

// Remember the working link on this device and put it in the address bar.
export function rememberLink(k, name) {
  if (k) set(KEY, k);
  if (name) set(NAME, name);
  set(NO_AUTO, null);
  syncLinkToUrl();
}
export function syncLinkToUrl() {
  const { k, n } = storedLink();
  if (!k) return;
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.get('k') === k && (u.searchParams.get('n') || '') === n) return;
    u.searchParams.set('k', k);
    if (n) u.searchParams.set('n', n); else u.searchParams.delete('n');
    window.history.replaceState({}, '', u.toString());
  } catch { /* address bar is a nicety, never a requirement */ }
}

// After an explicit "Log out" the app must not sign straight back in from
// the address.
export function setNoAuto() { set(NO_AUTO, '1'); }
export function autoAllowed() { return get(NO_AUTO) !== '1'; }

// Accepts a pasted invite link or a bare code.
export function codeFromInput(text) {
  const t = String(text || '').trim();
  try {
    const k = new URL(t).searchParams.get('k');
    if (k) return k.trim();
  } catch { /* not a URL */ }
  const m = /[?&]k=([^&\s]+)/.exec(t);
  return m ? decodeURIComponent(m[1]) : t;
}

export function memberLink(code) {
  if (typeof window === 'undefined') return `/?k=${code}`;
  const u = new URL(window.location.origin);
  u.searchParams.set('k', code);
  return u.toString();
}
