import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { APP_NAME, BRAND_LETTER } from '../config.js';
import {
  readLinkFromUrl, storedLink, rememberLink, autoAllowed, codeFromInput,
} from '../link.js';
import InstallTip from './InstallTip.jsx';
import Loading from './Loading.jsx';

// "First Last" -> { firstName: 'First', lastName: 'Last' }; one word is fine.
function splitName(full) {
  const parts = String(full || '').replace(/\s+/g, ' ').trim().split(' ');
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

// Sign-in for the photo game. People arrive by invite link (/?k=<code>), so
// the only thing they ever type is their name, once. If the address already
// carries their name too (the home-screen app), they are signed in with no
// typing at all.
export default function PasscodeLogin({ onSignedIn }) {
  const fromUrl = useRef(readLinkFromUrl()).current;
  const saved = useRef(storedLink()).current;
  const linkKey = fromUrl.k || saved.k;

  const [name, setName] = useState(fromUrl.n || saved.n || '');
  const [pasted, setPasted] = useState('');
  const [keyRejected, setKeyRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [auto, setAuto] = useState(() => !!(fromUrl.k && fromUrl.n && autoAllowed()));
  const needsLink = !linkKey || keyRejected;

  async function signIn(key, fullName) {
    const { firstName, lastName } = splitName(fullName);
    const { user, game } = await api.post('/api/auth/passcode', { passcode: key, firstName, lastName });
    // Remember the name as the server spelled it ("mary ann" -> "Mary Ann").
    rememberLink(key, `${user.first_name || firstName}${user.last_name ? ` ${user.last_name}` : ''}`);
    onSignedIn(user, game);
  }

  // The address already says who this is: sign in without asking anything.
  const tried = useRef(false);
  useEffect(() => {
    if (!auto || tried.current) return;
    tried.current = true;
    signIn(fromUrl.k, fromUrl.n).catch((e) => {
      if (e.status === 401) setKeyRejected(true);
      setErr(e.status === 401 ? 'That link has been replaced. Paste the new one below.' : (e.message || 'Could not sign in.'));
      setAuto(false);
    });
  }, [auto]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setErr('');
    const key = needsLink ? codeFromInput(pasted) : linkKey;
    if (!key) { setErr('Paste the invite link you were sent.'); return; }
    if (!name.trim()) { setErr('Type your name.'); return; }
    setBusy(true);
    try {
      await signIn(key, name);
    } catch (e2) {
      if (e2.status === 401) {
        setKeyRejected(true);
        setErr(needsLink ? 'That link did not work. Check it and try again.' : 'That link has been replaced. Paste the new one below.');
      } else {
        setErr(e2.message || 'Could not sign in.');
      }
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
        <p className="auth-sub">
          {needsLink ? 'Paste your invite link, then type your name.' : 'Type your name to get started.'}
        </p>
        <form onSubmit={submit} className="auth-form" noValidate>
          {needsLink ? (
            <>
              <label className="field-label" htmlFor="pl-code">Invite link</label>
              <input id="pl-code" className="text-input" value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false}
                placeholder="Paste the link here" />
            </>
          ) : null}
          <label className="field-label" htmlFor="pl-name">Your name</label>
          <input id="pl-name" className="text-input" value={name}
            onChange={(e) => setName(e.target.value)}
            autoCapitalize="words" autoCorrect="off" autoComplete="name" spellCheck={false}
            enterKeyHint="go" maxLength={60} placeholder="First and last name" />
          {err ? <div className="form-error" role="alert">{err}</div> : null}
          <button className="btn btn-primary auth-submit" type="submit" disabled={busy}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </form>
        <InstallTip />
      </div>
    </div>
  );
}
