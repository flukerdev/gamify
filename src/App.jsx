import React, { useEffect, useState } from 'react';
import {
  getCurrentUser, setCurrentUser, getCurrentGameId, setCurrentGameId, onAuthChange, logout,
} from './auth.js';
import { api } from './api.js';
import LoginScreen from './components/LoginScreen.jsx';
import PasscodeLogin from './components/PasscodeLogin.jsx';
import CompleteProfile from './components/CompleteProfile.jsx';
import GameHub from './components/GameHub.jsx';
import GameShell from './components/GameShell.jsx';
import InviteJoin from './components/InviteJoin.jsx';

function readInviteCodeFromUrl() {
  if (typeof window === 'undefined') return null;
  try {
    const u = new URL(window.location.href);
    const code = (u.searchParams.get('invite') || '').trim().toUpperCase();
    return code || null;
  } catch { return null; }
}

// The original phone-number sign-in for classic Gamify games stays reachable
// at /?legacy=1. The front door is the passcode sign-in.
function wantsLegacyLogin() {
  if (typeof window === 'undefined') return false;
  try { return new URL(window.location.href).searchParams.get('legacy') === '1'; }
  catch { return false; }
}

function clearInviteFromUrl() {
  if (typeof window === 'undefined') return;
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete('invite');
    window.history.replaceState({}, '', u.toString());
  } catch {}
}

export default function App() {
  const [user, setUser] = useState(getCurrentUser());
  const [gameId, setGameId] = useState(getCurrentGameId());
  const [inviteCode, setInviteCode] = useState(readInviteCodeFromUrl());
  const [autoJoinError, setAutoJoinError] = useState('');

  useEffect(() => onAuthChange(() => {
    setUser(getCurrentUser());
    setGameId(getCurrentGameId());
  }), []);

  // Refresh the cached user on mount so fields added after this client cached
  // (e.g. onboarded_at) become visible without forcing a re-login.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api.get('/api/auth/me').then(({ user: fresh }) => {
      if (cancelled || !fresh) return;
      setCurrentUser(fresh);
    }).catch(() => { /* network: keep the cached user. A dead session (401) signs out in api.js. */ });
    return () => { cancelled = true; };
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If a logged-in returning user lands on an invite link, use their stored
  // session to join the game instead of forcing them through the phone form.
  useEffect(() => {
    if (!inviteCode || !user) return;
    let cancelled = false;
    api.post('/api/games/join', { shareCode: inviteCode }).then(({ game }) => {
      if (cancelled) return;
      setCurrentGameId(game.id);
      clearInviteFromUrl();
      setInviteCode(null);
    }).catch(e => {
      if (cancelled) return;
      setAutoJoinError(e.message || 'Could not join this game.');
    });
    return () => { cancelled = true; };
  }, [inviteCode, user]);

  // Auto-pick the user's only game so they land straight on the Daily Quiz.
  // If they're in 0 games we fall through to GameHub; >1 also stays on GameHub
  // so they can pick.
  useEffect(() => {
    if (!user || !user.first_name || gameId || inviteCode) return;
    let cancelled = false;
    api.get('/api/me/games').then(({ games }) => {
      if (cancelled) return;
      if (games && games.length === 1) setCurrentGameId(games[0].id);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [user, gameId, inviteCode]);

  // New phone hitting an invite link with no session: keep the existing
  // phone-first invite flow. (Logged-in users are handled by the effect above.)
  if (inviteCode && !user) {
    return (
      <InviteJoin
        shareCode={inviteCode}
        onJoined={(u, game) => {
          setCurrentUser(u);
          setCurrentGameId(game.id);
          clearInviteFromUrl();
          setInviteCode(null);
        }} />
    );
  }
  if (inviteCode && user) {
    if (autoJoinError) {
      return (
        <div className="hub"><main className="hub-main">
          <div className="form-error">{autoJoinError}</div>
          <button className="btn btn-secondary"
            onClick={() => { clearInviteFromUrl(); setInviteCode(null); setAutoJoinError(''); }}>
            Continue
          </button>
        </main></div>
      );
    }
    return <div className="hub"><main className="hub-main"><div className="empty">Joining game…</div></main></div>;
  }

  if (!user) {
    if (wantsLegacyLogin()) {
      return <LoginScreen onSignedIn={(u) => { setCurrentUser(u); }} />;
    }
    return (
      <PasscodeLogin onSignedIn={(u, game) => {
        setCurrentGameId(game.id);
        setCurrentUser(u);
      }} />
    );
  }
  if (!user.first_name || !user.last_name) {
    return <CompleteProfile user={user} onDone={(u) => setCurrentUser(u)} />;
  }
  if (!gameId) {
    return <GameHub user={user} onPick={(id) => setCurrentGameId(id)} onLogout={logout} />;
  }
  return (
    <GameShell
      user={user}
      gameId={gameId}
      onSwitchGame={() => setCurrentGameId(null)}
      onLogout={logout}
    />
  );
}
