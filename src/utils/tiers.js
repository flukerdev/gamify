import { TIER_THRESHOLDS, TIER_COLORS, TIERS } from '../config.js';

// Map total points -> tier name. Bands per spec:
//   Rookie:       0–99
//   Professional: 100–199
//   Elite:        200–349
//   Veteran:      350–599
//   Master:       600+
export function tierForPoints(points) {
  const p = Number(points || 0);
  if (p < TIER_THRESHOLDS[0]) return 'Rookie';
  if (p < TIER_THRESHOLDS[1]) return 'Professional';
  if (p < TIER_THRESHOLDS[2]) return 'Elite';
  if (p < TIER_THRESHOLDS[3]) return 'Veteran';
  return 'Master';
}

export function colorForTier(tier) {
  return TIER_COLORS[tier] || TIER_COLORS.Rookie;
}

export function tierInfo(name) {
  return TIERS.find(t => t.name === name) || TIERS.find(t => t.name === 'Rookie');
}

export function rangeForTier(tier) {
  const t = tierInfo(tier);
  return t.max == null ? `${t.min}+ pts` : `${t.min}–${t.max} pts`;
}

// Progress toward the next tier. Returns the next tier's name, the points
// still needed to reach it, and a 0–100 fill percentage for the current band.
// Returns null when the user is already at the top tier (Master).
const NEXT_TIER_NAMES = ['Professional', 'Elite', 'Veteran', 'Master'];
export function nextTierProgress(points) {
  const p = Number(points || 0);
  const idx = TIER_THRESHOLDS.findIndex(t => p < t);
  if (idx === -1) return null; // already Master
  const target = TIER_THRESHOLDS[idx];
  const start = idx === 0 ? 0 : TIER_THRESHOLDS[idx - 1];
  return {
    nextTier: NEXT_TIER_NAMES[idx],
    remaining: Math.max(0, Math.ceil(target - p)),
    pct: Math.max(0, Math.min(100, ((p - start) / (target - start)) * 100)),
  };
}
