import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { tierForPoints, colorForTier, nextTierProgress } from '../utils/tiers.js';
import TierIcon from './TierIcon.jsx';
import Loading from './Loading.jsx';
import { easternDateString, easternMonthDates, dowFromDateString, weeklyStreakCount } from '../utils/easternTime.js';

export default function ProfileTab({ user, game }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get(`/api/games/${game.id}/profile`).then(setData).catch(e => setErr(e.message));
  }, [game.id]);

  const today = easternDateString();
  const monthDates = useMemo(() => easternMonthDates(new Date()), []);

  if (err) return <div className="form-error">{err}</div>;
  if (!data) return <Loading />;

  const points = Number(data.totalPoints || 0);
  const tier = tierForPoints(points);
  const active = new Set(data.activeDates || []);
  const streak = weeklyStreakCount(data.activeDates || [], today);
  const daysActive = active.size;
  const next = nextTierProgress(points);

  // Pad with empty slots so the calendar starts on Sunday.
  const firstDow = dowFromDateString(monthDates[0]);
  const pad = Array.from({ length: firstDow }, () => null);
  const cells = [...pad, ...monthDates];
  const N = Math.ceil(cells.length / 7);
  const weekRows = Array.from({ length: N }, (_, i) => cells.slice(i*7, (i+1)*7));

  // Per-week info for the streak rail. We only care about which weeks had
  // ANY activity — the rail renders a green dot on each and a connecting
  // bar between consecutive ones.
  const weekInfo = weekRows.map(row => {
    const dates = row.filter(Boolean);
    return { hasActivity: dates.some(d => active.has(d)) };
  });

  return (
    <div className="tab-pad">
      <div className="profile-head">
        <h1 className="profile-name">{user.first_name} {user.last_name}</h1>
        <div className="tier-pill" style={{ background: colorForTier(tier) }}>
          <TierIcon tier={tier} size={16} outlined />
          <span>{tier}</span>
        </div>
      </div>

      {next && (
        <div className="tier-progress">
          <div className="tier-progress-label">
            <span className="muted small">{next.remaining} pts to {next.nextTier}</span>
          </div>
          <div className="tier-progress-track">
            <div className="tier-progress-fill"
              style={{ width: `${next.pct}%`, background: colorForTier(next.nextTier) }} />
          </div>
        </div>
      )}

      <div className="profile-stats">
        <div className="stat-card">
          <div className="stat-label">Total points</div>
          <div className="stat-value">{Math.round(points)}</div>
        </div>
        <div className="stat-card streak-card">
          <div className="stat-label">Weekly streak</div>
          <div className="stat-value">{streak}<span className="muted small">{streak===1?' week':' weeks'}</span></div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Days active</div>
          <div className="stat-value">{daysActive}<span className="muted small">{daysActive===1?' day':' days'}</span></div>
        </div>
      </div>

      <div className="cal-card">
        <div className="cal-head">
          <div className="cal-title">
            {new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' })}
          </div>
        </div>
        <div className="cal-area">
          <div className="cal-grid-host">
            <div className="cal-grid">
              {['S','M','T','W','T','F','S'].map((d,i)=>(<div key={i} className="cal-dow">{d}</div>))}
              {cells.map((c, i) => c == null
                ? <div key={i} className="cal-cell empty-slot" />
                : (
                  <div key={i} className={`cal-cell ${active.has(c) ? 'on' : ''} ${c===today?'today':''}`} title={c}>
                    <span className="cal-day">{Number(c.slice(-2))}</span>
                  </div>
                ))}
            </div>
          </div>
          <StreakRail n={N} weekInfo={weekInfo} />
        </div>
      </div>
    </div>
  );
}

// Streak rail: a green dot on every week with activity, with a connecting
// green bar between consecutive active weeks. Inactive weeks show nothing.
// A single isolated active week renders as just the dot (bar collapses).
function StreakRail({ n, weekInfo }) {
  const slotPct = (i) => ((i + 0.5) / n) * 100;
  const activeIdxs = weekInfo
    .map((w, i) => (w.hasActivity ? i : -1))
    .filter(i => i >= 0);

  // Group active indices into runs of consecutive weeks. Each run becomes
  // one connecting bar from the first to the last week in the run.
  const runs = [];
  for (const i of activeIdxs) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else runs.push([i]);
  }

  return (
    <div className="streak-rail-wrap" aria-label="Weekly streak">
      <div className="streak-dow-spacer" />
      <div className="streak-rail">
        {runs.map((run, k) => {
          if (run.length < 2) return null;
          const top = slotPct(run[0]);
          const height = slotPct(run[run.length - 1]) - top;
          return (
            <div className="rail-line" key={`bar-${k}`}
              style={{ top: `${top}%`, height: `${height}%` }} />
          );
        })}
        {activeIdxs.map(i => (
          <div className="rail-dot-slot" key={`d-${i}`}
            style={{ top: `calc(${slotPct(i)}% - 8px)` }}>
            <span className="rail-dot green" />
          </div>
        ))}
      </div>
    </div>
  );
}
