import { describe, expect, it } from 'vitest';
import { BUILTIN_SONGS } from '../learn/songs';
import { DEMO_SONGS } from '../demo/songs';
import { difficultyOf } from './difficulty';

const byId = (id: string) => [...BUILTIN_SONGS, ...DEMO_SONGS].find((s) => s.id === id)!;

describe('difficultyOf', () => {
  it('rates the beginner four-chord loop as one hand', () => {
    expect(difficultyOf(byId('four-chords')).hands).toBe(1);
  });
  it('rates the fast sixteen-bar demo as the hardest', () => {
    const all = [...BUILTIN_SONGS, ...DEMO_SONGS].map((s) => difficultyOf(s));
    const cb = difficultyOf(byId('circuit-breaker'));
    expect(cb.hands).toBe(5);
    expect(Math.max(...all.map((d) => d.score))).toBe(cb.score);
  });
  it('spreads the built-in and demo songs across at least four buckets', () => {
    const buckets = new Set([...BUILTIN_SONGS, ...DEMO_SONGS].map((s) => difficultyOf(s).hands));
    expect(buckets.size).toBeGreaterThanOrEqual(4);
  });
  it('is monotonic in the obvious directions', () => {
    const base = byId('four-chords');
    const faster = { ...base, bpm: base.bpm + 50 };
    const busier = { ...base, chords: [...base.chords, ...base.chords.map((c) => ({ ...c, beat: 3, dur_beats: 2 }))] };
    expect(difficultyOf(faster).score).toBeGreaterThan(difficultyOf(base).score);
    expect(difficultyOf(busier).score).toBeGreaterThan(difficultyOf(base).score);
  });
});
