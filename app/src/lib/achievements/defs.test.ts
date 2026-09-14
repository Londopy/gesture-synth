import { describe, expect, it } from 'vitest';
import { CATEGORIES, MEDALS, TIER_INFO, emptyStats, medalById } from './defs';
import { DEMO_IDS } from '../demo/ids';

describe('medal definitions', () => {
  it('have unique ids, valid categories and tiers, and copy', () => {
    const ids = new Set(MEDALS.map((m) => m.id));
    expect(ids.size).toBe(MEDALS.length);
    for (const m of MEDALS) {
      expect(CATEGORIES).toContain(m.category);
      expect(Object.keys(TIER_INFO)).toContain(m.tier);
      expect(m.name.length).toBeGreaterThan(2);
      expect(m.description.length).toBeGreaterThan(5);
      if (m.hidden) expect(m.hint).toBe('');
      else expect(m.hint.length).toBeGreaterThan(2);
    }
  });

  it('nothing is unlocked on empty stats', () => {
    const s = emptyStats();
    expect(MEDALS.filter((m) => m.check(s)).map((m) => m.id)).toEqual([]);
  });

  it('progress never exceeds the target and matches check()', () => {
    const s = emptyStats();
    s.chords = 5000;
    s.sevenths = 600;
    s.days = Array.from({ length: 9 }, (_, i) => `2026-09-${i + 1}`);
    for (const m of MEDALS) {
      if (!m.progress) continue;
      const [a, b] = m.progress(s);
      expect(a).toBeLessThanOrEqual(b);
      expect(a >= b).toBe(m.check(s));
    }
    expect(medalById('spectator')!.check(s)).toBe(false);
    expect(medalById('front_row')!.check(s)).toBe(false);
    expect(medalById('thousand_hands')!.check(s)).toBe(true);
    expect(medalById('chord_lord')!.check(s)).toBe(false);
    expect(medalById('extension_cord')!.check(s)).toBe(true);
    expect(medalById('weekly')!.check(s)).toBe(true);
  });

  it('specific rules', () => {
    const s = emptyStats();
    s.octaves = [0, 1];
    expect(medalById('range_finder')!.check(s)).toBe(false);
    s.octaves = [-1, 0, 1];
    expect(medalById('range_finder')!.check(s)).toBe(true);
    s.minBpmRecorded = 48;
    expect(medalById('slow_burn')!.check(s)).toBe(true);
    s.themesUsed = ['Neon', 'Ember', 'Ice', 'Mono', 'Vapor', 'Arcade'];
    expect(medalById('eye_candy')!.check(s)).toBe(true);
    s.eggs = ['flip'];
    expect(medalById('turn_that_frown')!.check(s)).toBe(true);
    s.secretsFound = 10;
    expect(medalById('secret_keeper')!.check(s)).toBe(true);
    expect(medalById('completionist')!.check(s)).toBe(false); // resolved by the store
  });

  it('demo medals count distinct built-in demos', () => {
    const s = emptyStats();
    expect(medalById('front_row')!.progress!(s)[1]).toBe(DEMO_IDS.length);
    expect(medalById('spectator')!.check(s)).toBe(false);
    s.demosWatched = ['my-own-song'];
    expect(medalById('spectator')!.check(s)).toBe(true);
    expect(medalById('front_row')!.progress!(s)[0]).toBe(0);
    s.demosWatched = [...DEMO_IDS.slice(0, 3), 'my-own-song'];
    expect(medalById('front_row')!.check(s)).toBe(false);
    expect(medalById('front_row')!.progress!(s)).toEqual([3, DEMO_IDS.length]);
    s.demosWatched = [...DEMO_IDS, DEMO_IDS[0]];
    expect(medalById('front_row')!.check(s)).toBe(true);
    for (const m of MEDALS.filter((x) => ['spectator', 'front_row'].includes(x.id))) expect(m.category).toBe('explore');
  });

  it('has a sensible spread of tiers', () => {
    const count = (t: string) => MEDALS.filter((m) => m.tier === t).length;
    expect(count('bronze')).toBeGreaterThan(count('platinum'));
    expect(count('platinum')).toBeGreaterThanOrEqual(3);
    expect(MEDALS.length).toBeGreaterThanOrEqual(40);
  });
});
