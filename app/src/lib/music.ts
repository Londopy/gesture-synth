// TS mirror of the small part of gsyn-core the UI needs without a WASM call:
// names, hues, and decoding of the flat state/event arrays.

export const STATE_FLOATS = 24;
export const EVENT_FLOATS = 8;
export const POSITION_FLOATS = 21;

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export const PITCH_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
/** Circle of fifths, clockwise from C, as pitch-class indices. */
export const FIFTHS: readonly number[] = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'] as const;

export type Quality = 0 | 1 | 2; // major, minor, diminished
export type Shape = 0 | 1 | 2 | 3; // root, inv1, seventh, dom/dim7

export const SHAPE_NAMES = ['Root', '1st inversion', 'Seventh', 'Dom7 / m7b5'] as const;
export const QUALITY_NAMES = ['Major', 'Minor', 'Diminished'] as const;

export function fifthsIndex(pc: number): number {
  return ((pc % 12) + 12) % 12 * 7 % 12;
}

export function hueOf(pc: number): number {
  return fifthsIndex(pc) * 30;
}

export function stepFifths(pc: number, n: number): number {
  const i = (fifthsIndex(pc) + n) % 12;
  return FIFTHS[(i + 12) % 12];
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function noteName(midi: number): string {
  return `${PITCH_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

export function roman(degree: number, quality: Quality): string {
  const r = ROMAN[Math.max(1, Math.min(7, degree)) - 1];
  if (quality === 0) return r;
  if (quality === 1) return r.toLowerCase();
  return r.toLowerCase() + '°';
}

export function chordName(degree: number, quality: Quality, shape: Shape, halfDim = true): string {
  if (degree < 1) return '';
  const n = roman(degree, quality);
  const table: Record<string, string> = {
    '0-0': '',
    '0-1': ' / 1st inv',
    '0-2': ' maj7',
    '0-3': ' dom7',
    '1-0': ' m',
    '1-1': ' m / 1st inv',
    '1-2': ' m7',
    '1-3': halfDim ? ' m7b5' : ' dim7',
    '2-0': ' dim',
    '2-1': ' dim / 1st inv',
    '2-2': ' m7b5',
    '2-3': ' dim7',
  };
  return n + (table[`${quality}-${shape}`] ?? '');
}

export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

export function degreeRoot(key: number, minor: boolean, degree: number): number {
  const sc = minor ? MINOR_SCALE : MAJOR_SCALE;
  return (key + sc[Math.max(1, Math.min(7, degree)) - 1]) % 12;
}

export function diatonicQuality(degree: number, minor: boolean): Quality {
  const d = Math.max(1, Math.min(7, degree));
  if (!minor) return d === 1 || d === 4 || d === 5 ? 0 : d === 7 ? 2 : 1;
  return d === 1 || d === 4 || d === 5 ? 1 : d === 2 ? 2 : 0;
}

export interface LiveState {
  key: number;
  minor: boolean;
  degree: number;
  quality: Quality;
  shape: Shape;
  octave: number;
  cutoff: number;
  volume: number;
  pan: number;
  arp: boolean;
  arpRate: number;
  latched: boolean;
  theremin: boolean;
  thereminHz: number;
  thereminVol: number;
  thereminVib: number;
  notes: number[];
  confidence: number;
}

export function defaultState(): LiveState {
  return {
    key: 0,
    minor: false,
    degree: 0,
    quality: 0,
    shape: 0,
    octave: 0,
    cutoff: 0.7,
    volume: 0,
    pan: 0,
    arp: false,
    arpRate: 0.5,
    latched: false,
    theremin: false,
    thereminHz: 220,
    thereminVol: 0,
    thereminVib: 0,
    notes: [],
    confidence: 0,
  };
}

export function decodeState(f: ArrayLike<number>, into?: LiveState): LiveState {
  const s = into ?? defaultState();
  s.key = f[0] | 0;
  s.minor = f[1] >= 0.5;
  s.degree = f[2] | 0;
  s.quality = (f[3] | 0) as Quality;
  s.shape = (f[4] | 0) as Shape;
  s.octave = Math.round(f[5]);
  s.cutoff = f[6];
  s.volume = f[7];
  s.pan = f[8];
  s.arp = f[9] >= 0.5;
  s.arpRate = f[10];
  s.latched = f[11] >= 0.5;
  s.theremin = f[12] >= 0.5;
  s.thereminHz = f[13];
  s.thereminVol = f[14];
  s.thereminVib = f[15];
  const n = f[16] | 0;
  const notes: number[] = [];
  for (let i = 0; i < n; i++) notes.push(f[17 + i] | 0);
  s.notes = notes;
  s.confidence = f[21];
  return s;
}

export type GEvent =
  | { type: 'chord_on'; notes: number[]; degree: number; quality: Quality; shape: Shape; octave: number }
  | { type: 'chord_off' }
  | { type: 'param'; cutoff: number; volume: number; pan: number }
  | { type: 'arp'; on: boolean }
  | { type: 'key'; key: number; minor: boolean }
  | { type: 'bass'; note: number }
  | { type: 'latch'; on: boolean };

export function decodeEvents(f: ArrayLike<number>, n: number): GEvent[] {
  const out: GEvent[] = [];
  for (let i = 0; i < n; i++) {
    const b = i * EVENT_FLOATS;
    const t = f[b] | 0;
    switch (t) {
      case 1: {
        const c = f[b + 1] | 0;
        const n01 = f[b + 2] | 0;
        const n23 = f[b + 3] | 0;
        const notes = [n01 % 128, Math.floor(n01 / 128), n23 % 128, Math.floor(n23 / 128)].slice(0, c);
        out.push({ type: 'chord_on', notes, degree: f[b + 4] | 0, quality: (f[b + 5] | 0) as Quality, shape: (f[b + 6] | 0) as Shape, octave: Math.round(f[b + 7]) });
        break;
      }
      case 2:
        out.push({ type: 'chord_off' });
        break;
      case 3:
        out.push({ type: 'param', cutoff: f[b + 1], volume: f[b + 2], pan: f[b + 3] });
        break;
      case 4:
        out.push({ type: 'arp', on: f[b + 1] >= 0.5 });
        break;
      case 5:
        out.push({ type: 'key', key: f[b + 1] | 0, minor: f[b + 2] >= 0.5 });
        break;
      case 6:
        out.push({ type: 'bass', note: f[b + 1] | 0 });
        break;
      case 7:
        out.push({ type: 'latch', on: f[b + 1] >= 0.5 });
        break;
    }
  }
  return out;
}

export type TransportState = 0 | 1 | 2; // stopped, count-in, playing
export type RecordStatus = 0 | 1 | 2; // idle, armed, recording

export interface Position {
  state: TransportState;
  bar: number;
  beat: number;
  step: number;
  phase: number;
  bpm: number;
  beats: number;
  unit: number;
  bars: number;
  countIn: number | null;
  loopCount: number;
  recording: RecordStatus;
  recTrack: number | null;
  selected: number;
  position: number;
  loopLen: number;
  now: number;
  lastBeat: number;
  lastBeatBar: boolean;
  beatSeq: number;
}

export function defaultPosition(): Position {
  return {
    state: 0,
    bar: 1,
    beat: 1,
    step: 0,
    phase: 0,
    bpm: 100,
    beats: 4,
    unit: 4,
    bars: 4,
    countIn: null,
    loopCount: 0,
    recording: 0,
    recTrack: null,
    selected: 0,
    position: 0,
    loopLen: 1,
    now: 0,
    lastBeat: 0,
    lastBeatBar: false,
    beatSeq: 0,
  };
}

export function decodePosition(f: ArrayLike<number>, into?: Position): Position {
  const p = into ?? defaultPosition();
  p.state = (f[0] | 0) as TransportState;
  p.bar = f[1] | 0;
  p.beat = f[2] | 0;
  p.step = f[3] | 0;
  p.phase = f[4];
  p.bpm = f[5];
  p.beats = f[6] | 0;
  p.unit = f[7] | 0;
  p.bars = f[8] | 0;
  p.countIn = f[9] < 0 ? null : f[9] | 0;
  p.loopCount = f[10] | 0;
  p.recording = (f[11] | 0) as RecordStatus;
  p.recTrack = f[12] < 0 ? null : f[12] | 0;
  p.selected = f[13] | 0;
  p.position = f[14];
  p.loopLen = f[15];
  p.now = f[16] + f[17] * 16777216;
  p.lastBeat = f[18] | 0;
  p.lastBeatBar = f[19] >= 0.5;
  p.beatSeq = f[20] | 0;
  return p;
}

export const TIME_SIGS = ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8'] as const;

export function stepsPerBar(beats: number, unit: number): number {
  return beats * (unit === 8 ? 2 : 4);
}
