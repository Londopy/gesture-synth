import { describe, expect, it } from 'vitest';
import type { TutorialTarget } from '../learn/songs';
import { accuracy, applyHit, judgeHit, newSetScore, rankFor, rating, variationMultiplier, WINDOWS } from './score';

const t: TutorialTarget = { index: 0, degree: 1, quality: 0, shape: 0, octave: 0, startBeat: 0, endBeat: 4 };
const right = { degree: 1, quality: 0 as const, shape: 0 as const, octave: 0 };

describe('judgeHit', () => {
  it('grades by timing window with direction', () => {
    expect(judgeHit(t, right, 0, false)).toBe('locked');
    expect(judgeHit(t, right, WINDOWS.locked, false)).toBe('locked');
    expect(judgeHit(t, right, -WINDOWS.locked - 1, false)).toBe('onit');
    expect(judgeHit(t, right, WINDOWS.onit + 1, false)).toBe('late');
    expect(judgeHit(t, right, -(WINDOWS.onit + 1), false)).toBe('early');
    expect(judgeHit(t, right, WINDOWS.late + 1, false)).toBe('dropped');
  });
  it('drops a wrong chord however well timed, and only checks shape when strict', () => {
    expect(judgeHit(t, { ...right, degree: 4 }, 0, false)).toBe('dropped');
    expect(judgeHit(t, { ...right, quality: 1 }, 0, false)).toBe('dropped');
    expect(judgeHit(t, { ...right, shape: 2 }, 0, false)).toBe('locked');
    expect(judgeHit(t, { ...right, shape: 2 }, 0, true)).toBe('dropped');
  });
});

describe('applyHit', () => {
  it('builds a run, multiplies score and caps the multiplier', () => {
    let s = newSetScore(60);
    for (let i = 0; i < 60; i++) s = applyHit(s, { target: i, judgment: 'locked', offsetMs: 0, beat: i });
    expect(s.run).toBe(60);
    expect(s.bestRun).toBe(60);
    // first hit 300 x 1, 51st+ hits 300 x 3
    expect(s.hits.length).toBe(60);
    expect(s.score).toBe(Math.round(300 * 1) + 300 * 49 * 0 + [...Array(59).keys()].reduce((n, i) => n + Math.round(300 * (1 + Math.min(i + 1, 50) / 25)), 0));
  });
  it('a drop resets the run and drains groove; groove can fail the set', () => {
    let s = newSetScore(10);
    s = applyHit(s, { target: 0, judgment: 'locked', offsetMs: 0, beat: 0 });
    s = applyHit(s, { target: 1, judgment: 'dropped', beat: 1 });
    expect(s.run).toBe(0);
    expect(s.bestRun).toBe(1);
    for (let i = 2; i < 6; i++) s = applyHit(s, { target: i, judgment: 'dropped', beat: i });
    expect(s.groove).toBe(0);
    expect(s.failed).toBe(true);
    expect(rating(s)).toBe('rough');
  });
  it('rehearsal never fails and halves the score', () => {
    let s = newSetScore(10);
    for (let i = 0; i < 8; i++) s = applyHit(s, { target: i, judgment: 'dropped', beat: i }, ['rehearsal']);
    expect(s.failed).toBe(false);
    let r = newSetScore(1);
    r = applyHit(r, { target: 0, judgment: 'locked', offsetMs: 0, beat: 0 }, ['rehearsal']);
    expect(r.score).toBe(150);
    expect(variationMultiplier(['doubletime', 'strict'])).toBeCloseTo(1.265);
  });
});

describe('rating', () => {
  const play = (js: Array<'locked' | 'onit' | 'early' | 'late' | 'dropped'>) => {
    let s = newSetScore(js.length);
    js.forEach((j, i) => (s = applyHit(s, { target: i, judgment: j, offsetMs: 0, beat: i })));
    return s;
  };
  it('flawless needs every chord locked or on it', () => {
    expect(rating(play(['locked', 'locked', 'onit', 'locked']))).not.toBe('flawless');
    expect(rating(play(['locked', 'locked', 'locked', 'locked']))).toBe('flawless');
    expect(accuracy(play(['locked', 'locked', 'onit', 'locked']))).toBeCloseTo((300 * 3 + 200) / 1200);
  });
  it('steps down through the tiers', () => {
    expect(rating(play([...Array(19).fill('locked'), 'onit']))).toBe('pocket'); // 0.983
    expect(rating(play([...Array(9).fill('locked'), 'early']))).toBe('tight'); // 0.933
    expect(rating(play([...Array(8).fill('locked'), 'dropped', 'dropped']))).toBe('steady'); // 0.8
    expect(rating(play([...Array(7).fill('locked'), 'dropped', 'dropped', 'dropped']))).toBe('loose'); // 0.7
  });
});

describe('rankFor', () => {
  it('starts as a Busker and climbs', () => {
    expect(rankFor(0)).toMatchObject({ rank: 'Busker', step: 1 });
    expect(rankFor(0).progress).toBe(0);
    const later = rankFor(50_000);
    expect(['Sideman', 'Bandleader', 'Composer']).toContain(later.rank);
    expect(rankFor(10_000_000).rank).toBe('Maestro');
    expect(rankFor(10_000_000).progress).toBe(1);
  });
});
