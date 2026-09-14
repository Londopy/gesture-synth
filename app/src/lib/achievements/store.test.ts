// The store with a fake runtime: only the mute switch and the demo_watched
// bookkeeping are exercised here; the medal predicates live in defs.test.ts.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_IDS } from '../demo/ids';

vi.mock('../state/engine.svelte', () => ({
  rt: { on: () => () => {}, live: { key: 0 }, phase: 'ready', worklet: null, position: { recording: 0 }, trackSummary: [], left: { present: false }, right: { present: false } },
}));
vi.mock('../state/settings.svelte', () => ({
  settings: { s: { theme: 'Neon', liveInstrument: 'Pad', viewMode: 'performance', tourDone: false, eggsFound: [] } },
}));
vi.mock('../state/ui.svelte', () => ({ ui: { toast: () => {} } }));

beforeAll(() => {
  // the store's debounced save and chime reach for browser globals
  const g = globalThis as any;
  g.window = g.window ?? globalThis;
  g.localStorage = g.localStorage ?? { getItem: () => null, setItem: () => {}, removeItem: () => {} };
});

describe('achievements store in demo mode', () => {
  it('mutes everything but demo_watched while a demo runs', async () => {
    const { achievements } = await import('./store.svelte');
    achievements.reset();
    const chord = { kind: 'chord', degree: 1, quality: 0, shape: 2, octave: 0, key: 0 } as const;
    achievements.track(chord);
    expect(achievements.stats.chords).toBe(1);
    achievements.setDemo(true);
    achievements.track(chord);
    achievements.track({ kind: 'bass' });
    achievements.track({ kind: 'arp' });
    achievements.track({ kind: 'latch' });
    achievements.track({ kind: 'instrument', name: 'Organ' });
    expect(achievements.stats.chords).toBe(1);
    expect(achievements.stats.bassHits).toBe(0);
    expect(achievements.stats.arpToggles).toBe(0);
    expect(achievements.stats.latches).toBe(0);
    expect(achievements.stats.instrumentsUsed).toEqual([]);
    achievements.track({ kind: 'demo_watched', id: DEMO_IDS[0] });
    expect(achievements.stats.demosWatched).toEqual([DEMO_IDS[0]]);
    expect(achievements.stats.demoPlays).toBe(1);
    expect(achievements.isUnlocked('spectator')).toBe(true);
    expect(achievements.isUnlocked('front_row')).toBe(false);
    achievements.setDemo(false);
    achievements.track(chord);
    expect(achievements.stats.chords).toBe(2);
  });

  it('unlocks Front Row after every built-in demo, counting each id once', async () => {
    const { achievements } = await import('./store.svelte');
    achievements.reset();
    achievements.setDemo(true);
    for (const id of DEMO_IDS) achievements.track({ kind: 'demo_watched', id });
    achievements.track({ kind: 'demo_watched', id: DEMO_IDS[1] });
    achievements.setDemo(false);
    expect(achievements.stats.demosWatched).toEqual([...DEMO_IDS]);
    expect(achievements.stats.demoPlays).toBe(DEMO_IDS.length + 1);
    expect(achievements.isUnlocked('front_row')).toBe(true);
  });

  it('a demo chord does not pair with the next user chord as a quick change', async () => {
    const { achievements } = await import('./store.svelte');
    achievements.reset();
    achievements.track({ kind: 'chord', degree: 1, quality: 0, shape: 0, octave: 0, key: 0 });
    achievements.setDemo(true);
    achievements.track({ kind: 'chord', degree: 1, quality: 1, shape: 0, octave: 0, key: 0 });
    achievements.setDemo(false);
    achievements.track({ kind: 'chord', degree: 1, quality: 1, shape: 0, octave: 0, key: 0 });
    expect(achievements.stats.quickChanges).toBe(0);
  });
});
