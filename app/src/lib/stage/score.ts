// Stage scoring for a set (a song played for a rating). Pure functions over a
// small state object so the gameplay screen, the results screen and the tests
// agree. Vocabulary is ours: Run (consecutive hits), Groove (a meter that
// fills on good hits and drains on drops), judgments Locked / On it / Early /
// Late / Dropped, and a Take rating from Rough to Flawless.
import type { Quality, Shape } from '../music';
import type { TutorialTarget } from '../learn/songs';

export type Judgment = 'locked' | 'onit' | 'early' | 'late' | 'dropped';
export type Rating = 'rough' | 'loose' | 'steady' | 'tight' | 'pocket' | 'flawless';

export const JUDGMENT_INFO: Record<Judgment, { label: string; value: number; groove: number }> = {
  locked: { label: 'Locked', value: 300, groove: 0.06 },
  onit: { label: 'On it', value: 200, groove: 0.04 },
  early: { label: 'Early', value: 100, groove: 0.01 },
  late: { label: 'Late', value: 100, groove: 0.01 },
  dropped: { label: 'Dropped', value: 0, groove: -0.15 },
};

export const RATING_INFO: Record<Rating, { label: string; blurb: string }> = {
  flawless: { label: 'Flawless', blurb: 'Every chord locked or on it. Nothing dropped.' },
  pocket: { label: 'In the Pocket', blurb: 'Tight timing, at most one dropped chord.' },
  tight: { label: 'Tight', blurb: 'Solid take. A few chords could land closer.' },
  steady: { label: 'Steady', blurb: 'You know the changes. Now chase the beat.' },
  loose: { label: 'Loose', blurb: 'Most changes landed. Slow it down and lock the shapes.' },
  rough: { label: 'Rough', blurb: 'A first pass. Watch the demo, then try again.' },
};
export const RATING_ORDER: Rating[] = ['rough', 'loose', 'steady', 'tight', 'pocket', 'flawless'];

/** Timing windows in ms, symmetric around the beat. Beyond LATE is Dropped. */
export const WINDOWS = { locked: 60, onit: 120, late: 220 } as const;

export type VariationId = 'rehearsal' | 'halftime' | 'doubletime' | 'blind' | 'strict' | 'mirror';
export const VARIATIONS: Record<VariationId, { label: string; blurb: string; mult: number; tempo?: number }> = {
  rehearsal: { label: 'Rehearsal', blurb: 'Groove never runs out. Half score.', mult: 0.5 },
  halftime: { label: 'Half-time', blurb: 'Three quarters of the tempo.', mult: 0.7, tempo: 0.75 },
  doubletime: { label: 'Double-time', blurb: 'A quarter faster.', mult: 1.15, tempo: 1.25 },
  blind: { label: 'Blind', blurb: 'The next-chord outline hides one beat early.', mult: 1.1 },
  strict: { label: 'Strict', blurb: 'The right-hand shape has to match too.', mult: 1.1 },
  mirror: { label: 'Mirror', blurb: 'Hands swapped.', mult: 1.0 },
};

export interface Hit {
  target: number;
  judgment: Judgment;
  /** signed offset in ms, negative = early; undefined for a dropped chord that never came */
  offsetMs?: number;
  beat: number;
}

export interface SetScore {
  targets: number;
  hits: Hit[];
  score: number;
  run: number;
  bestRun: number;
  groove: number;
  failed: boolean;
  counts: Record<Judgment, number>;
}

export function newSetScore(targets: number): SetScore {
  return { targets, hits: [], score: 0, run: 0, bestRun: 0, groove: 0.5, failed: false, counts: { locked: 0, onit: 0, early: 0, late: 0, dropped: 0 } };
}

export function variationMultiplier(v: VariationId[]): number {
  return v.reduce((m, id) => m * VARIATIONS[id].mult, 1);
}

/** Classify a played chord against its target. Wrong chord = Dropped whatever the timing. */
export function judgeHit(
  target: TutorialTarget,
  played: { degree: number; quality: Quality; shape: Shape; octave: number },
  offsetMs: number,
  strictShape: boolean,
): Judgment {
  const rightChord = played.degree === target.degree && played.quality === target.quality && (!strictShape || played.shape === target.shape);
  if (!rightChord) return 'dropped';
  const a = Math.abs(offsetMs);
  if (a <= WINDOWS.locked) return 'locked';
  if (a <= WINDOWS.onit) return 'onit';
  if (a <= WINDOWS.late) return offsetMs < 0 ? 'early' : 'late';
  return 'dropped';
}

/** Apply one judgment. Returns a new state (the store is $state, so callers reassign). */
export function applyHit(s: SetScore, hit: Hit, variations: VariationId[] = []): SetScore {
  const info = JUDGMENT_INFO[hit.judgment];
  const run = hit.judgment === 'dropped' ? 0 : s.run + 1;
  const runMult = 1 + Math.min(s.run, 50) / 25; // uses the run BEFORE this hit, caps at 3x
  const gained = Math.round(info.value * runMult * variationMultiplier(variations));
  const groove = Math.max(0, Math.min(1, s.groove + info.groove));
  const counts = { ...s.counts, [hit.judgment]: s.counts[hit.judgment] + 1 };
  const failed = s.failed || (groove <= 0 && !variations.includes('rehearsal'));
  return { ...s, hits: [...s.hits, hit], score: s.score + gained, run, bestRun: Math.max(s.bestRun, run), groove, counts, failed };
}

export function accuracy(s: SetScore): number {
  if (s.targets === 0) return 0;
  const total = s.hits.reduce((n, h) => n + JUDGMENT_INFO[h.judgment].value, 0);
  return total / (300 * s.targets);
}

export function rating(s: SetScore): Rating {
  const acc = accuracy(s);
  const dropped = s.counts.dropped;
  if (s.failed) return 'rough';
  if (acc >= 0.999 && dropped === 0) return 'flawless';
  if (acc >= 0.95 && dropped <= 1) return 'pocket';
  if (acc >= 0.9) return 'tight';
  if (acc >= 0.8) return 'steady';
  if (acc >= 0.65) return 'loose';
  return 'rough';
}

export const inTheGroove = (s: SetScore) => s.groove >= 0.98;

/** Rank ladder from lifetime XP. Seven ranks, five steps each. */
export const RANKS = ['Busker', 'Session Player', 'Sideman', 'Bandleader', 'Composer', 'Virtuoso', 'Maestro'] as const;
export function rankFor(xp: number): { rank: (typeof RANKS)[number]; step: number; progress: number; next: number } {
  // step n needs 250 * n^1.35 xp; 35 steps in total
  let level = 0;
  let need = 0;
  let acc = 0;
  for (level = 0; level < 35; level++) {
    need = Math.round(250 * Math.pow(level + 1, 1.35));
    if (xp < acc + need) break;
    acc += need;
  }
  const rank = RANKS[Math.min(RANKS.length - 1, Math.floor(level / 5))];
  return { rank, step: (level % 5) + 1, progress: level >= 35 ? 1 : (xp - acc) / need, next: level >= 35 ? 0 : acc + need - xp };
}
