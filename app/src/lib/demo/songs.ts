// Demo songs: ordinary song files (spec 10) plus a per-chord performance
// layer that tells the synthetic performer how to play them. Pure data and
// validation; no Svelte. Only types come from ../learn/songs so that module
// can import DEMO_SONGS at runtime without a cycle.

import type { Song, SongChord } from '../learn/songs';
import { PITCH_NAMES, TIME_SIGS } from '../music';
import { DEMO_IDS, type DemoId } from './ids';

export interface ChordPerf {
  /** right-hand height as volume at onset, 0.15..0.9; omitted = carry the previous end value (song start: 0.6) */
  vol?: number;
  /** linear ramp target across [onset, onset+dur_beats]; while the arp is on this drives the arp rate instead */
  volTo?: number;
  /** 0.15..0.95 at onset (omitted = carry; song start 0.7); right tilt = cutoff*90 - 45 deg */
  cutoff?: number;
  /** ramp target */
  cutoffTo?: number;
  /** flick bass hits at these beat offsets from onset; each in [0, dur_beats), >= 0.35 s apart */
  bass?: number[];
  /** pinch 0.25 beat after onset; shape must be 'root'; cutoff of this cue >= 0.25 */
  arp?: 'on' | 'off';
  /** freeze from onset+0.3 s, hands leave 0.3 s after the latch fires; requires dur_beats*60/bpm >= 4 */
  latch?: boolean;
  /** caption in the DEMO badge while this chord is current */
  say?: string;
}

export type DemoChord = SongChord & { perf?: ChordPerf };

export interface DemoSong extends Omit<Song, 'id' | 'chords'> {
  id: DemoId;
  chords: DemoChord[];
  blurb: string;
  features: string[];
}

/** Every song plays this many passes in cycle/once mode. */
export const DEMO_PASSES = 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Wrist y for a volume: inverse of the parser's height curve (gesture.rs, volume = height^1.6 over top_y 0.15 .. bottom_y 0.85). */
export const volToY = (v: number) => 0.85 - 0.7 * Math.pow(clamp(v, 0, 1), 1 / 1.6);
/** Right-hand tilt for a cutoff: inverse of cutoff = (tilt + 45) / 90 (gesture.rs). */
export const cutoffToTilt = (c: number) => clamp(c, 0, 1) * 90 - 45;

const SHAPES: SongChord['shape'][] = ['root', 'inv1', 'seventh', 'dom_or_dim7'];
const QUALITIES: SongChord['quality'][] = ['major', 'minor', 'diminished'];

const hints = { left_scheme: { kind: 'full' }, right_scheme: { kind: 'full' } };

function ch(bar: number, beat: number, degree: number, quality: SongChord['quality'], shape: SongChord['shape'], octave: number, dur_beats: number, perf?: ChordPerf): DemoChord {
  const c: DemoChord = { bar, beat, degree, quality, shape, octave, dur_beats };
  if (perf) c.perf = perf;
  return c;
}

export const DEMO_SONGS: DemoSong[] = [
  {
    version: 1,
    id: 'lantern-waltz',
    name: 'Lantern Waltz',
    author: 'Gesture Synth',
    bpm: 92,
    time_sig: '3/4',
    key: 'B',
    mode: 'major',
    bars: 8,
    instrument: 'Keys',
    tags: ['demo', 'beginner'],
    hints,
    blurb: 'A gentle waltz in B: one idea per bar, so each finger change can be read. The degree table, major and minor tilt, a first inversion, a swell, a filter close and a fist rest.',
    features: ['degree table', 'major/minor tilt', 'first inversion', 'swell', 'filter', 'rest', 'waltz'],
    chords: [
      ch(1, 1, 1, 'major', 'root', 0, 3, { vol: 0.5, cutoff: 0.6, say: 'Left hand, one finger: the I chord' }),
      ch(2, 1, 5, 'major', 'root', 0, 3, { vol: 0.55, say: 'All five fingers: V' }),
      ch(3, 1, 6, 'minor', 'root', 0, 3, { vol: 0.6, say: 'Tilt the left palm in: minor' }),
      ch(4, 1, 4, 'major', 'root', 0, 3, { vol: 0.6, volTo: 0.75, say: 'Raise the right hand: louder' }),
      ch(5, 1, 1, 'major', 'inv1', 0, 3, { vol: 0.7, cutoff: 0.85, say: 'Two right fingers: first inversion' }),
      ch(6, 1, 3, 'minor', 'root', 0, 3, { vol: 0.65, say: 'Three fingers up, palm in: iii' }),
      ch(7, 1, 2, 'minor', 'root', 0, 3, { vol: 0.6, cutoff: 0.9, cutoffTo: 0.45, say: 'Tilt the right hand: the filter closes' }),
      ch(8, 1, 5, 'major', 'root', 0, 2, { vol: 0.7, cutoff: 0.45, cutoffTo: 0.9, say: 'Fist on beat three: rest' }),
    ],
  },
  {
    version: 1,
    id: 'brass-tacks',
    name: 'Brass Tacks',
    author: 'Gesture Synth',
    bpm: 116,
    time_sig: '4/4',
    key: 'F#',
    mode: 'major',
    bars: 8,
    instrument: 'Organ',
    tags: ['demo', 'jazz'],
    hints,
    blurb: 'A turnaround in F# with sevenths, a dominant, octave pops up and down, and bass flicks on every downbeat.',
    features: ['sevenths', 'dominant 7th', 'octave up', 'octave down', 'two chords a bar', 'flick bass', 'swell', 'filter'],
    chords: [
      ch(1, 1, 1, 'major', 'seventh', 0, 4, { vol: 0.6, cutoff: 0.75, bass: [0], say: 'Three right fingers: a seventh. Flick the left hand: bass' }),
      ch(2, 1, 6, 'minor', 'seventh', 0, 4, { bass: [0], say: 'Palm tilted in: a minor seventh' }),
      ch(3, 1, 2, 'minor', 'seventh', 0, 2, { bass: [0] }),
      ch(3, 3, 5, 'major', 'dom_or_dim7', 0, 2, { bass: [0], say: 'Four fingers: dominant seventh' }),
      ch(4, 1, 1, 'major', 'seventh', 1, 4, { vol: 0.65, bass: [0], say: 'Thumb out: up an octave' }),
      ch(5, 1, 4, 'major', 'seventh', 0, 4, { bass: [0], say: 'Thumb tucked: back down' }),
      ch(6, 1, 3, 'minor', 'seventh', 0, 2, { bass: [0] }),
      ch(6, 3, 6, 'minor', 'seventh', 0, 2, { bass: [0] }),
      ch(7, 1, 2, 'minor', 'seventh', -1, 4, { vol: 0.55, volTo: 0.8, cutoff: 0.5, cutoffTo: 0.95, say: 'Thumb folded in: an octave down. Raise and tilt the right hand: swell' }),
      ch(8, 1, 5, 'major', 'dom_or_dim7', 0, 2, { vol: 0.75, cutoff: 0.8, bass: [0] }),
      ch(8, 3, 5, 'major', 'dom_or_dim7', 1, 2, { vol: 0.8, bass: [0, 1], say: 'Octave pop into the top' }),
    ],
  },
  {
    version: 1,
    id: 'slow-orbit',
    name: 'Slow Orbit',
    author: 'Gesture Synth',
    bpm: 64,
    time_sig: '4/4',
    key: 'G#',
    mode: 'minor',
    bars: 8,
    instrument: 'Pad',
    tags: ['demo', 'ambient'],
    hints,
    blurb: 'A slow pad in G# minor: minor-key tilt flips, the pinch arpeggiator with its rate on the right hand, a long swell over a first inversion, and a latched chord that keeps ringing after both hands leave.',
    features: ['minor key', 'major/minor tilt', 'arpeggiator', 'first inversion', 'swell', 'filter', 'latch'],
    chords: [
      ch(1, 1, 1, 'minor', 'root', 0, 4, { vol: 0.5, cutoff: 0.45, say: 'Minor key: the palm tilts in for i' }),
      ch(2, 1, 6, 'major', 'root', 0, 4, { vol: 0.55, say: 'Palm out: a major VI' }),
      ch(3, 1, 3, 'major', 'root', 0, 4, { vol: 0.55, volTo: 0.85, arp: 'on', say: 'Pinch thumb and index: arpeggiator. Height is the rate' }),
      ch(4, 1, 7, 'major', 'root', 0, 4, { vol: 0.85, volTo: 0.3, say: 'Lower the hand: slower' }),
      ch(5, 1, 4, 'minor', 'root', 0, 4, { vol: 0.55, volTo: 0.6, arp: 'off', say: 'Pinch again: arpeggiator off' }),
      ch(6, 1, 1, 'minor', 'inv1', 0, 4, { vol: 0.5, volTo: 0.75, cutoff: 0.45, cutoffTo: 0.85, say: 'Two fingers: first inversion' }),
      ch(7, 1, 6, 'major', 'seventh', 0, 8, { vol: 0.65, cutoff: 0.6, latch: true, say: 'Hold still: the chord latches and the hands can leave' }),
    ],
  },
  {
    version: 1,
    id: 'circuit-breaker',
    name: 'Circuit Breaker',
    author: 'Gesture Synth',
    bpm: 126,
    time_sig: '4/4',
    key: 'D#',
    mode: 'minor',
    bars: 16,
    instrument: 'Lead',
    tags: ['demo', 'synthwave'],
    hints,
    blurb: 'A driving lead in D# minor over sixteen bars: two chords a bar, octave pops both ways, sevenths and dominants, first inversions under a four-bar filter sweep, bass flicks and a fist rest before the loop.',
    features: ['minor key', 'octave up', 'octave down', 'sevenths', 'dominant 7th', 'first inversion', 'filter', 'swell', 'flick bass', 'two chords a bar', 'rest'],
    chords: [
      // A: roots and octave pops
      ch(1, 1, 1, 'minor', 'root', 0, 2, { vol: 0.7, cutoff: 0.6, bass: [0], say: 'Flick on the downbeat: bass' }),
      ch(1, 3, 1, 'minor', 'root', 1, 2, { say: 'Thumb out: octave pop' }),
      ch(2, 1, 6, 'major', 'root', 0, 2, { bass: [0] }),
      ch(2, 3, 6, 'major', 'root', 1, 2),
      ch(3, 1, 3, 'major', 'root', 0, 2, { bass: [0] }),
      ch(3, 3, 7, 'major', 'root', 0, 2, { bass: [0] }),
      ch(4, 1, 4, 'minor', 'root', 0, 2, { bass: [0] }),
      ch(4, 3, 5, 'major', 'root', 0, 2, { say: 'Major V in a minor key: palm out' }),
      // B: sevenths
      ch(5, 1, 1, 'minor', 'seventh', 0, 4, { bass: [0], say: 'Three fingers: sevenths' }),
      ch(6, 1, 6, 'major', 'seventh', 0, 4, { bass: [0] }),
      ch(7, 1, 3, 'major', 'seventh', 0, 2, { bass: [0] }),
      ch(7, 3, 7, 'major', 'dom_or_dim7', 0, 2, { say: 'Four fingers: dominant seventh' }),
      ch(8, 1, 4, 'minor', 'seventh', 0, 2, { bass: [0] }),
      ch(8, 3, 5, 'major', 'dom_or_dim7', 0, 2, { bass: [0] }),
      // C: inversions under a filter sweep and a volume build
      ch(9, 1, 1, 'minor', 'inv1', 0, 4, { vol: 0.5, cutoff: 0.2, cutoffTo: 0.35, say: 'Filter closed, first inversions: tilt the right hand open over four bars' }),
      ch(10, 1, 6, 'major', 'inv1', 0, 4, { vol: 0.6, cutoff: 0.35, cutoffTo: 0.55 }),
      ch(11, 1, 3, 'major', 'inv1', 0, 2, { vol: 0.7, cutoff: 0.55, cutoffTo: 0.7 }),
      ch(11, 3, 7, 'major', 'root', 0, 2, { cutoff: 0.7, cutoffTo: 0.8 }),
      ch(12, 1, 4, 'minor', 'inv1', 0, 2, { vol: 0.8, cutoff: 0.8, cutoffTo: 0.9 }),
      ch(12, 3, 5, 'major', 'dom_or_dim7', 0, 2, { vol: 0.85, cutoff: 0.9, cutoffTo: 0.95, bass: [0] }),
      // D: climax, octaves both ways
      ch(13, 1, 1, 'minor', 'root', -1, 2, { vol: 0.9, cutoff: 0.8, say: 'Thumb folded: an octave down' }),
      ch(13, 3, 1, 'minor', 'root', 1, 2, { bass: [0], say: '...and up' }),
      ch(14, 1, 6, 'major', 'root', -1, 2),
      ch(14, 3, 6, 'major', 'root', 1, 2, { bass: [0] }),
      ch(15, 1, 3, 'major', 'root', 1, 2, { bass: [0] }),
      ch(15, 3, 7, 'major', 'root', 1, 2, { bass: [0] }),
      ch(16, 1, 5, 'major', 'dom_or_dim7', 0, 2, { vol: 0.9, volTo: 0.6, bass: [0], say: 'Fist: rest before the loop' }),
    ],
  },
];

export function demoById(id: string): DemoSong | undefined {
  return DEMO_SONGS.find((s) => s.id === id);
}

export function beatsPerBar(song: Pick<Song, 'time_sig'>): number {
  return Number(song.time_sig.split('/')[0]) || 4;
}

/** Song-relative onset of a chord in beats. */
export function chordOnset(c: SongChord, beats: number): number {
  return (c.bar - 1) * beats + (c.beat - 1);
}

/**
 * Check that a song can be performed by the synthetic player. Returns a list of
 * problems, empty when the song is valid. The limits mirror what the parser and
 * the lead math can actually reach (see the demo plan, section 3).
 */
export function validateDemoSong(s: Song | DemoSong): string[] {
  const errs: string[] = [];
  if (!(PITCH_NAMES as readonly string[]).includes(s.key)) errs.push(`key ${s.key}: use sharps (C, C#, ...)`);
  if (s.mode !== 'major' && s.mode !== 'minor') errs.push(`mode ${s.mode}`);
  if (!(s.bpm >= 40 && s.bpm <= 140)) errs.push(`bpm ${s.bpm} outside 40..140`);
  if (!(Number.isInteger(s.bars) && s.bars >= 1 && s.bars <= 16)) errs.push(`bars ${s.bars} outside 1..16`);
  if (!(TIME_SIGS as readonly string[]).includes(s.time_sig)) errs.push(`time signature ${s.time_sig}`);
  const beats = beatsPerBar(s);
  const secPerBeat = 60 / (s.bpm || 100);
  const chords = s.chords as DemoChord[];
  if (!chords.length) errs.push('no chords');
  let prevEnd = -1;
  let prev: DemoChord | null = null;
  let lastArpBeat = -1e9;
  chords.forEach((c, i) => {
    const at = `chord ${i + 1} (${c.bar}.${c.beat})`;
    if (!(Number.isInteger(c.bar) && c.bar >= 1 && c.bar <= s.bars)) errs.push(`${at}: bar outside 1..${s.bars}`);
    if (!(c.beat >= 1)) errs.push(`${at}: beat < 1`);
    if (!(c.dur_beats >= 1)) errs.push(`${at}: dur_beats < 1`);
    if (c.beat > beats) errs.push(`${at}: beat outside the bar`);
    if (!(Number.isInteger(c.degree) && c.degree >= 1 && c.degree <= 7)) errs.push(`${at}: degree outside 1..7`);
    if (!QUALITIES.includes(c.quality)) errs.push(`${at}: quality ${c.quality}`);
    if (c.quality === 'diminished') errs.push(`${at}: diminished cannot be shown by tilt`);
    if (!SHAPES.includes(c.shape)) errs.push(`${at}: shape ${c.shape}`);
    if (![-1, 0, 1].includes(c.octave)) errs.push(`${at}: octave outside -1..1`);
    const onset = chordOnset(c, beats);
    const end = onset + c.dur_beats;
    // a chord may span bars (a held latch chord does), but not the loop end
    if (end > s.bars * beats + 1e-6) errs.push(`${at}: runs past the loop end`);
    if (prev && onset < prevEnd - 1e-6) errs.push(`${at}: overlaps the previous chord`);
    if (prev && onset < chordOnset(prev, beats)) errs.push(`${at}: chords must be sorted by bar and beat`);
    if (prev && onset - prevEnd < 1 - 1e-6 && same(prev, c)) errs.push(`${at}: identical to the previous chord (the parser only fires on a change)`);
    const p = c.perf;
    if (p) {
      for (const [k, v] of [['vol', p.vol], ['volTo', p.volTo]] as const) if (v !== undefined && !(v >= 0.15 && v <= 0.9)) errs.push(`${at}: ${k} ${v} outside 0.15..0.9`);
      for (const [k, v] of [['cutoff', p.cutoff], ['cutoffTo', p.cutoffTo]] as const) if (v !== undefined && !(v >= 0.15 && v <= 0.95)) errs.push(`${at}: ${k} ${v} outside 0.15..0.95`);
      if (p.bass) {
        const sorted = p.bass.slice().sort((a, b) => a - b);
        for (const b of sorted) if (!(b >= 0 && b < c.dur_beats)) errs.push(`${at}: bass offset ${b} outside [0, ${c.dur_beats})`);
        for (let k = 1; k < sorted.length; k++) if ((sorted[k] - sorted[k - 1]) * secPerBeat < 0.35 - 1e-9) errs.push(`${at}: bass hits closer than 0.35 s`);
        if (c.octave === -1 && sorted.length) errs.push(`${at}: no bass on an octave -1 chord (below MIDI 30)`);
      }
      if (p.arp) {
        if (c.shape !== 'root') errs.push(`${at}: arp cues need the root shape`);
        const cut = p.cutoff ?? carriedCutoff(chords, i);
        if (cut < 0.25) errs.push(`${at}: arp cue with cutoff ${cut} < 0.25`);
        if (onset - lastArpBeat < 2) errs.push(`${at}: two arp cues within 2 beats`);
        lastArpBeat = onset;
      }
      if (p.latch) {
        if (c.dur_beats * secPerBeat < 4) errs.push(`${at}: latch cue shorter than 4 s`);
        const next = chords[i + 1];
        const nextOnset = next ? chordOnset(next, beats) : s.bars * beats;
        if (nextOnset > end + 1e-6) errs.push(`${at}: a latch cue must not be followed by a rest`);
        if (!next && end < s.bars * beats - 1e-6) errs.push(`${at}: a latch cue must not be followed by a rest`);
      }
    }
    prevEnd = end;
    prev = c;
  });
  const last = chords[chords.length - 1];
  const first = chords[0];
  if (last && first && chords.length > 1) {
    const lastEnd = chordOnset(last, beats) + last.dur_beats;
    const total = s.bars * beats;
    if (lastEnd > total + 1e-6) errs.push('last chord runs past the loop end');
    if (lastEnd >= total - 1e-6 && chordOnset(first, beats) === 0 && same(last, first)) errs.push('last and first chord are identical across the loop wrap');
  }
  return errs;
}

function same(a: SongChord, b: SongChord): boolean {
  return a.degree === b.degree && a.quality === b.quality && a.shape === b.shape && a.octave === b.octave;
}

/** Cutoff in effect at chord i when it does not set its own (song start: 0.7). */
function carriedCutoff(chords: DemoChord[], i: number): number {
  for (let k = i - 1; k >= 0; k--) {
    const p = chords[k].perf;
    if (p?.cutoffTo !== undefined) return p.cutoffTo;
    if (p?.cutoff !== undefined) return p.cutoff;
  }
  return 0.7;
}

export { DEMO_IDS };
