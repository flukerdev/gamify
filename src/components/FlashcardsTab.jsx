import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import FacePhoto from './FacePhoto.jsx';

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Plain flashcards: photo on the front, name on the back. Tap to flip, then
// say whether you knew it. Missed cards come back around until none are left.
// No points here (Learn, the Quiz and the Test are the scored modes); the
// first answered card of a visit counts the day toward the streak.
export default function FlashcardsTab({ game, pairs, onGoLearn }) {
  const cards = useMemo(() => (pairs || []).filter(p => p.photo_version != null), [pairs]);
  const idsKey = cards.map(c => c.id).join(',');
  const byId = useMemo(() => new Map(cards.map(c => [c.id, c])), [cards]);

  const [queue, setQueue] = useState(() => shuffled(cards.map(c => c.id)));
  const [flipped, setFlipped] = useState(false);
  const [seen, setSeen] = useState(0);          // cards answered at least once
  const [firstTry, setFirstTry] = useState(0);  // known the first time shown
  const [missedIds, setMissedIds] = useState(() => new Set());
  const [cardKey, setCardKey] = useState(0);
  const pinged = useRef(false);

  function start() {
    setQueue(shuffled(cards.map(c => c.id)));
    setFlipped(false); setSeen(0); setFirstTry(0); setMissedIds(new Set());
    setCardKey(k => k + 1);
  }
  // Re-deal whenever the set of students changes, e.g. the admin adds one.
  const dealtFor = useRef(idsKey);
  useEffect(() => {
    if (dealtFor.current === idsKey) return;
    dealtFor.current = idsKey;
    start();
  }, [idsKey]);

  if (cards.length === 0) {
    return (
      <div className="tab-pad">
        <h1 className="tab-title">Flashcards</h1>
        <div className="empty-card">
          <h3>No students yet</h3>
          <p>Once students are added, their photos show up here.</p>
        </div>
      </div>
    );
  }

  const total = cards.length;
  // Ignore ids that are no longer students (one was just removed), so a
  // stale queue can never point at a card that does not exist.
  const live = queue.filter(id => byId.has(id));
  const currentId = live[0];
  const current = currentId ? byId.get(currentId) : null;
  const done = live.length === 0;

  function answer(knewIt) {
    if (!current) return;
    if (!pinged.current) {
      pinged.current = true;
      api.post(`/api/games/${game.id}/activity`, {}).catch(() => {});
    }
    const wasMissedBefore = missedIds.has(currentId);
    if (!wasMissedBefore) {
      setSeen(n => n + 1);
      if (knewIt) setFirstTry(n => n + 1);
    }
    if (knewIt) {
      setQueue(q => q.filter(id => id !== currentId));
    } else {
      setMissedIds(prev => new Set(prev).add(currentId));
      // To the back of the line; it comes around again after the others.
      setQueue(q => [...q.filter(id => id !== currentId), currentId]);
    }
    setFlipped(false);
    setCardKey(k => k + 1);
  }

  if (done) {
    return (
      <div className="tab-pad flash-pad">
        <h1 className="tab-title">Flashcards</h1>
        <div className="result-card">
          <div className="muted small">Deck finished</div>
          <div className="big-score ok-text">{firstTry}/{total}</div>
          <div className="points-earned-line">
            {firstTry === total
              ? 'You knew every name on the first try.'
              : `You knew ${firstTry} of ${total} on the first try.`}
          </div>
          <div className="flash-done-actions">
            <button className="btn btn-primary" onClick={start}>Go again</button>
            {onGoLearn ? (
              <button className="btn btn-secondary" onClick={onGoLearn}>Earn points in Learn</button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const position = Math.min(seen + 1, total);
  const reviewing = seen >= total;

  return (
    <div className="tab-pad flash-pad">
      <h1 className="tab-title">Flashcards</h1>
      <div className="qt-progress">
        {reviewing ? `Reviewing missed cards · ${live.length} left` : `Card ${position} of ${total}`}
      </div>
      <div className="qt-bar">
        <div className="qt-bar-fill" style={{ width: `${(Math.max(0, total - live.length) / total) * 100}%` }} />
      </div>

      <button
        type="button"
        key={cardKey}
        className={`flip-card ${flipped ? 'flipped' : ''}`}
        onClick={() => setFlipped(f => !f)}
        aria-label={flipped ? `Name: ${current.definition}. Tap to see the photo.` : 'Tap to see the name'}>
        <div className="flip-inner">
          <div className="flip-face flip-front">
            <FacePhoto gameId={game.id} pairId={current.id} />
          </div>
          <div className="flip-face flip-back">
            <div className="flip-name">{current.definition}</div>
          </div>
        </div>
      </button>

      {flipped ? (
        <div className="flash-actions">
          <button className="btn btn-secondary flash-btn no" onClick={() => answer(false)}>Missed it</button>
          <button className="btn btn-primary flash-btn" onClick={() => answer(true)}>Got it</button>
        </div>
      ) : (
        <div className="flash-actions single">
          <button className="btn btn-primary flash-btn" onClick={() => setFlipped(true)}>Show name</button>
        </div>
      )}
      <p className="hint flash-hint">Say the name in your head, then tap the card to check.</p>
    </div>
  );
}
