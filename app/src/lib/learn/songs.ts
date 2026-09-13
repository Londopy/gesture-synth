// Built-in songs (song.gsyn.json shape, spec 10) and the tutorial scoring engine
// (spec 9 "Learn": score = timing accuracy + shape accuracy).

import type { Quality, Shape } from '../music';

export interface SongChord {
  bar: number;
  beat: number;
  degree: number;
  quality: 'major' | 'minor' | 'diminished';
  shape: 'root' | 'inv1' | 'seventh' | 'dom_or_dim7';
  octave: number;
  dur_beats: number;
}

export interface Song {
  version: number;
  name: string;
  author: string;
  bpm: number;
  time_sig: string;
  key: string;
  mode: 'major' | 'minor';
  bars: number;
  chords: SongChord[];
  hints: { left_scheme: { kind: string; degree?: number }; right_scheme: { kind: string; shape?: string } };
  tags: string[];
  instrument?: string;
  id?: string;
  description?: string;
}

export const KEY_INDEX: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
export const QUALITY_INDEX: Record<SongChord['quality'], Quality> = { major: 0, minor: 1, diminished: 2 };
export const SHAPE_INDEX: Record<SongChord['shape'], Shape> = { root: 0, inv1: 1, seventh: 2, dom_or_dim7: 3 };
export const SHAPE_KEYS: SongChord['shape'][] = ['root', 'inv1', 'seventh', 'dom_or_dim7'];
export const QUALITY_KEYS: SongChord['quality'][] = ['major', 'minor', 'diminished'];

function prog(
  name: string,
  bpm: number,
  key: string,
  mode: 'major' | 'minor',
  chords: [number, SongChord['quality'], SongChord['shape']][],
  opts: Partial<Song> = {},
): Song {
  const bars = chords.length;
  return {
    version: 1,
    name,
    author: 'Gesture Synth',
    bpm,
    time_sig: '4/4',
    key,
    mode,
    bars,
    chords: chords.map(([degree, quality, shape], i) => ({ bar: i + 1, beat: 1, degree, quality, shape, octave: 0, dur_beats: 4 })),
    hints: { left_scheme: { kind: 'full' }, right_scheme: { kind: 'full' } },
    tags: ['builtin'],
    instrument: 'Pad',
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    ...opts,
  };
}

export const BUILTIN_SONGS: Song[] = [
  prog('Four Chords', 84, 'C', 'major', [[1, 'major', 'root'], [5, 'major', 'root'], [6, 'minor', 'root'], [4, 'major', 'root']], {
    description: 'The I V vi IV loop. Left hand only changes; right hand holds one finger.',
    tags: ['builtin', 'beginner'],
    hints: { left_scheme: { kind: 'full' }, right_scheme: { kind: 'fixed_style', shape: 'root' } },
  }),
  prog('Fifty-Fifty', 92, 'G', 'major', [[1, 'major', 'root'], [4, 'major', 'root'], [1, 'major', 'root'], [5, 'major', 'root']], {
    description: 'I IV I V in G. Practice walking the circle-of-fifths highlight.',
    tags: ['builtin', 'beginner'],
  }),
  prog('Two Five One', 110, 'F', 'major', [[2, 'minor', 'seventh'], [5, 'major', 'dom_or_dim7'], [1, 'major', 'seventh'], [1, 'major', 'inv1']], {
    description: 'ii7 V7 Imaj7: three right-hand shapes in a row.',
    tags: ['builtin', 'jazz', 'intermediate'],
    instrument: 'Keys',
  }),
  prog('Andalusian', 100, 'A', 'minor', [[1, 'minor', 'root'], [7, 'major', 'root'], [6, 'major', 'root'], [5, 'major', 'root']], {
    description: 'i VII VI V. Flip the tilt on the last chord for the major V.',
    tags: ['builtin', 'intermediate'],
    instrument: 'Pluck',
  }),
  prog('Pachelbel', 72, 'D', 'major', [[1, 'major', 'root'], [5, 'major', 'root'], [6, 'minor', 'root'], [3, 'minor', 'root'], [4, 'major', 'root'], [1, 'major', 'inv1'], [4, 'major', 'root'], [5, 'major', 'dom_or_dim7']], {
    description: 'The canon progression over eight bars, with an inversion and a dominant seventh.',
    tags: ['builtin', 'classical', 'advanced'],
    instrument: 'Choir',
  }),
  prog('Minor Sevenths', 96, 'E', 'minor', [[1, 'minor', 'seventh'], [4, 'minor', 'seventh'], [6, 'major', 'seventh'], [5, 'minor', 'seventh']], {
    description: 'All sevenths: keep three right-hand fingers up and move the left hand.',
    tags: ['builtin', 'intermediate'],
    hints: { left_scheme: { kind: 'full' }, right_scheme: { kind: 'fixed_style', shape: 'seventh' } },
    instrument: 'Pad',
  }),
];

export function songById(id: string): Song | undefined {
  return BUILTIN_SONGS.find((s) => s.id === id);
}

// ------------------------------------------------------------------ scoring

export interface TutorialTarget {
  index: number;
  degree: number;
  quality: Quality;
  shape: Shape;
  octave: number;
  /** start / end in beats from song start */
  startBeat: number;
  endBeat: number;
}

export function songTargets(song: Song): TutorialTarget[] {
  const beats = Number(song.time_sig.split('/')[0]) || 4;
  return song.chords
    .slice()
    .sort((a, b) => a.bar - b.bar || a.beat - b.beat)
    .map((c, i) => {
      const start = (c.bar - 1) * beats + (c.beat - 1);
      return { index: i, degree: c.degree, quality: QUALITY_INDEX[c.quality], shape: SHAPE_INDEX[c.shape], octave: c.octave, startBeat: start, endBeat: start + c.dur_beats };
    });
}

export interface ScoreState {
  hits: number;
  misses: number;
  timingSum: number; // accumulated 0..1 timing scores
  shapeSum: number;
  total: number;
  streak: number;
  bestStreak: number;
  lastJudgement: 'perfect' | 'good' | 'late' | 'miss' | null;
  lastJudgementAt: number;
}

export function newScore(): ScoreState {
  return { hits: 0, misses: 0, timingSum: 0, shapeSum: 0, total: 0, streak: 0, bestStreak: 0, lastJudgement: null, lastJudgementAt: 0 };
}

export function scorePercent(s: ScoreState): number {
  if (s.total === 0) return 0;
  return Math.round(((s.timingSum * 0.5 + s.shapeSum * 0.5) / s.total) * 100);
}

/**
 * Judge a chord change that occurred at `beatPos` (song beats, fractional)
 * against the target whose window contains it. Timing score is 1 within a
 * 16th, falling to 0 at one beat late/early. Shape score: degree+quality 0.6,
 * shape 0.3, octave 0.1.
 */
export function judge(
  s: ScoreState,
  target: TutorialTarget,
  beatPos: number,
  played: { degree: number; quality: Quality; shape: Shape; octave: number },
  checkShape = true,
  nowMs = performance.now(),
): ScoreState {
  const dt = Math.abs(beatPos - target.startBeat);
  const timing = dt <= 0.25 ? 1 : Math.max(0, 1 - (dt - 0.25) / 0.75);
  let shape = 0;
  if (played.degree === target.degree && played.quality === target.quality) shape += 0.6;
  else if (played.degree === target.degree) shape += 0.35;
  if (!checkShape || played.shape === target.shape) shape += 0.3;
  if (played.octave === target.octave) shape += 0.1;
  const hit = shape >= 0.6 && timing > 0;
  s.total++;
  s.timingSum += hit ? timing : 0;
  s.shapeSum += hit ? shape : 0;
  if (hit) {
    s.hits++;
    s.streak++;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
    s.lastJudgement = timing >= 0.9 ? 'perfect' : timing >= 0.5 ? 'good' : 'late';
  } else {
    s.misses++;
    s.streak = 0;
    s.lastJudgement = 'miss';
  }
  s.lastJudgementAt = nowMs;
  return s;
}

export function markMissed(s: ScoreState, nowMs = performance.now()): ScoreState {
  s.total++;
  s.misses++;
  s.streak = 0;
  s.lastJudgement = 'miss';
  s.lastJudgementAt = nowMs;
  return s;
}

/** Finger pattern (thumb..pinky) the LEFT hand must show for a degree. */
export function leftFingersFor(degree: number): [boolean, boolean, boolean, boolean, boolean] {
  switch (degree) {
    case 1:
      return [false, true, false, false, false];
    case 2:
      return [false, true, true, false, false];
    case 3:
      return [false, true, true, true, false];
    case 4:
      return [false, true, true, true, true];
    case 5:
      return [true, true, true, true, true];
    case 6:
      return [false, true, false, false, true];
    case 7:
      return [true, true, false, false, true];
    default:
      return [false, false, false, false, false];
  }
}

/** Finger pattern the RIGHT hand must show for a shape (thumb = octave, kept neutral). */
export function rightFingersFor(shape: Shape, octave = 0): [boolean, boolean, boolean, boolean, boolean] {
  const n = shape + 1;
  return [octave > 0, n >= 1, n >= 2, n >= 3, n >= 4];
}

/** Left-hand tilt (degrees) to show for a quality. */
export function tiltFor(quality: Quality): number {
  return quality === 1 ? -25 : 25;
}
