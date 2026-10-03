import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Loading from './Loading.jsx';
import FacePhoto from './FacePhoto.jsx';

// Shared component for both the daily Quiz and the daily Test.
// Behavior matches the spec:
//  - Identical question set for everyone in the game on a given day.
//  - One attempt per user per day; locked after taking.
//  - "Not enough content yet" state when the game has too few pairs.
export default function QuizOrTest({ game, kind, length, onGoToLeaderboard }) {
  const [data, setData] = useState(null);
  const [answers, setAnswers] = useState([]);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const [justEarnedPoints, setJustEarnedPoints] = useState(null);

  async function load() {
    setErr('');
    try {
      const d = await api.get(`/api/games/${game.id}/${kind}`);
      setData(d);
      if (d?.locked && d?.attempt) setResult(d.attempt);
      else setResult(null);
      setIdx(0);
      setAnswers(new Array(d?.questions?.length || 0).fill(null));
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [game.id, kind]);

  const isFaces = game.kind === 'faces';
  const noun = isFaces ? 'students' : 'pairs';

  if (err && !data) return (
    <div className="tab-pad">
      <div className="form-error">{err}</div>
      <button className="btn btn-secondary" onClick={load}>Try again</button>
    </div>
  );
  if (!data) return <Loading />;
  if (!data.available) {
    return (
      <div className="tab-pad">
        <h1 className="tab-title">{kind === 'quiz' ? 'Daily Quiz' : 'Daily Test'}</h1>
        <div className="empty-card">
          <h3>Not enough content yet</h3>
          <p>This game needs at least {length} {noun} before {kind === 'quiz' ? 'a quiz' : 'a test'} is available.</p>
          <p className="muted small">Have {data.have} of {data.needed}.</p>
        </div>
      </div>
    );
  }

  // Already taken today / just finished. Quiz/Test grading is 1pt per correct,
  // so points earned == result.correct — even when revisiting a prior attempt.
  if (result) {
    const pointsEarned = justEarnedPoints != null ? justEarnedPoints : Number(result.correct || 0);
    // Per-question recap. Prompts come from the question set we loaded earlier
    // (data.questions); the user's answer + correct answer come from the
    // locked attempt rows. Indexes line up because both arrays are ordered.
    const recap = (result.answers || []).map((a, i) => ({
      idx: i,
      pairId: a.pairId,
      prompt: data?.questions?.[i]?.prompt || '',
      chosen: a.chosen,
      correct: a.correct,
      isCorrect: !!a.isCorrect,
    }));
    return (
      <div className="tab-pad">
        <h1 className="tab-title">{kind === 'quiz' ? 'Daily Quiz' : 'Daily Test'}</h1>
        <div className="result-card">
          <div className="muted small">Today's result · locked until tomorrow</div>
          <div className="big-score ok-text">{result.correct}/{result.total}</div>
          <div className="points-earned-line ok-text">
            You earned +{pointsEarned} {pointsEarned === 1 ? 'point' : 'points'} for this {kind === 'quiz' ? 'quiz' : 'test'}.
          </div>
          {onGoToLeaderboard ? (
            <button className="btn btn-primary result-cta" onClick={onGoToLeaderboard}>
              See your standing →
            </button>
          ) : null}
        </div>

        {recap.length > 0 ? (
          <div className="recap">
            <h3 className="recap-title">Review</h3>
            <ol className="recap-list">
              {recap.map(r => (
                <li key={r.idx} className={`recap-item ${r.isCorrect ? 'ok' : 'no'}`}>
                  <div className="recap-head">
                    <span className="recap-badge" aria-hidden="true">{r.isCorrect ? '✓' : '✗'}</span>
                    {isFaces
                      ? <FacePhoto gameId={game.id} pairId={r.pairId} size={44} className="round" />
                      : <span className="recap-prompt">{r.prompt}</span>}
                  </div>
                  <div className="recap-row">
                    <span className="recap-label">Your answer:</span>
                    <span className={`recap-value ${r.isCorrect ? 'ok-text' : 'no-text'}`}>
                      {r.chosen ?? <em className="muted">(skipped)</em>}
                    </span>
                  </div>
                  {!r.isCorrect ? (
                    <div className="recap-row">
                      <span className="recap-label">Correct:</span>
                      <span className="recap-value ok-text">{r.correct}</span>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    );
  }

  const questions = data.questions || [];
  const q = questions[idx];

  function pick(opt) {
    const next = answers.slice();
    next[idx] = opt;
    setAnswers(next);
  }

  async function submit() {
    if (answers.some(a => a == null)) {
      setErr('Answer every question before submitting.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const out = await api.post(`/api/games/${game.id}/${kind}`, { answers });
      setResult(out.attempt);
      setJustEarnedPoints(Number(out.points || 0));
    } catch (e) {
      // Already taken (e.g. submitted from another phone): show that result.
      if (e.status === 409 && e.data?.attempt) setResult(e.data.attempt);
      else setErr(e.message);
    }
    setBusy(false);
  }

  return (
    <div className="tab-pad">
      <h1 className="tab-title">{kind === 'quiz' ? 'Daily Quiz' : 'Daily Test'}</h1>
      <p className="hub-sub">
        {kind === 'quiz' ? `${length} questions · once per day` : `${length} questions · once per day`}
      </p>

      <div className="qt-progress">Question {idx + 1} of {questions.length}</div>
      <div className="qt-bar">
        <div className="qt-bar-fill" style={{ width: `${((idx+1)/questions.length)*100}%` }} />
      </div>

      <div className="qt-card">
        {isFaces
          ? <FacePhoto gameId={game.id} pairId={q.pairId} className="card-photo" />
          : <div className="qt-prompt">{q.prompt}</div>}
        <div className="qt-options">
          {q.options.map((opt, i) => (
            <button
              key={i}
              className={`qt-option ${answers[idx]===opt ? 'sel' : ''}`}
              onClick={() => pick(opt)}>
              {opt}
            </button>
          ))}
        </div>
      </div>

      <div className="qt-controls">
        <button className="btn btn-ghost" disabled={idx===0} onClick={()=>setIdx(idx-1)}>← Back</button>
        {idx < questions.length - 1
          ? <button className="btn btn-primary" disabled={answers[idx]==null} onClick={()=>setIdx(idx+1)}>Next →</button>
          : <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy?'Submitting…':'Submit'}</button>}
      </div>
      {err ? <div className="form-error">{err}</div> : null}
    </div>
  );
}
