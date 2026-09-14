// Choreography: turn a song into the discrete cues the performer executes and
// the continuous expression (volume, cutoff, arp) sampled every tick. Pure
// functions; the store schedules cues with the leads from leadBeats().

import { leftFingersFor, QUALITY_INDEX, rightFingersFor, SHAPE_INDEX, tiltFor, type Song } from '../learn/songs';
import { beatsPerBar, chordOnset, type DemoChord, type DemoSong } from './songs';

export type Cue =
  | { kind: 'pose'; beat: number; chordIdx: number; left: { mask: number; tilt: number }; right: { mask: number; thumb: -1 | 0 | 1 } }
  /** left fist (mask 0) -> degree 0 -> ChordOff */
  | { kind: 'rest'; beat: number }
  /** one-frame z drop of the left hand */
  | { kind: 'bass'; beat: number }
  /** 8-frame thumb-index pinch window */
  | { kind: 'pinch'; beat: number; on: boolean }
  /** latch: stop all motion */
  | { kind: 'freeze'; beat: number }
  /** hands leave (only after a latch) */
  | { kind: 'exit'; beat: number }
  /** hands return, still holding the pose of chord poseOf (the latched chord), so nothing changes before the next pose cue */
  | { kind: 'enter'; beat: number; poseOf: number };

export interface ExprSeg {
  from: number;
  /** end of the ramp (= chord end); values hold at (vol1, cut1) until the next segment */
  to: number;
  vol0: number;
  vol1: number;
  cut0: number;
  cut1: number;
  /** arp state after this chord's pinch (if any) has fired */
  arp: boolean;
  chordIdx: number;
}

export interface Timeline {
  beats: number;
  total: number;
  cues: Cue[];
  expr: ExprSeg[];
  chords: DemoChord[];
}

/** Right-hand height at the song start / when no chord ever set one. */
export const DEFAULT_VOL = 0.6;
export const DEFAULT_CUTOFF = 0.7;

/** Performer frame period the static parts of the timeline assume (the store measures the real one). */
export const NOMINAL_FRAME_MS = 32;
export const DEFAULT_STABLE_MS = 90;

/** Seconds after a latch chord's onset at which the hands stop moving. */
export const FREEZE_AFTER_S = 0.3;
/** Seconds the hands wait after the latch fires (latch_hold_ms 2000) before leaving. */
export const EXIT_AFTER_LATCH_S = 0.5;
/** Seconds before the next chord's pose lead at which the hands come back. */
export const ENTER_BEFORE_S = 0.4;
/** Latch hold used while a latch cue is running (the transient config otherwise disables latching). */
export const LATCH_HOLD_MS = 2000;

export const bits = (f: readonly boolean[]) => f.reduce((m, b, i) => m | (b ? 1 << i : 0), 0);

export function compile(song: Song | DemoSong, opts: { stableMs?: number; frameMs?: number } = {}): Timeline {
  const beats = beatsPerBar(song);
  const total = song.bars * beats;
  const bpm = song.bpm;
  const secToBeats = (s: number) => (s * bpm) / 60;
  const chords = (song.chords as DemoChord[]).slice().sort((a, b) => a.bar - b.bar || a.beat - b.beat);
  const cues: Cue[] = [];
  const expr: ExprSeg[] = [];
  let vol = DEFAULT_VOL;
  let cut = DEFAULT_CUTOFF;
  let arp = false;
  const lead = leadBeats('pose', { stableMs: opts.stableMs ?? DEFAULT_STABLE_MS, frameMs: opts.frameMs ?? NOMINAL_FRAME_MS, bpm });
  chords.forEach((c, i) => {
    const onset = chordOnset(c, beats);
    const end = onset + c.dur_beats;
    const next = chords[i + 1];
    const nextOnset = next ? chordOnset(next, beats) : total;
    const p = c.perf ?? {};
    cues.push({
      kind: 'pose',
      beat: onset,
      chordIdx: i,
      left: { mask: bits(leftFingersFor(c.degree)), tilt: tiltFor(QUALITY_INDEX[c.quality]) },
      // the thumb bit of rightFingersFor is the octave; the performer shows it as a thumb pose instead
      right: { mask: bits(rightFingersFor(SHAPE_INDEX[c.shape], 0)) & ~1, thumb: Math.max(-1, Math.min(1, c.octave)) as -1 | 0 | 1 },
    });
    for (const off of p.bass ?? []) cues.push({ kind: 'bass', beat: onset + off });
    if (p.arp) {
      cues.push({ kind: 'pinch', beat: onset + 0.25, on: p.arp === 'on' });
      arp = p.arp === 'on';
    }
    if (p.latch) {
      const freeze = onset + secToBeats(FREEZE_AFTER_S);
      const exit = freeze + secToBeats(LATCH_HOLD_MS / 1000 + EXIT_AFTER_LATCH_S);
      const enter = nextOnset - secToBeats(ENTER_BEFORE_S) - lead;
      cues.push({ kind: 'freeze', beat: freeze });
      cues.push({ kind: 'exit', beat: exit });
      cues.push({ kind: 'enter', beat: enter, poseOf: i });
    }
    // a gap before the next chord (or before the wrap) is a fist rest
    if (nextOnset > end + 1e-6) cues.push({ kind: 'rest', beat: end });
    const vol0 = p.vol ?? vol;
    const vol1 = p.volTo ?? vol0;
    const cut0 = p.cutoff ?? cut;
    const cut1 = p.cutoffTo ?? cut0;
    expr.push({ from: onset, to: end, vol0, vol1, cut0, cut1, arp, chordIdx: i });
    vol = vol1;
    cut = cut1;
  });
  cues.sort((a, b) => a.beat - b.beat || order(a) - order(b));
  return { beats, total, cues, expr, chords };
}

/** Tie-break for cues at the same beat: the pose first, then the things done on it. */
function order(c: Cue): number {
  switch (c.kind) {
    case 'enter':
      return 0;
    case 'pose':
      return 1;
    case 'rest':
      return 2;
    case 'bass':
      return 3;
    case 'pinch':
      return 4;
    case 'freeze':
      return 5;
    case 'exit':
      return 6;
  }
}

/** Continuous expression at a song beat position (wrapping). */
export function exprAt(tl: Timeline, beat: number): { vol: number; cutoff: number; arp: boolean; chordIdx: number; say: string } {
  const segs = tl.expr;
  if (segs.length === 0) return { vol: DEFAULT_VOL, cutoff: DEFAULT_CUTOFF, arp: false, chordIdx: -1, say: '' };
  const b = tl.total > 0 ? ((beat % tl.total) + tl.total) % tl.total : beat;
  // last segment starting at or before b; before the first onset the song wraps from its end
  let seg = segs[segs.length - 1];
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].from <= b + 1e-9) {
      seg = segs[i];
      break;
    }
  }
  const inSeg = seg.from <= b + 1e-9;
  const t = inSeg ? Math.max(0, Math.min(1, (b - seg.from) / Math.max(1e-6, seg.to - seg.from))) : 1;
  const vol = seg.vol0 + (seg.vol1 - seg.vol0) * t;
  const cutoff = seg.cut0 + (seg.cut1 - seg.cut0) * t;
  // arp flips when the pinch fires, a quarter beat after the onset
  let arp = false;
  let seen = false;
  for (const c of tl.cues) {
    if (c.kind !== 'pinch') continue;
    if (c.beat <= b + 1e-9) {
      arp = c.on;
      seen = true;
    }
  }
  if (!seen) {
    // before the first pinch of a pass the state is whatever the previous pass left
    for (const c of tl.cues) if (c.kind === 'pinch') arp = c.on;
  }
  return { vol, cutoff, arp, chordIdx: seg.chordIdx, say: tl.chords[seg.chordIdx]?.perf?.say ?? '' };
}

/**
 * How far ahead of its beat a cue must be issued, in beats.
 * A pose is fed on the first position tick at or after its due beat (ticks run
 * at twice the frame rate, so that adds 0..F/2), commits nCommit frames later
 * and reaches the engine within a block; the lead centres that arrival on the
 * middle of the second half of the sixteenth before the beat, where the
 * engine's grid quantize defers it to exactly the beat sample. Landing in the
 * first half instead would play the chord a whole sixteenth early, so the
 * centre matters: measured against the transport, the (nCommit + 0.5) F form
 * sat 9 ms too early and grazed that edge at 116-126 bpm.
 * ChordOff (rest) and everything else are unquantized.
 */
export function leadBeats(kind: Cue['kind'], o: { stableMs: number; frameMs: number; bpm: number }): number {
  const S = Math.max(60, Math.min(200, o.stableMs));
  const F = o.frameMs;
  const nCommit = Math.ceil(S / F - 1e-9);
  const step = 60000 / o.bpm / 4;
  const half = step / 2;
  let ms = 0;
  switch (kind) {
    case 'pose':
      ms = nCommit * F + F / 4 + half / 2 + 2;
      break;
    case 'rest':
      ms = (nCommit + 0.5) * F;
      break;
    case 'pinch':
      // the toggle fires on the 6th pinched frame; start the window early so it lands on the cue
      ms = 4.5 * F;
      break;
    default:
      ms = 0;
  }
  return (ms * o.bpm) / 60000;
}
