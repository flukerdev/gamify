import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { similarity, isExactMatch, normalizeForCompare } from '../utils/similarity.js';
import {
  CARDS_PER_SESSION, SIMILARITY_THRESHOLD,
  RECENT_SESSIONS_CHART_COUNT, LEARN_RUN_POINTS,
} from '../config.js';
import SessionChart from './SessionChart.jsx';
import Loading from './Loading.jsx';
import FacePhoto from './FacePhoto.jsx';

// Phases of the local UI state machine:
//  - 'answering' : user is on a card (MC: picking; TIO: typing)
//  - 'graded'    : just answered, showing color feedback + (TIO) override button
//  - 'session'   : finished a session of 10, showing the progress screen
//  - 'complete'  : all cards mastered; run complete celebration
//  - 'empty'     : not enough content to learn
//
// Exit confirmation lives in GameShell (it is also triggered by sidebar nav
// clicks while a session is active). LearnTab tells the shell its state via
// onActiveChange and onProgressChange, and exposes a confirmExit() method
// through `exitRef`.
export default function LearnTab({ game, onExit, onActiveChange, onProgressChange, exitRef }) {
  const [state, setState] = useState(null);
  const [nextCard, setNextCard] = useState(null);
  const [buckets, setBuckets] = useState({ mastered: 0, learning: 0, toBeLearned: 0 });
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [phase, setPhase] = useState('answering');
  const [err, setErr] = useState('');
  const [graded, setGraded] = useState(null);
  const [sessionSummary, setSessionSummary] = useState(null);
  const [progressSegs, setProgressSegs] = useState([]);
  const [tioInput, setTioInput] = useState('');
  const [animKey, setAnimKey] = useState(0);

  // Always-fresh refs the shell can use without re-binding.
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // "Progress this session" = at least one card mastered OR at least one card
  // advanced MC -> TIO since the user opened Learn. A wrong answer alone is
  // NOT progress. Shell uses this to decide whether to show the exit prompt.
  const progressRef = useRef(false);
  function markProgress() {
    if (!progressRef.current) {
      progressRef.current = true;
      onProgressChange?.(true);
    }
  }

  // Points actually banked to the ledger during THIS Learn visit. We sum the
  // server's per-answer `pointsEarned` (which is 0 for an already-paid card)
  // rather than trusting a server-side "since last exit" watermark — that
  // watermark only advanced on one exit path and reset on a new run, so it
  // drifted and made the exit popup overstate (e.g. showed "+5" for points
  // earned across earlier sessions). Resets to 0 on each mount / game switch.
  const sessionBankedRef = useRef(0);

  async function load() {
    try {
      const r = await api.get(`/api/games/${game.id}/learn`);
      setState(r.state); setNextCard(r.nextCard); setBuckets(r.buckets);
      setSecondsRemaining(r.secondsRemaining);
      setProgressSegs(makeFreshSegs(r.state));
      // A (re)load always starts on a clean card: nothing typed, nothing graded.
      setGraded(null); setTioInput(''); setAnimKey(k => k + 1);
      if (!r.nextCard) setPhase('complete');
      else setPhase('answering');
    } catch (e) {
      if (e.status === 400) setPhase('empty');
      else setErr(e.message);
    }
  }
  useEffect(() => {
    progressRef.current = false;
    sessionBankedRef.current = 0;
    onProgressChange?.(false);
    load();
  }, [game.id]);

  // Tell the shell when we're "active" (i.e. mid-run with cards to answer).
  // The shell uses this to intercept sidebar nav clicks.
  useEffect(() => {
    const active = !!(state && phase !== 'empty' && phase !== 'complete');
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [state, phase]);

  // Expose a confirmExit() the shell can invoke on exit. The popup figure is
  // the points actually banked this visit (sessionBankedRef), not the server's
  // watermark. We still POST /learn/exit so the server keeps its own bookkeeping
  // consistent, but we ignore its returned figure for display.
  // The shell also installs an openPrompt() on the same ref — patch, don't
  // overwrite.
  useEffect(() => {
    if (!exitRef) return;
    exitRef.current = exitRef.current || {};
    exitRef.current.confirmExit = async () => {
      const banked = sessionBankedRef.current;
      try { await api.post(`/api/games/${game.id}/learn/exit`, {}); } catch { /* bookkeeping only */ }
      return { bankedSinceLastExit: banked };
    };
  }, [exitRef, game.id]);

  function makeFreshSegs(s) {
    const answered = s?.currentSessionAnswered || 0;
    return Array.from({ length: CARDS_PER_SESSION }, (_, i) => i < answered ? 'done' : 'idle');
  }

  const isFaces = game.kind === 'faces';

  if (err) return (
    <div className="tab-pad">
      <div className="form-error">{err}</div>
      <button className="btn btn-secondary" onClick={() => { setErr(''); load(); }}>Try again</button>
    </div>
  );
  if (phase === 'empty') {
    return (
      <div className="tab-pad">
        <h1 className="tab-title">Learn</h1>
        <div className="empty-card">
          <h3>Nothing to learn yet</h3>
          <p>{isFaces
            ? 'Once students are added, you can learn their names here.'
            : 'The admin needs to add at least one term and definition to this game.'}</p>
        </div>
      </div>
    );
  }
  if (!state) return <Loading />;

  const sessionIdx = (state.currentSessionAnswered || 0);

  async function commitAnswer(isCorrect) {
    setProgressSegs(segs => {
      const next = segs.slice();
      next[sessionIdx] = isCorrect ? 'correct' : 'incorrect';
      return next;
    });
    try {
      const r = await api.post(`/api/games/${game.id}/learn/answer`, {
        pairId: nextCard.pairId, isCorrect,
      });
      setState(r.state); setBuckets(r.buckets); setSecondsRemaining(r.secondsRemaining);
      if (r.pointsEarned) sessionBankedRef.current += Number(r.pointsEarned);
      if (r.graduated || r.mastered) markProgress();
      if (r.sessionSummary) {
        setSessionSummary(r.sessionSummary);
        setNextCard(r.nextCard);
        setPhase('session');
        return;
      }
      if (r.runComplete) {
        setPhase('complete');
        setNextCard(null);
        return;
      }
      setNextCard(r.nextCard);
      setGraded(null);
      setTioInput('');
      setAnimKey(k => k + 1);
      setPhase('answering');
    } catch (e) { setErr(e.message); }
  }

  // ------------------------------------------------------------------- MC
  function pickMcOption(opt) {
    if (phase !== 'answering') return;
    const correct = opt === nextCard.correctAnswer;
    setGraded({ isCorrect: correct, exact: true, userAnswer: opt, correctAnswer: nextCard.correctAnswer, chosenOpt: opt });
    setPhase('graded');
    setTimeout(() => commitAnswer(correct), 750);
  }

  // ------------------------------------------------------------------- TIO
  function submitTio(e) {
    e?.preventDefault();
    if (phase !== 'answering' || !nextCard) return;
    const userAnswer = tioInput;
    // A name typed in a different case ("shep") is still exactly right.
    const exact = isFaces
      ? normalizeForCompare(userAnswer) === normalizeForCompare(nextCard.correctAnswer)
      : isExactMatch(userAnswer, nextCard.correctAnswer);
    // Exact match -> auto-advance immediately. Brief green flash via the
    // 'graded' phase so the user sees confirmation, then we commit.
    if (exact) {
      setGraded({ isCorrect: true, exact: true, userAnswer, correctAnswer: nextCard.correctAnswer, overridden: true });
      setPhase('graded');
      setTimeout(() => commitAnswer(true), 450);
      return;
    }
    const sim = similarity(userAnswer, nextCard.correctAnswer);
    const isCorrect = sim >= SIMILARITY_THRESHOLD;
    setGraded({ isCorrect, exact, userAnswer, correctAnswer: nextCard.correctAnswer });
    setPhase('graded');
  }

  // Override flips the verdict and auto-advances. The brief delay lets the
  // user register the verdict flip before the next card slides in.
  function overrideTio() {
    if (!graded || graded.overridden) return;
    const flipped = !graded.isCorrect;
    setGraded({ ...graded, isCorrect: flipped, overridden: true, exact: false });
    setTimeout(() => commitAnswer(flipped), 350);
  }

  // Continue keeps the current verdict and auto-advances immediately.
  function continueTio() {
    if (!graded) return;
    commitAnswer(graded.isCorrect);
  }

  // ------------------------------------------------------------- Session next
  async function continueAfterSession() {
    setSessionSummary(null);
    if (!nextCard) {
      const allMastered = Object.values(state.cards || {}).every(c => c.mastered);
      if (allMastered) { setPhase('complete'); return; }
      await load();
      return;
    }
    setProgressSegs(Array.from({ length: CARDS_PER_SESSION }, () => 'idle'));
    setGraded(null); setTioInput(''); setAnimKey(k => k + 1);
    setPhase('answering');
  }

  // ------------------------------------------------------------- Exit
  function askExit() {
    // Funnel through the shell so the popup logic lives in one place.
    onActiveChange?.(true); // ensure shell knows we're active
    // The shell exposes a `requestExit` via the same callback contract — but
    // for the explicit "X" button we just trigger the same prompt by calling
    // onExit's "request" channel. Implementation here defers to the shell.
    if (exitRef?.current?.openPrompt) exitRef.current.openPrompt();
  }

  async function resetAndStart() {
    await api.post(`/api/games/${game.id}/learn/reset`, {});
    await load();
  }

  // ----------------------------------------------------------- Render
  return (
    <div className="learn-wrap">
      <header className="learn-head">
        <div className="learn-title">Learn · {game.title}</div>
        <button className="icon-btn close" onClick={askExit} aria-label="Exit">×</button>
      </header>

      <ProgressBar segs={progressSegs} />

      <div className="learn-body">
        {phase === 'complete' ? (
          <RunComplete total={state.totalCards} onReset={resetAndStart} onLeaderboard={onExit} />
        ) : phase === 'session' ? (
          <SessionScreen
            summary={sessionSummary}
            history={state.sessionHistory || []}
            buckets={buckets}
            secondsRemaining={secondsRemaining}
            onContinue={continueAfterSession}
          />
        ) : nextCard ? (
          <CardView
            animKey={animKey}
            gameId={game.id}
            isFaces={isFaces}
            card={nextCard}
            graded={graded}
            tioInput={tioInput}
            onPickMc={pickMcOption}
            onChangeTio={setTioInput}
            onSubmitTio={submitTio}
            onOverride={overrideTio}
            onContinue={continueTio}
          />
        ) : <Loading />}
      </div>
    </div>
  );
}

function ProgressBar({ segs }) {
  return (
    <div className="prog-bar" role="progressbar" aria-label="Session progress">
      {segs.map((s, i) => <div key={i} className={`prog-seg ${s}`} />)}
    </div>
  );
}

function CardView({ animKey, gameId, isFaces, card, graded, tioInput, onPickMc, onChangeTio, onSubmitTio, onOverride, onContinue }) {
  // Photo games show the student's photo where a text game shows the prompt.
  const prompt = isFaces
    ? <FacePhoto gameId={gameId} pairId={card.pairId} className="card-photo" />
    : <div className="card-prompt">{card.prompt}</div>;

  if (card.kind === 'mc') {
    return (
      <div className="card-stage" key={animKey}>
        <div className="card-kind-pill">{isFaces ? 'Who is this?' : 'Multiple choice'}</div>
        {prompt}
        <div className="mc-options">
          {card.options.map((opt, i) => {
            let cls = 'mc-opt';
            if (graded) {
              if (opt === card.correctAnswer) cls += ' correct';
              else if (opt === graded.chosenOpt && !graded.isCorrect) cls += ' incorrect';
            }
            return (
              <button
                key={i}
                className={cls}
                disabled={!!graded}
                onClick={() => onPickMc(opt)}>{opt}</button>
            );
          })}
        </div>
        {graded ? (
          <div className={`flash ${graded.isCorrect ? 'flash-ok' : 'flash-no'}`}>
            {graded.isCorrect ? '✓' : '×'}
          </div>
        ) : null}
      </div>
    );
  }

  // type-it-out
  return (
    <div className="card-stage" key={animKey}>
      <div className="card-kind-pill">{isFaces ? 'Type the name' : 'Type it out'}</div>
      {prompt}

      {!graded ? (
        <form onSubmit={onSubmitTio} className="tio-form">
          {isFaces ? (
            // Single line so the keyboard's Go key checks the answer.
            <input
              className="text-input"
              value={tioInput}
              onChange={(e)=>onChangeTio(e.target.value)}
              autoFocus
              autoCapitalize="words" autoCorrect="off" autoComplete="off" spellCheck={false}
              enterKeyHint="go"
              placeholder="Type their name…"
            />
          ) : (
            <textarea
              className="text-input area tio-input"
              value={tioInput}
              onChange={(e)=>onChangeTio(e.target.value)}
              autoFocus
              placeholder="Type your answer…"
            />
          )}
          <button className="btn btn-primary" type="submit" disabled={!tioInput.trim()}>Check</button>
        </form>
      ) : (
        <div className="tio-result">
          <div className={`tio-answer ${graded.isCorrect ? 'ok' : 'no'}`}>
            <div className="tio-label">Your answer</div>
            <div className="tio-text">{graded.userAnswer || <span className="muted">(blank)</span>}</div>
          </div>
          {!graded.isCorrect ? (
            <div className="tio-correct">
              <div className="tio-label">Correct answer</div>
              <div className="tio-text ok">{graded.correctAnswer}</div>
            </div>
          ) : null}

          {/* Two-button TIO result rules:
              - graded incorrect            -> [I was actually correct] [Continue]
              - graded correct (non-exact)  -> [I was actually incorrect] [Continue]
              - graded correct AND exact    -> auto-advanced before render (no buttons)
              Continue keeps the current verdict; Override flips it. Both auto-
              advance to the next card. */}
          {graded.overridden ? null : !graded.isCorrect ? (
            <div className="tio-actions">
              <button className="btn btn-secondary tio-action" onClick={onOverride}>I was actually correct</button>
              <button className="btn btn-primary tio-action" onClick={onContinue}>Continue</button>
            </div>
          ) : !graded.exact ? (
            <div className="tio-actions">
              <button className="btn btn-secondary tio-action" onClick={onOverride}>I was actually incorrect</button>
              <button className="btn btn-primary tio-action" onClick={onContinue}>Continue</button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SessionScreen({ summary, history, buckets, secondsRemaining, onContinue }) {
  const recent = (history || []).slice(-RECENT_SESSIONS_CHART_COUNT);
  const minutes = Math.max(1, Math.ceil((secondsRemaining || 0) / 60));
  const score = summary?.correct || 0;
  const tone = score >= 8 ? 'Great session.' : score >= 5 ? 'Nice — keep going.' : 'Keep at it. Every miss makes the next one stick.';

  return (
    <div className="session-screen">
      <div className="session-head">
        <div className="session-score">{score}/{CARDS_PER_SESSION} correct</div>
        <div className="muted">{tone}</div>
      </div>
      <div className="session-grid">
        <div className="chart-card">
          <SessionChart data={recent} />
          <div className="chart-caption">Last {RECENT_SESSIONS_CHART_COUNT} sessions</div>
        </div>
        <div className="time-card">
          <div className="muted small">Estimated time remaining</div>
          <div className="time-num">{minutes}<span className="muted small"> mins</span></div>
        </div>
      </div>
      <div className="buckets">
        <Bucket name="Mastered"      n={buckets.mastered}    cls="b-mast" />
        <Bucket name="Learning"      n={buckets.learning}    cls="b-learn" />
        <Bucket name="To Be Learned" n={buckets.toBeLearned} cls="b-tbl" />
      </div>
      <button className="btn btn-primary big" onClick={onContinue}>Continue</button>
    </div>
  );
}

function Bucket({ name, n, cls }) {
  return (
    <div className={`bucket ${cls}`}>
      <div className="bucket-n">{n}</div>
      <div className="bucket-name">{name}</div>
    </div>
  );
}

function RunComplete({ total, onReset, onLeaderboard }) {
  return (
    <div className="complete-screen">
      <div className="complete-emoji">✓</div>
      <h2>Run complete</h2>
      <p>All {total} cards mastered. You earned {LEARN_RUN_POINTS} points this run.</p>
      <div className="complete-actions">
        <button className="btn btn-primary" onClick={onReset}>Start a new run</button>
        <button className="btn btn-secondary" onClick={onLeaderboard}>View leaderboard</button>
      </div>
    </div>
  );
}
