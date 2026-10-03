// How a phone remembers who it is, for the photo game.
//
// After someone signs in, the address becomes /?n=<their name> (plus
// &k=<admin PIN> on the admin's own phone). On an iPhone, a web app added to
// the home screen starts from the address it was added from and has its own
// separate storage, so with the name in that address the home-screen app
// signs the person in by itself. They type their name once, ever.
//
// The link you SHARE is always the plain address with nothing after it.
const PIN = 'gamify.adminPin';
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
  return { k: get(PIN) || '', n: get(NAME) || '' };
}

// Remember this person (and the admin PIN, if they used one) on this device,
// and reflect it in the address bar. Pass pin = '' to forget a stored PIN.
export function rememberLink(pin, name) {
  if (pin != null) set(PIN, pin || null);
  if (name) set(NAME, name);
  set(NO_AUTO, null);
  syncLinkToUrl();
}
export function syncLinkToUrl() {
  const { k, n } = storedLink();
  if (!n) return;
  try {
    const u = new URL(window.location.href);
    if ((u.searchParams.get('n') || '') === n && (u.searchParams.get('k') || '') === k) return;
    u.searchParams.set('n', n);
    if (k) u.searchParams.set('k', k); else u.searchParams.delete('k');
    window.history.replaceState({}, '', u.toString());
  } catch { /* the address bar is a nicety, never a requirement */ }
}

// After an explicit "Log out" the app must not sign straight back in from
// the address.
export function setNoAuto() { set(NO_AUTO, '1'); }
export function autoAllowed() { return get(NO_AUTO) !== '1'; }

// The link to share: the plain address.
export function memberLink() {
  if (typeof window === 'undefined') return '/';
  return `${window.location.origin}/`;
}
