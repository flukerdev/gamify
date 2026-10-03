import React, { useState } from 'react';
import { api } from '../api.js';
import { APP_NAME, BRAND_LETTER } from '../config.js';
import InstallTip from './InstallTip.jsx';

// Sign-in for the photo game: the shared passcode plus your name. The
// passcode decides which game you land in (and whether you can manage it);
// your name is how the leaderboard knows you.
export default function PasscodeLogin({ onSignedIn }) {
  const [passcode, setPasscode] = useState('');
  const [firstName, setFirst] = useState('');
  const [lastName, setLast] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setErr('');
    if (!passcode.trim()) { setErr('Enter the passcode.'); return; }
    if (!firstName.trim() || !lastName.trim()) { setErr('Enter your first and last name.'); return; }
    setBusy(true);
    try {
      const { user, game } = await api.post('/api/auth/passcode', { passcode, firstName, lastName });
      onSignedIn(user, game);
    } catch (e2) {
      setErr(e2.message || 'Could not sign in.');
      setBusy(false);
    }
  }

  // The keyboard's Next key should move down the form, not submit it early.
  function nextOnEnter(nextId) {
    return (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      document.getElementById(nextId)?.focus();
    };
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand">
          <div className="brand-mono">{BRAND_LETTER}</div>
          <div className="brand-title">{APP_NAME}</div>
        </div>
        <p className="auth-sub">Enter the passcode from your invite email and your name.</p>
        <form onSubmit={submit} className="auth-form" noValidate>
          <label className="field-label" htmlFor="pl-code">Passcode</label>
          <input id="pl-code" className="text-input" value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
            enterKeyHint="next" onKeyDown={nextOnEnter('pl-first')} />
          <label className="field-label" htmlFor="pl-first">First name</label>
          <input id="pl-first" className="text-input" value={firstName}
            onChange={(e) => setFirst(e.target.value)}
            autoCapitalize="words" autoCorrect="off" autoComplete="given-name" spellCheck={false}
            enterKeyHint="next" maxLength={40} onKeyDown={nextOnEnter('pl-last')} />
          <label className="field-label" htmlFor="pl-last">Last name</label>
          <input id="pl-last" className="text-input" value={lastName}
            onChange={(e) => setLast(e.target.value)}
            autoCapitalize="words" autoCorrect="off" autoComplete="family-name" spellCheck={false}
            enterKeyHint="go" maxLength={40} />
          {err ? <div className="form-error" role="alert">{err}</div> : null}
          <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Start'}
          </button>
          <div className="hint">
            Use the same name every time. That is how your points follow you to a new phone.
          </div>
        </form>
        <InstallTip />
      </div>
    </div>
  );
}
