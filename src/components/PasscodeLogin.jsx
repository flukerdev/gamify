import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { APP_NAME, BRAND_LETTER } from '../config.js';
import { readLinkFromUrl, storedLink, rememberLink, autoAllowed } from '../link.js';
import InstallTip from './InstallTip.jsx';
import Loading from './Loading.jsx';

// "First Last" -> { firstName: 'First', lastName: 'Last' }; one word is fine.
function splitName(full) {
  const parts = String(full || '').replace(/\s+/g, ' ').trim().split(' ');
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

// Sign-in for the photo game: type your name, tap Start. That is the whole
// thing. The admin taps "Admin" first and adds the PIN. If the address already
// carries the person's name (the home-screen app), there is nothing to type.
export default function PasscodeLogin({ onSignedIn }) {
  const fromUrl = useRef(readLinkFromUrl()).current;
  const saved = useRef(storedLink()).current;

  const [name, setName] = useState(fromUrl.n || saved.n || '');
  const [pin, setPin] = useState('');
  const [adminOpen, setAdminOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [auto, setAuto] = useState(() => !!(fromUrl.n && autoAllowed()));

  async function signIn(fullName, adminPin) {
    const { firstName, lastName } = splitName(fullName);
    const body = { firstName, lastName };
    if (adminPin) body.passcode = adminPin;
    const { user, game } = await api.post('/api/auth/passcode', body);
    // Remember the name as the server spelled it ("mary ann" -> "Mary Ann").
    rememberLink(adminPin || '', `${user.first_name || firstName}${user.last_name ? ` ${user.last_name}` : ''}`);
    onSignedIn(user, game);
  }

  // The address already says who this is: sign in without asking anything.
  const tried = useRef(false);
  useEffect(() => {
    if (!auto || tried.current) return;
    tried.current = true;
    (async () => {
      try {
        await signIn(fromUrl.n, fromUrl.k);
      } catch (e) {
        // An old admin PIN in the address must never lock someone out: come
        // in as a regular player instead.
        if (e.status === 401 && fromUrl.k) {
          try { await signIn(fromUrl.n, ''); return; } catch { /* fall through to the form */ }
        }
        setAuto(false);
      }
    })();
  }, [auto]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setErr('');
    if (!name.trim()) { setErr('Type your name.'); return; }
    if (adminOpen && !pin.trim()) { setErr('Type the admin PIN, or tap Cancel.'); return; }
    setBusy(true);
    try {
      await signIn(name, adminOpen ? pin.trim() : '');
    } catch (e2) {
      setErr(e2.message || 'Could not sign in. Try again.');
      setBusy(false);
    }
  }

  if (auto) return <div className="auth-wrap"><Loading /></div>;

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand">
          <div className="brand-mono">{BRAND_LETTER}</div>
          <div className="brand-title">{APP_NAME}</div>
        </div>
        <form onSubmit={submit} className="auth-form" noValidate>
          <label className="field-label big" htmlFor="pl-name">What is your name?</label>
          <input id="pl-name" className="text-input" value={name}
            onChange={(e) => setName(e.target.value)}
            autoCapitalize="words" autoCorrect="off" autoComplete="name" spellCheck={false}
            enterKeyHint="go" maxLength={60} placeholder="First and last name" />
          {adminOpen ? (
            <>
              <label className="field-label" htmlFor="pl-pin">Admin PIN</label>
              <input id="pl-pin" className="text-input" value={pin}
                onChange={(e) => setPin(e.target.value)}
                inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false}
                enterKeyHint="go" maxLength={24} />
            </>
          ) : null}
          {err ? <div className="form-error" role="alert">{err}</div> : null}
          <button className="btn btn-primary big auth-submit" type="submit" disabled={busy}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </form>
        <button type="button" className="admin-toggle"
          onClick={() => { setAdminOpen(o => !o); setPin(''); setErr(''); }}>
          {adminOpen ? 'Cancel admin sign-in' : 'I am the admin'}
        </button>
        <InstallTip />
      </div>
    </div>
  );
}
