import { describe, expect, it } from 'vitest';
import { leftFingersFor, QUALITY_INDEX, rightFingersFor, SHAPE_INDEX, tiltFor } from '../learn/songs';
import { bits, compile, exprAt, leadBeats, type Cue } from './choreo';
import { beatsPerBar, chordOnset, DEMO_SONGS, demoById } from './songs';

const byKind = <K extends Cue['kind']>(cues: Cue[], k: K) => cues.filter((c): c is Cue & { kind: K } => c.kind === k);

describe('compile', () => {
  it('sorts cues by beat and emits one pose per chord with the finger tables', () => {
    for (const song of DEMO_SONGS) {
      const tl = compile(song);
      expect(tl.beats).toBe(beatsPerBar(song));
      expect(tl.total).toBe(song.bars * tl.beats);
      for (let i = 1; i < tl.cues.length; i++) expect(tl.cues[i].beat).toBeGreaterThanOrEqual(tl.cues[i - 1].beat);
      const poses = byKind(tl.cues, 'pose');
      expect(poses.length).toBe(song.chords.length);
      poses.forEach((p, i) => {
        const c = tl.chords[p.chordIdx];
        expect(p.chordIdx).toBe(i);
        expect(p.beat).toBe(chordOnset(c, tl.beats));
        expect(p.left.mask).toBe(bits(leftFingersFor(c.degree)));
        expect(p.left.tilt).toBe(tiltFor(QUALITY_INDEX[c.quality]));
        expect(p.right.mask).toBe(bits(rightFingersFor(SHAPE_INDEX[c.shape], 0)) & ~1);
        expect(p.right.thumb).toBe(c.octave);
      });
      // the masks the parser's degree table expects
      const degMask: Record<number, number> = { 1: 2, 2: 6, 3: 14, 4: 30, 5: 31, 6: 18, 7: 19 };
      for (const p of poses) expect(p.left.mask).toBe(degMask[tl.chords[p.chordIdx].degree]);
      const shapeMask: Record<string, number> = { root: 2, inv1: 6, seventh: 14, dom_or_dim7: 30 };
      for (const p of poses) expect(p.right.mask).toBe(shapeMask[tl.chords[p.chordIdx].shape]);
    }
  });

  it('never shows the same pose twice in a row without a rest between', () => {
    for (const song of DEMO_SONGS) {
      const tl = compile(song);
      let prev: string | null = null;
      for (const c of tl.cues) {
        if (c.kind === 'rest') prev = null;
        if (c.kind !== 'pose') continue;
        const key = `${c.left.mask}/${c.left.tilt}/${c.right.mask}/${c.right.thumb}`;
        expect(key, `${song.name} beat ${c.beat}`).not.toBe(prev);
        prev = key;
      }
    }
  });

  it('places rests exactly where a chord ends before the next onset', () => {
    const lantern = compile(demoById('lantern-waltz')!);
    expect(byKind(lantern.cues, 'rest').map((r) => r.beat)).toEqual([7 * 3 + 2]); // 8.3
    const circuit = compile(demoById('circuit-breaker')!);
    expect(byKind(circuit.cues, 'rest').map((r) => r.beat)).toEqual([15 * 4 + 2]); // 16.3
    expect(byKind(compile(demoById('brass-tacks')!).cues, 'rest')).toEqual([]);
    expect(byKind(compile(demoById('slow-orbit')!).cues, 'rest')).toEqual([]);
  });

  it('bass cues sit inside their chord and match the perf offsets', () => {
    for (const song of DEMO_SONGS) {
      const tl = compile(song);
      const expected = tl.chords.flatMap((c) => (c.perf?.bass ?? []).map((o) => chordOnset(c, tl.beats) + o)).sort((a, b) => a - b);
      expect(byKind(tl.cues, 'bass').map((b) => b.beat)).toEqual(expected);
      for (const b of byKind(tl.cues, 'bass')) {
        const owner = tl.chords.find((c) => chordOnset(c, tl.beats) <= b.beat && b.beat < chordOnset(c, tl.beats) + c.dur_beats);
        expect(owner, `${song.name} bass at ${b.beat}`).toBeDefined();
        expect(owner!.octave).not.toBe(-1);
      }
    }
  });

  it('pinch cues follow root chords a quarter beat after the onset', () => {
    for (const song of DEMO_SONGS) {
      const tl = compile(song);
      for (const p of byKind(tl.cues, 'pinch')) {
        const owner = tl.chords.find((c) => chordOnset(c, tl.beats) === p.beat - 0.25);
        expect(owner).toBeDefined();
        expect(owner!.shape).toBe('root');
        expect(owner!.perf?.arp).toBe(p.on ? 'on' : 'off');
      }
    }
    const orbit = compile(demoById('slow-orbit')!);
    expect(byKind(orbit.cues, 'pinch').map((p) => [p.beat, p.on])).toEqual([
      [8.25, true],
      [16.25, false],
    ]);
  });

  it('a latch chord produces freeze, exit and enter in order, enter before the next pose lead', () => {
    const song = demoById('slow-orbit')!;
    const tl = compile(song);
    const freeze = byKind(tl.cues, 'freeze');
    const exit = byKind(tl.cues, 'exit');
    const enter = byKind(tl.cues, 'enter');
    expect(freeze.length).toBe(1);
    expect(exit.length).toBe(1);
    expect(enter.length).toBe(1);
    const latched = tl.chords.findIndex((c) => c.perf?.latch);
    const onset = chordOnset(tl.chords[latched], tl.beats);
    const spb = 60 / song.bpm;
    expect(freeze[0].beat).toBeCloseTo(onset + 0.3 / spb, 6);
    expect(exit[0].beat).toBeCloseTo(freeze[0].beat + 2.5 / spb, 6);
    const nextOnset = tl.total; // the latch chord is the last one
    const lead = leadBeats('pose', { stableMs: 90, frameMs: 32, bpm: song.bpm });
    expect(enter[0].beat).toBeCloseTo(nextOnset - 0.4 / spb - lead, 6);
    expect(enter[0].poseOf).toBe(latched);
    expect(freeze[0].beat).toBeLessThan(exit[0].beat);
    expect(exit[0].beat).toBeLessThan(enter[0].beat);
    for (const s of DEMO_SONGS.filter((d) => d.id !== 'slow-orbit')) expect(byKind(compile(s).cues, 'freeze')).toEqual([]);
  });
});

describe('leadBeats', () => {
  it('lands the pose commit in the second half of the sixteenth before the beat for 40..140 bpm', () => {
    for (const F of [32, 33]) {
      for (let bpm = 40; bpm <= 140; bpm += 1) {
        const lead = leadBeats('pose', { stableMs: 90, frameMs: F, bpm });
        const leadMs = (lead * 60000) / bpm;
        const S = 90;
        const nCommit = Math.ceil(S / F);
        const half = 60000 / bpm / 8;
        // the pose is fed on a position tick in [beat - lead, beat - lead + F/2) (ticks run at twice the
        // frame rate), commits nCommit frames later give or take a frame's jitter, plus one block
        const lo = -leadMs + nCommit * F - 3;
        const hi = -leadMs + F / 2 + nCommit * F + 3 + 3;
        expect(lo, `bpm ${bpm} F ${F}`).toBeGreaterThan(-half);
        expect(hi, `bpm ${bpm} F ${F}`).toBeLessThan(0);
        expect((lo + hi) / 2, `bpm ${bpm} F ${F}`).toBeCloseTo(-half / 2 - 0.5, 6);
        // and both edges keep at least 12 ms from the sixteenth's midpoint and the beat at 140 bpm
        if (bpm === 140) {
          expect(lo + half).toBeGreaterThan(12);
          expect(-hi).toBeGreaterThan(12);
        }
      }
    }
  });

  it('rest lead is (ceil(S/F) + 0.5) F and bass/freeze/exit/enter have none', () => {
    const o = { stableMs: 90, frameMs: 32, bpm: 120 };
    expect((leadBeats('rest', o) * 60000) / 120).toBeCloseTo(3.5 * 32, 6);
    expect((leadBeats('pinch', o) * 60000) / 120).toBeCloseTo(4.5 * 32, 6);
    for (const k of ['bass', 'freeze', 'exit', 'enter'] as const) expect(leadBeats(k, o)).toBe(0);
    // stable_ms is clamped to 60..200
    expect(leadBeats('rest', { ...o, stableMs: 10 })).toBe(leadBeats('rest', { ...o, stableMs: 60 }));
    expect(leadBeats('rest', { ...o, stableMs: 900 })).toBe(leadBeats('rest', { ...o, stableMs: 200 }));
  });
});

describe('exprAt', () => {
  it('carries vol/cutoff across chords without perf and ramps linearly', () => {
    const tl = compile(demoById('brass-tacks')!);
    // chord 2 (bar 2) has no vol/cutoff: carries 0.6 / 0.75 from bar 1
    const b2 = exprAt(tl, 4);
    expect(b2.vol).toBeCloseTo(0.6);
    expect(b2.cutoff).toBeCloseTo(0.75);
    expect(b2.chordIdx).toBe(1);
    expect(b2.say).toBe('Palm tilted in: a minor seventh');
    // bar 7: vol .55 -> .8, cutoff .5 -> .95 over 4 beats
    const s = exprAt(tl, 24);
    const m = exprAt(tl, 26);
    const e = exprAt(tl, 27.999);
    expect(s.vol).toBeCloseTo(0.55);
    expect(m.vol).toBeCloseTo(0.675);
    expect(e.vol).toBeCloseTo(0.8, 2);
    expect(s.cutoff).toBeCloseTo(0.5);
    expect(m.cutoff).toBeCloseTo(0.725);
    // bar 8.1 sets its own values
    expect(exprAt(tl, 28).vol).toBeCloseTo(0.75);
    expect(exprAt(tl, 28).cutoff).toBeCloseTo(0.8);
    // wrap
    expect(exprAt(tl, 32).vol).toBeCloseTo(0.6);
    expect(exprAt(tl, -0.5).vol).toBeCloseTo(0.8);
  });

  it('song start defaults are 0.6 / 0.7 and rests hold the last value', () => {
    const tl = compile({ ...demoById('lantern-waltz')!, chords: demoById('lantern-waltz')!.chords.map((c) => ({ ...c, perf: undefined })) });
    expect(exprAt(tl, 0).vol).toBeCloseTo(0.6);
    expect(exprAt(tl, 0).cutoff).toBeCloseTo(0.7);
    const lantern = compile(demoById('lantern-waltz')!);
    // bar 8 (beats 21..23): cutoff .45 -> .9 over 2 beats, then the rest holds .9
    expect(exprAt(lantern, 23).cutoff).toBeCloseTo(0.9);
    expect(exprAt(lantern, 23.9).cutoff).toBeCloseTo(0.9);
    expect(exprAt(lantern, 23.9).chordIdx).toBe(7);
  });

  it('reports arp from the on pinch to the off pinch', () => {
    const tl = compile(demoById('slow-orbit')!);
    expect(exprAt(tl, 0).arp).toBe(false);
    expect(exprAt(tl, 8.2).arp).toBe(false);
    expect(exprAt(tl, 8.25).arp).toBe(true);
    expect(exprAt(tl, 12).arp).toBe(true);
    expect(exprAt(tl, 16.2).arp).toBe(true);
    expect(exprAt(tl, 16.25).arp).toBe(false);
    expect(exprAt(tl, 31).arp).toBe(false);
    // the rate ramp on bar 3: .55 -> .85
    expect(exprAt(tl, 10).vol).toBeCloseTo(0.7);
  });
});
