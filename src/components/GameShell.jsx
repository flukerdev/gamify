import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Monogram from './Monogram.jsx';
import ProfileTab from './ProfileTab.jsx';
import LeaderboardTab from './LeaderboardTab.jsx';
import QuizzesTab from './QuizzesTab.jsx';
import TestsTab from './TestsTab.jsx';
import LearnTab from './LearnTab.jsx';
import EditPairs from './EditPairs.jsx';
import InviteFriends from './InviteFriends.jsx';
import OnboardingTour from './OnboardingTour.jsx';
import FlashcardsTab from './FlashcardsTab.jsx';
import ManageStudents from './ManageStudents.jsx';
import { setPhotoVersions, preloadPhotos } from '../photos.js';
import { rememberLink } from '../link.js';
import Loading from './Loading.jsx';

const TABS = [
  { id: 'profile',     label: 'Profile' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'quizzes',     label: 'Quizzes' },
  { id: 'tests',       label: 'Tests' },
  { id: 'learn',       label: 'Learn' },
  { id: 'invite',      label: 'Invite Friends' },
];

// Photo games lead with the flashcards.
const FACES_TABS = [
  { id: 'flashcards',  label: 'Flashcards' },
  { id: 'learn',       label: 'Learn' },
  { id: 'quizzes',     label: 'Daily Quiz' },
  { id: 'tests',       label: 'Daily Test' },
  { id: 'leaderboard', label: 'Leaderboard' },
  { id: 'profile',     label: 'My Progress' },
  { id: 'invite',      label: 'Invite' },
];

export default function GameShell({ user, gameId, onSwitchGame, onLogout }) {
  const [game, setGame] = useState(null);
  const [pairs, setPairs] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  // Leaderboard is the landing tab so users open straight into the rankings.
  const [tab, setTab] = useState('leaderboard');
  const [navOpen, setNavOpen] = useState(false);
  const [err, setErr] = useState('');
  const [showEditPairs, setShowEditPairs] = useState(false);
  const [showAdminPin, setShowAdminPin] = useState(false);

  // First-run tour: shown until users.onboarded_at is set. Spotlight names the
  // target group: 'rank' (leaderboard row) or 'activities' (Quiz/Test/Learn tabs).
  const isFaces = game?.kind === 'faces';
  const tabs = isFaces ? FACES_TABS : TABS;
  // The tour points at leaderboard rows and the invite flow; photo games open
  // on the flashcards instead and need no tour.
  const tourActive = !!game && !isFaces && !user.onboarded_at;
  const [tourSpotlight, setTourSpotlight] = useState(null);
  // Mirror tourSpotlight to a body data attribute so CSS can react to it from
  // anywhere — the leaderboard row spotlight reads it without prop drilling.
  useEffect(() => {
    if (tourSpotlight) document.body.setAttribute('data-tour-spotlight', tourSpotlight);
    else document.body.removeAttribute('data-tour-spotlight');
    return () => document.body.removeAttribute('data-tour-spotlight');
  }, [tourSpotlight]);
  // Open the mobile sidebar only on slide 2 (Quiz/Test/Learn spotlight). On
  // slide 1 the rank highlight lives on the leaderboard, so the sidebar must
  // be out of the way. Slide 3 has no spotlight — sidebar closed feels cleaner.
  useEffect(() => {
    if (!tourActive) return;
    setNavOpen(tourSpotlight === 'activities');
  }, [tourActive, tourSpotlight]);

  // Learn-session interception:
  //   learnActive: LearnTab tells us when it's mid-run.
  //   learnProgress: LearnTab tells us when the user has made progress
  //                  (a card mastered or graduated MC->TIO) this session.
  //                  If they navigate away with NO progress, we skip the
  //                  confirmation entirely and don't show the points popup.
  //   pendingNav: the tab the user TRIED to switch to while a session was active.
  //   exitStage: null | 'confirm' | 'points'
  //   exitPoints: number returned by the server on confirmExit().
  const [learnActive, setLearnActive] = useState(false);
  const [learnProgress, setLearnProgress] = useState(false);
  const [pendingNav, setPendingNav] = useState(null); // { kind: 'tab'|'switch'|'close', value }
  const [exitStage, setExitStage] = useState(null);
  const [exitPoints, setExitPoints] = useState(0);
  const learnExitRef = useRef({});

  async function loadGame() {
    setErr('');
    try {
      const { game, pairs, isAdmin } = await api.get(`/api/games/${gameId}`);
      if (game.kind === 'faces') {
        // Versions must be in place before any photo renders.
        setPhotoVersions(pairs || []);
        preloadPhotos(game.id, pairs || []);
        if (!landedRef.current) { landedRef.current = true; setTab('flashcards'); }
      }
      setGame(game); setPairs(pairs || []); setIsAdmin(isAdmin);
      loadedRef.current = true;
      lastLoadRef.current = Date.now();
    } catch (e) {
      // A dead session signs the person out (api.js); nothing to show here.
      // A failed REFRESH keeps showing what we already have; only a failed
      // first load has nothing to fall back on.
      if (e.status !== 401 && !loadedRef.current) setErr(e.message);
    }
  }
  const landedRef = useRef(false);
  const loadedRef = useRef(false);
  const lastLoadRef = useRef(0);
  useEffect(() => { landedRef.current = false; loadedRef.current = false; loadGame(); }, [gameId]);

  // An installed app stays open for days. Refresh the cards when the app
  // comes back to the foreground or the person switches tabs, so students the
  // admin added or re-photographed since show up (with their photos).
  function refreshIfStale() {
    if (loadedRef.current && Date.now() - lastLoadRef.current > 30000) loadGame();
  }
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refreshIfStale(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [gameId]);
  useEffect(() => { refreshIfStale(); }, [tab]);

  // The "X" inside LearnTab opens the same prompt. We expose openPrompt via
  // the same exitRef LearnTab fills. The X has no chosen destination, so
  // default to the Leaderboard after dismiss.
  useEffect(() => {
    learnExitRef.current.openPrompt = () => {
      if (!learnProgress) {
        // No progress yet — exit immediately to the Leaderboard, no prompt, no popup.
        applyNav({ kind: 'tab', value: 'leaderboard' });
        return;
      }
      setPendingNav({ kind: 'tab', value: 'leaderboard' });
      setExitStage('confirm');
    };
  }, [learnProgress]);

  // Centralised navigation: if Learn is active AND the user has made progress,
  // intercept anything that would leave Learn. No progress = silent exit.
  function tryNavigateTo(nav) {
    // Same-tab clicks don't actually leave Learn — no prompt needed.
    if (nav?.kind === 'tab' && nav.value === tab) {
      setNavOpen(false);
      return;
    }
    if (tab === 'learn' && learnActive && learnProgress) {
      setPendingNav(nav);
      setExitStage('confirm');
      return;
    }
    applyNav(nav);
  }
  function applyNav(nav) {
    setNavOpen(false);
    if (!nav) return;
    if (nav.kind === 'tab') setTab(nav.value);
    else if (nav.kind === 'switch') onSwitchGame();
    else if (nav.kind === 'logout') onLogout();
  }

  async function onConfirmExit() {
    let banked = 0;
    try {
      const r = await learnExitRef.current?.confirmExit?.();
      banked = Math.max(0, Math.round(Number(r?.bankedSinceLastExit || 0)));
    } catch {}
    if (banked > 0) {
      setExitPoints(banked);
      setExitStage('points');
    } else {
      // Progress was made but no card reached Mastered — no popup, just go.
      finishExitNav();
    }
  }
  function finishExitNav() {
    const nav = pendingNav || { kind: 'tab', value: 'leaderboard' };
    setExitStage(null);
    setPendingNav(null);
    applyNav(nav);
  }
  function onCancelExit() {
    setExitStage(null);
    setPendingNav(null);
  }

  if (err) return (
    <div className="hub"><main className="hub-main">
      <div className="form-error">{err}</div>
      <button className="btn btn-secondary" onClick={onSwitchGame}>Back</button>
    </main></div>
  );
  if (!game) return <div className="hub"><main className="hub-main"><Loading /></main></div>;

  return (
    <div className="shell">
      <button className="nav-toggle" onClick={() => setNavOpen(!navOpen)} aria-label="Menu">≡</button>
      {navOpen && !tourActive ? (
        <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" />
      ) : null}

      <aside className={`sidebar ${navOpen ? 'open' : ''} ${tourActive ? 'tour-active' : ''}`}>
        <div className="sidebar-top">
          {game.protected ? (
            // A passcode session belongs to this one game; nothing to switch to.
            <div className="game-switcher static">
              <Monogram name={game.title} size={40} />
              <div className="switcher-text">
                <div className="switcher-title">{game.title}</div>
              </div>
            </div>
          ) : (
            <button className="game-switcher"
              onClick={() => tryNavigateTo({ kind: 'switch' })}
              title="Switch game">
              <Monogram name={game.title} size={40} />
              <div className="switcher-text">
                <div className="switcher-title">{game.title}</div>
                <div className="switcher-sub">Switch ↗</div>
              </div>
            </button>
          )}
        </div>

        <nav className="nav-tabs">
          {tabs.map(t => {
            const spotlight =
              tourSpotlight === 'activities' && ['quizzes', 'tests', 'learn'].includes(t.id);
            return (
              <button key={t.id}
                className={`nav-tab ${tab===t.id?'active':''} ${spotlight ? 'tour-spotlight' : ''}`}
                onClick={() => tryNavigateTo({ kind: 'tab', value: t.id })}>
                {t.label}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          {isAdmin ? (
            <button className="btn btn-secondary small edit-pairs-btn"
              onClick={() => { setNavOpen(false); setShowEditPairs(true); }}>
              {isFaces ? 'Manage students' : 'Edit Pairs'}
            </button>
          ) : game.protected ? (
            <button className="btn btn-ghost small edit-pairs-btn"
              onClick={() => { setNavOpen(false); setShowAdminPin(true); }}>
              Admin
            </button>
          ) : null}
          <div className="me-row">
            <div className="me-name">{user.first_name} {user.last_name}</div>
            <button className="btn btn-ghost small" onClick={() => tryNavigateTo({ kind: 'logout' })}>Log out</button>
          </div>
          {game.protected ? null : <div className="share-row">Code: <b>{game.share_code}</b></div>}
        </div>
      </aside>

      <main className="content">
        {tab==='flashcards'  && <FlashcardsTab game={game} pairs={pairs}
                                  onGoLearn={() => setTab('learn')} />}
        {tab==='profile'     && <ProfileTab user={user} game={game} />}
        {tab==='leaderboard' && <LeaderboardTab user={user} game={game} />}
        {tab==='quizzes'     && <QuizzesTab user={user} game={game} pairs={pairs} onGoToLeaderboard={() => setTab('leaderboard')} />}
        {tab==='tests'       && <TestsTab    user={user} game={game} pairs={pairs} onGoToLeaderboard={() => setTab('leaderboard')} />}
        {tab==='learn'       && <LearnTab
                                  user={user} game={game}
                                  onExit={() => setTab('leaderboard')}
                                  onActiveChange={setLearnActive}
                                  onProgressChange={setLearnProgress}
                                  exitRef={learnExitRef} />}
        {tab==='invite'      && (
          <div className="tab-pad">
            <h1 className="tab-title">{isFaces ? 'Invite' : 'Invite Friends'}</h1>
            <p className="hub-sub">{isFaces
              ? 'Send this link to someone on staff.'
              : 'Inviting friends is what makes Gamify fun.'}</p>
            <InviteFriends game={game} />
          </div>
        )}
      </main>

      {exitStage === 'confirm' && (
        <ExitConfirmModal onCancel={onCancelExit} onConfirm={onConfirmExit} />
      )}
      {exitStage === 'points' && (
        <ExitPointsModal points={exitPoints} onClose={finishExitNav} />
      )}

      {showAdminPin && (
        <AdminPinModal game={game} user={user}
          onCancel={() => setShowAdminPin(false)}
          onUnlocked={async () => { setShowAdminPin(false); await loadGame(); setShowEditPairs(true); }} />
      )}

      {showEditPairs && (isFaces
        ? <ManageStudents game={game} pairs={pairs} user={user}
            onChanged={loadGame}
            onClose={() => { setShowEditPairs(false); loadGame(); }} />
        : <EditPairs gameId={gameId} onClose={() => { setShowEditPairs(false); loadGame(); }} />)}

      {tourActive && (
        <OnboardingTour
          onSpotlightChange={setTourSpotlight}
          onDone={(_u, opts) => {
            setTourSpotlight(null);
            if (opts?.takeQuiz) setTab('quizzes');
          }}
        />
      )}
    </div>
  );
}

// "Admin" in the menu: type the PIN once and this phone can manage students
// from then on.
function AdminPinModal({ game, user, onCancel, onUnlocked }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!pin.trim()) { setErr('Type the admin PIN.'); return; }
    setBusy(true); setErr('');
    try {
      await api.post(`/api/games/${game.id}/admin`, { pin: pin.trim() });
      rememberLink(pin.trim(), `${user.first_name}${user.last_name ? ` ${user.last_name}` : ''}`);
      await onUnlocked();
    } catch (e2) { setErr(e2.message || 'Could not check the PIN. Try again.'); setBusy(false); }
  }
  return (
    <div className="modal-wrap">
      <form className="modal small" onSubmit={submit}>
        <div className="modal-head"><h3>Admin</h3></div>
        <div className="modal-body">
          <label className="field-label" htmlFor="ad-pin">Admin PIN</label>
          <input id="ad-pin" className="text-input" value={pin} onChange={(e) => setPin(e.target.value)}
            inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false} autoFocus maxLength={24} />
          {err ? <div className="form-error" role="alert">{err}</div> : null}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Checking…' : 'Unlock'}</button>
        </div>
      </form>
    </div>
  );
}

function ExitConfirmModal({ onCancel, onConfirm }) {
  return (
    <div className="modal-wrap">
      <div className="modal small">
        <div className="modal-head"><h3>Exit Learn?</h3></div>
        <div className="modal-body">
          <p>Are you sure you want to exit Learn? Your progress will be saved.</p>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel}>Keep going</button>
          <button className="btn btn-primary" onClick={onConfirm}>Exit</button>
        </div>
      </div>
    </div>
  );
}

// Auto-dismiss popup. Shows for 2 seconds, then continues navigation to the
// user's chosen destination. No buttons — there's nothing for the user to do
// here but enjoy the points they just earned.
function ExitPointsModal({ points, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 2000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className="modal-wrap">
      <div className="modal small">
        <div className="modal-body points-popup">
          <div className="points-earned-label">Points earned</div>
          <div className="points-earned-num">+{points}</div>
          <div className="muted small">added to your score</div>
        </div>
      </div>
    </div>
  );
}
