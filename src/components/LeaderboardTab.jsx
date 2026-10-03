import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { tierForPoints, colorForTier, rangeForTier } from '../utils/tiers.js';
import { TIERS, QUIZ_LENGTH, QUIZ_MAX_POINTS, TEST_LENGTH, TEST_MAX_POINTS, LEARN_RUN_POINTS } from '../config.js';
import TierIcon from './TierIcon.jsx';
import InviteFriends, { buildInviteLink } from './InviteFriends.jsx';

export default function LeaderboardTab({ user, game }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [shareToast, setShareToast] = useState('');
  const timerRef = useRef(null);

  // Build a concise, family-friendly share blob: game title, top 5 with first
  // names + points, and a one-tap link back into the game. We share via the
  // native share sheet when available (iOS/Android, modern desktop Safari);
  // otherwise we copy to clipboard and flash a small confirmation.
  async function shareLeaderboard() {
    if (!rows.length) return;
    const top = rows.slice(0, 5);
    const lines = top.map((r, i) => {
      const pts = Math.round(Number(r.totalPoints));
      const name = (r.firstName || '').trim();
      return `${i + 1}. ${name} — ${pts} pts`;
    });
    const link = buildInviteLink(game.share_code);
    const text =
      `${game.title} — Gamify Leaderboard\n\n` +
      `${lines.join('\n')}\n\n` +
      `Play with us: ${link}`;

    if (typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: 'Gamify Leaderboard', text }); } catch { /* user cancelled */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setShareToast('Leaderboard copied!');
      setTimeout(() => setShareToast(''), 1800);
    } catch {
      setShareToast('Could not copy — long-press to share.');
      setTimeout(() => setShareToast(''), 2400);
    }
  }

  async function load() {
    try {
      const { leaderboard } = await api.get(`/api/games/${game.id}/leaderboard`);
      setRows(leaderboard || []);
      setErr('');
    } catch (e) { setErr(e.message); }
  }

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 5000);
    return () => clearInterval(timerRef.current);
  }, [game.id]);

  if (err) return <div className="form-error">{err}</div>;

  return (
    <div className="tab-pad">
      <div className="lb-head">
        <h1 className="tab-title">Leaderboard</h1>
        {game.protected ? null : (
          // Passcode games are not joined by link, so there is nothing to share.
          <div className="lb-head-actions">
            <button className="btn btn-secondary small" onClick={shareLeaderboard}>Share leaderboard</button>
            <button className="btn btn-secondary small" onClick={() => setShowInvite(true)}>Invite</button>
          </div>
        )}
      </div>
      {shareToast ? <div className="share-toast" role="status">{shareToast}</div> : null}

      <InfoSections />

      <div className="lb-list">
        {rows.length === 0 ? <div className="empty">No participants yet.</div> :
          rows.map(r => {
            const points = Math.round(Number(r.totalPoints));
            const tier = tierForPoints(points);
            const me = r.userId === user.id;
            return (
              <div key={r.userId} className={`lb-row ${me ? 'me' : ''}`}>
                <div className="lb-rank"><span className="rank-num">{r.rank}</span></div>
                <div className="lb-name-block">
                  <span className="lb-name-text">{r.firstName} {r.lastName}{me ? ' (you)' : ''}</span>
                  <span className="lb-tier" style={{ color: colorForTier(tier) }}>
                    <TierIcon tier={tier} size={18} />
                    <span className="lb-tier-name">{tier}</span>
                  </span>
                </div>
                <div className="lb-delta">
                  {r.delta > 0 ? <span className="d up">+{r.delta}</span>
                    : r.delta < 0 ? <span className="d down">{r.delta}</span>
                    : <span className="d flat">–</span>}
                </div>
                <div className="lb-points">{points}<span className="muted small"> pts</span></div>
              </div>
            );
          })}
      </div>

      {showInvite && (
        <div className="modal-wrap" onClick={() => setShowInvite(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Invite friends</h3>
              <button className="icon-btn" onClick={() => setShowInvite(false)} aria-label="Close">×</button>
            </div>
            <div className="modal-body">
              <InviteFriends game={game} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Two info sections: How Scoring Works + How Tiers Work.
// Desktop (>=768px): both always expanded, shown side by side.
// Mobile (<768px): each collapsible, stacked vertically.
function InfoSections() {
  const [scoringOpen, setScoringOpen] = useState(false);
  const [tiersOpen, setTiersOpen] = useState(false);
  return (
    <div className="info-sections">
      <InfoBlock title="How Scoring Works" open={scoringOpen} onToggle={() => setScoringOpen(o => !o)}>
        <ul className="scoring-list">
          <li><b>Daily Quiz</b> · once a day · up to {QUIZ_MAX_POINTS} pts ({QUIZ_LENGTH} Qs, graded on accuracy)</li>
          <li><b>Daily Test</b> · once a day · up to {TEST_MAX_POINTS} pts ({TEST_LENGTH} Qs, graded on accuracy)</li>
          <li><b>Learn</b> · unlimited · up to {LEARN_RUN_POINTS} pts per completed run</li>
        </ul>
        <div className="scoring-foot muted small">
          Everyone gets the SAME Daily Quiz and Daily Test each day.
        </div>
      </InfoBlock>
      <InfoBlock title="How Tiers Work" open={tiersOpen} onToggle={() => setTiersOpen(o => !o)}>
        <div className="tier-list compact">
          {TIERS.map(t => (
            <div key={t.name} className="tier-row" style={{ borderColor: t.color }}>
              <TierIcon tier={t.name} size={22} />
              <div className="tier-row-text">
                <div className="tier-row-name" style={{ color: t.color }}>{t.name}</div>
                <div className="tier-row-range muted small">{rangeForTier(t.name)}</div>
              </div>
            </div>
          ))}
        </div>
      </InfoBlock>
    </div>
  );
}

function InfoBlock({ title, open, onToggle, children }) {
  return (
    <section className={`info-block ${open ? 'open' : ''}`}>
      <button className="info-head" onClick={onToggle} type="button">
        <span className="info-title">{title}</span>
        <span className="info-chevron" aria-hidden="true">▾</span>
      </button>
      <div className="info-body">
        {children}
      </div>
    </section>
  );
}
