import { describe, expect, it } from 'vitest';
import { BUILTIN_SONGS, songById } from '../learn/songs';
import { DEMO_IDS } from './ids';
import { cutoffToTilt, DEMO_PASSES, DEMO_SONGS, demoById, validateDemoSong, volToY } from './songs';

describe('demo songs', () => {
  it('ids match DEMO_IDS in order and are distinct from the built-ins', () => {
    expect(DEMO_SONGS.map((s) => s.id)).toEqual([...DEMO_IDS]);
    for (const s of DEMO_SONGS) {
      expect(BUILTIN_SONGS.some((b) => b.id === s.id)).toBe(false);
      expect(demoById(s.id)).toBe(s);
      expect(songById(s.id)).toBe(s);
    }
    expect(demoById('nope')).toBeUndefined();
  });

  it('every song passes validateDemoSong', () => {
    for (const s of DEMO_SONGS) expect(validateDemoSong(s), s.name).toEqual([]);
    for (const s of BUILTIN_SONGS) expect(validateDemoSong(s), s.name).toEqual([]);
  });

  it('has the ranges the plan promises', () => {
    for (const s of DEMO_SONGS) {
      expect(s.bars).toBeGreaterThanOrEqual(8);
      expect(s.bars).toBeLessThanOrEqual(16);
      expect(s.tags).toContain('demo');
      expect(s.blurb.length).toBeGreaterThan(20);
      expect(s.features.length).toBeGreaterThan(3);
    }
    expect(new Set(DEMO_SONGS.map((s) => s.key)).size).toBe(DEMO_SONGS.length);
    expect(new Set(DEMO_SONGS.map((s) => s.bpm)).size).toBe(DEMO_SONGS.length);
    expect(DEMO_PASSES).toBe(2);
  });

  it('features cover the showcase list', () => {
    const all = new Set(DEMO_SONGS.flatMap((s) => s.features));
    for (const f of ['sevenths', 'first inversion', 'dominant 7th', 'octave up', 'octave down', 'filter', 'swell', 'flick bass', 'arpeggiator', 'latch', 'minor key']) {
      expect(all.has(f), f).toBe(true);
    }
  });

  it('the validator catches what the performer cannot play', () => {
    const base = structuredClone(DEMO_SONGS[1]);
    const bad = (mutate: (s: typeof base) => void) => {
      const s = structuredClone(base);
      mutate(s);
      return validateDemoSong(s);
    };
    expect(bad((s) => (s.key = 'Bb'))).not.toEqual([]);
    expect(bad((s) => (s.bpm = 160))).not.toEqual([]);
    expect(bad((s) => (s.bars = 17))).not.toEqual([]);
    expect(bad((s) => (s.chords[0].quality = 'diminished'))).not.toEqual([]);
    expect(bad((s) => (s.chords[0].octave = 2))).not.toEqual([]);
    expect(bad((s) => (s.chords[0].dur_beats = 5))).not.toEqual([]);
    expect(bad((s) => (s.chords[1] = { ...s.chords[0], bar: 2 }))).not.toEqual([]);
    expect(bad((s) => (s.chords[0].perf!.vol = 0.95))).not.toEqual([]);
    expect(bad((s) => (s.chords[0].perf!.cutoff = 0.1))).not.toEqual([]);
    expect(bad((s) => (s.chords[0].perf!.bass = [0, 0.2]))).not.toEqual([]);
    expect(bad((s) => (s.chords[0].perf!.bass = [4]))).not.toEqual([]);
    expect(bad((s) => (s.chords[8].perf!.bass = [0]))).not.toEqual([]); // octave -1 chord
    expect(bad((s) => (s.chords[0].perf!.arp = 'on'))).not.toEqual([]); // seventh shape
    expect(bad((s) => (s.chords[2].perf = { latch: true }))).not.toEqual([]); // 2 beats at 116 bpm
    // the overlap check
    expect(bad((s) => (s.chords[1].bar = 1))).not.toEqual([]);
  });

  it('volToY inverts the parser height curve and cutoffToTilt the tilt map', () => {
    for (const v of [0.15, 0.3, 0.6, 0.9]) {
      const y = volToY(v);
      const height = (0.85 - y) / 0.7;
      expect(Math.pow(height, 1.6)).toBeCloseTo(v, 6);
      expect(y).toBeGreaterThan(0.15);
      expect(y).toBeLessThan(0.85);
    }
    expect(cutoffToTilt(0.5)).toBeCloseTo(0);
    expect(cutoffToTilt(0.15)).toBeCloseTo(-31.5);
    expect(cutoffToTilt(0.95)).toBeCloseTo(40.5);
  });
});
