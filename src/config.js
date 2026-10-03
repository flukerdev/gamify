// ============================================================================
// Gamify — single source of truth for every tunable constant.
// Edit values here; do not scatter magic numbers in components or routes.
// ============================================================================

// ---------- Branding ----------
// This deployment is the ministry's name-learning app. APP_NAME is the full
// title; BRAND_LETTER is the mark shown in the round logo and loading spinner.
export const APP_NAME = 'STS - Know your Names!';
export const BRAND_LETTER = 'S';

// ---------- Scoring ----------
// Quiz: graded on accuracy. 5 questions, points = number correct (max 5).
export const QUIZ_LENGTH = 5;
export const QUIZ_MAX_POINTS = 5;

// Test: graded on accuracy. 20 questions, points = number correct (max 20).
export const TEST_LENGTH = 20;
export const TEST_MAX_POINTS = 20;

// Learn: a fully completed run is worth EXACTLY this many points.
// The total is split evenly across all cards; each card pays its slice when Mastered.
export const LEARN_RUN_POINTS = 50;

// ---------- Tier thresholds ----------
// Official ranges:
//   Rookie:       0–99
//   Professional: 100–199
//   Elite:        200–349
//   Veteran:      350–599
//   Master:       600+
export const TIER_THRESHOLDS = [100, 200, 350, 600];

// Tier color mapping. Used everywhere a tier appears.
// Colors chosen to avoid greens/reds (reserved for progress signals).
export const TIER_COLORS = {
  Rookie:       '#9ca3af', // grey
  Professional: '#2563eb', // blue
  Elite:        '#f97316', // orange
  Veteran:      '#9333ea', // purple
  Master:       '#7dd3fc', // Carolina/crystal sky blue
};

// Ordered top-to-bottom for display (Master at top, Rookie at bottom).
// Logic that needs ascending thresholds uses TIER_THRESHOLDS instead.
export const TIERS = [
  { name: 'Master',       min: 600, max: null, color: TIER_COLORS.Master       },
  { name: 'Veteran',      min: 350, max: 599,  color: TIER_COLORS.Veteran      },
  { name: 'Elite',        min: 200, max: 349,  color: TIER_COLORS.Elite        },
  { name: 'Professional', min: 100, max: 199,  color: TIER_COLORS.Professional },
  { name: 'Rookie',       min: 0,   max: 99,   color: TIER_COLORS.Rookie       },
];

// ---------- Learn engine ----------
export const CARDS_PER_SESSION = 10;            // session size before progress screen
export const MC_OPTION_COUNT = 4;               // multiple-choice option count
export const EST_SECONDS_PER_MC = 10;           // for "Estimated time remaining"
export const EST_SECONDS_PER_TIO = 30;          // for "Estimated time remaining"
export const RECENT_SESSIONS_CHART_COUNT = 5;   // last-N sessions shown on chart
export const SIMILARITY_THRESHOLD = 0.9;        // normalized Levenshtein >= passes type-it-out

// ---------- Share codes ----------
export const SHARE_CODE_LENGTH = 6;
// Avoid visually ambiguous chars (0/O, 1/I).
export const SHARE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- Time ----------
// All "day" boundaries in the app are US Eastern Time.
export const APP_TIMEZONE = 'America/New_York';

// ---------- UI ----------
export const ACCENT_SUCCESS = '#10b981'; // a clean green — progress signals
export const ACCENT_ERROR   = '#ef4444'; // a clean red — regression signals
