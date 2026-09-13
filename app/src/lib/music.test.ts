import { describe, expect, it } from 'vitest';
import { chordName, decodeEvents, decodePosition, decodeState, degreeRoot, diatonicQuality, EVENT_FLOATS, hueOf, stepFifths, STATE_FLOATS } from './music';
import { parsePath, pathFor } from './router/router.svelte';
import { judge, leftFingersFor, newScore, rightFingersFor, scorePercent, songTargets, BUILTIN_SONGS } from './learn/songs';
import { GhostTrack } from './tracking/landmarks';

describe('music helpers mirror gsyn-core', () => {
  it('names chords like the Rust side', () => {
    expect(chordName(4, 0, 2)).toBe('IV maj7');
    expect(chordName(4, 0, 1)).toBe('IV / 1st inv');
    expect(chordName(2, 1, 2)).toBe('ii m7');
    expect(chordName(7, 2, 0)).toBe('vii° dim');
    expect(chordName(5, 0, 3)).toBe('V dom7');
    expect(chordName(0, 0, 0)).toBe('');
  });
  it('walks the circle of fifths and hues', () => {
    expect(stepFifths(0, 1)).toBe(7);
    expect(stepFifths(0, -1)).toBe(5);
    expect(hueOf(7)).toBe(30);
    expect(degreeRoot(0, false, 5)).toBe(7);
    expect(diatonicQuality(7, false)).toBe(2);
    expect(diatonicQuality(3, true)).toBe(0);
  });
  it('decodes the flat state layout', () => {
    const f = new Float32Array(STATE_FLOATS);
    f[0] = 2; // D
    f[1] = 1; // minor
    f[2] = 4;
    f[3] = 1;
    f[4] = 2;
    f[5] = -1;
    f[6] = 0.3;
    f[7] = 0.9;
    f[16] = 3;
    f[17] = 50;
    f[18] = 53;
    f[19] = 57;
    const s = decodeState(f);
    expect(s).toMatchObject({ key: 2, minor: true, degree: 4, quality: 1, shape: 2, octave: -1, notes: [50, 53, 57] });
  });
  it('decodes events', () => {
    const f = new Float32Array(EVENT_FLOATS * 2);
    f[0] = 1;
    f[1] = 3;
    f[2] = 48 + 128 * 52;
    f[3] = 55;
    f[4] = 1;
    f[8] = 6;
    f[9] = 36;
    const ev = decodeEvents(f, 2);
    expect(ev[0]).toEqual({ type: 'chord_on', notes: [48, 52, 55], degree: 1, quality: 0, shape: 0, octave: 0 });
    expect(ev[1]).toEqual({ type: 'bass', note: 36 });
  });
  it('decodes position', () => {
    const f = new Float32Array(21);
    f[0] = 2;
    f[1] = 3;
    f[2] = 2;
    f[5] = 120;
    f[9] = -1;
    f[11] = 2;
    f[12] = 1;
    f[16] = 5;
    f[17] = 1;
    const p = decodePosition(f);
    expect(p.state).toBe(2);
    expect(p.countIn).toBeNull();
    expect(p.recording).toBe(2);
    expect(p.recTrack).toBe(1);
    expect(p.now).toBe(5 + 16777216);
  });
});

describe('router', () => {
  it('maps spec entry points', () => {
    expect(parsePath('/')).toEqual({ page: 'play' });
    expect(parsePath('/song/abc')).toEqual({ page: 'builder', kind: 'song', id: 'abc' });
    expect(parsePath('/loop/x1')).toEqual({ page: 'play', kind: 'loop', id: 'x1' });
    expect(parsePath('/learn/four-chords')).toEqual({ page: 'learn', kind: 'learn', id: 'four-chords' });
    expect(parsePath('/preset/p')).toEqual({ page: 'instruments', kind: 'preset', id: 'p' });
    expect(parsePath('/open', '?u=gsyn%3A%2F%2Floop%2Fzz')).toEqual({ page: 'play', kind: 'loop', id: 'zz' });
    expect(pathFor({ page: 'learn', kind: 'learn', id: 'a b' })).toBe('/learn/a%20b');
    expect(pathFor({ page: 'settings' })).toBe('/settings');
  });
});

describe('tutorial scoring', () => {
  it('builds targets and judges timing + shape', () => {
    const t = songTargets(BUILTIN_SONGS[0]);
    expect(t).toHaveLength(4);
    expect(t[1].startBeat).toBe(4);
    let s = newScore();
    s = judge(s, t[0], 0.1, { degree: 1, quality: 0, shape: 0, octave: 0 });
    expect(s.lastJudgement).toBe('perfect');
    s = judge(s, t[1], 4.6, { degree: 5, quality: 0, shape: 0, octave: 0 });
    expect(s.lastJudgement).toBe('good');
    s = judge(s, t[2], 8.2, { degree: 2, quality: 1, shape: 0, octave: 0 });
    expect(s.lastJudgement).toBe('miss');
    expect(scorePercent(s)).toBeGreaterThan(40);
    expect(scorePercent(s)).toBeLessThan(80);
  });
  it('finger tables match the spec', () => {
    expect(leftFingersFor(5)).toEqual([true, true, true, true, true]);
    expect(leftFingersFor(6)).toEqual([false, true, false, false, true]);
    expect(leftFingersFor(7)).toEqual([true, true, false, false, true]);
    expect(rightFingersFor(2)).toEqual([false, true, true, true, false]);
    expect(rightFingersFor(3, 1)).toEqual([true, true, true, true, true]);
  });
});

describe('ghost track', () => {
  it('interpolates and wraps', () => {
    const g = new GhostTrack();
    const a = new Array(63).fill(0);
    const b = new Array(63).fill(1);
    g.set([{ t: 0, left: a }, { t: 1000, left: b }], 2000);
    const [l0] = g.sample(500);
    expect(l0![0]).toBeCloseTo(0.5);
    const [l1] = g.sample(1500);
    expect(l1![0]).toBeCloseTo(0.5); // wrapping back toward frame 0
    expect(g.sample(0)[1]).toBeNull();
  });
});
