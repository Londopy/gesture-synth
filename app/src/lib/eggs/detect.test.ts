import { describe, expect, it } from 'vitest';
import { EggDetector, Konami, heartPoints } from './detect';
import { emptyHand, type HandInfo } from '../tracking/parser';

function hand(over: Partial<HandInfo>): HandInfo {
  return { ...emptyHand(), present: true, confidence: 0.9, palm_size: 0.12, ...over };
}
/** 63-float landmark array with chosen tips placed; everything else at the wrist. */
function lm(wrist: [number, number], tips: Partial<Record<number, [number, number]>> = {}): Float32Array {
  const a = new Float32Array(63);
  for (let i = 0; i < 21; i++) {
    a[i * 3] = wrist[0];
    a[i * 3 + 1] = wrist[1];
  }
  for (const [k, v] of Object.entries(tips)) {
    const i = Number(k);
    a[i * 3] = v![0];
    a[i * 3 + 1] = v![1];
  }
  return a;
}
function run(d: EggDetector, frames: { L: HandInfo; R: HandInfo; lmL: Float32Array | null; lmR: Float32Array | null }[], stepMs = 33, from = 0) {
  const events = [];
  let t = from;
  for (const f of frames) {
    t += stepMs;
    events.push(...d.update(t, f.L, f.R, f.lmL, f.lmR));
  }
  return { events, t };
}

describe('easter egg detector', () => {
  it('finger heart fires after a short hold and sustains', () => {
    const d = new EggDetector();
    const L = hand({ wrist: [0.62, 0.6, 0], fingers: [true, true, false, false, false] });
    const R = hand({ wrist: [0.38, 0.6, 0], fingers: [true, true, false, false, false] });
    const lmL = lm([0.62, 0.6], { 8: [0.5, 0.4], 4: [0.5, 0.52] });
    const lmR = lm([0.38, 0.6], { 8: [0.5, 0.41], 4: [0.5, 0.53] });
    const frame = { L, R, lmL, lmR };
    const { events } = run(d, Array(40).fill(frame));
    const hearts = events.filter((e) => e.id === 'heart');
    expect(hearts.length).toBeGreaterThanOrEqual(2);
    expect(hearts[0].sustain).toBe(false);
    expect(hearts[1].sustain).toBe(true);
    expect(hearts[0].x).toBeCloseTo(0.5, 1);
  });

  it('does not fire the heart when hands are apart', () => {
    const d = new EggDetector();
    const L = hand({ wrist: [0.7, 0.6, 0], fingers: [true, true, false, false, false] });
    const R = hand({ wrist: [0.3, 0.6, 0], fingers: [true, true, false, false, false] });
    const { events } = run(d, Array(40).fill({ L, R, lmL: lm([0.7, 0.6], { 8: [0.65, 0.4] }), lmR: lm([0.3, 0.6], { 8: [0.35, 0.4] }) }));
    expect(events.some((e) => e.id === 'heart')).toBe(false);
  });

  it('double thumbs up needs both thumbs pointing up and a hold', () => {
    const d = new EggDetector();
    const L = hand({ wrist: [0.7, 0.6, 0], fingers: [true, false, false, false, false], fist: true });
    const R = hand({ wrist: [0.3, 0.6, 0], fingers: [true, false, false, false, false], fist: true });
    const up = { L, R, lmL: lm([0.7, 0.6], { 4: [0.7, 0.45] }), lmR: lm([0.3, 0.6], { 4: [0.3, 0.45] }) };
    const short = run(d, Array(10).fill(up)); // 330 ms: not yet
    expect(short.events.some((e) => e.id === 'thumbs')).toBe(false);
    const long = run(d, Array(20).fill(up), 33, short.t);
    expect(long.events.filter((e) => e.id === 'thumbs')).toHaveLength(1);
  });

  it('wave counts direction reversals of an open hand', () => {
    const d = new EggDetector();
    const frames = [];
    for (let i = 0; i < 40; i++) {
      const x = 0.5 + 0.12 * Math.sin(i / 3);
      frames.push({ L: emptyHand(), R: hand({ wrist: [x, 0.5, 0], fingers: [false, true, true, true, true] }), lmL: null, lmR: lm([x, 0.5]) });
    }
    const { events } = run(d, frames);
    expect(events.filter((e) => e.id === 'wave').length).toBeGreaterThanOrEqual(1);
  });

  it('middle finger flips only with one hand in view', () => {
    const d = new EggDetector();
    const R = hand({ wrist: [0.4, 0.5, 0], fingers: [false, false, true, false, false] });
    const { events } = run(d, Array(40).fill({ L: emptyHand(), R, lmL: null, lmR: lm([0.4, 0.5]) }));
    expect(events.filter((e) => e.id === 'flip')).toHaveLength(1);
    const d2 = new EggDetector();
    const L = hand({ wrist: [0.7, 0.5, 0], fingers: [false, true, false, false, false] });
    const both = run(d2, Array(40).fill({ L, R, lmL: lm([0.7, 0.5]), lmR: lm([0.4, 0.5]) }));
    expect(both.events.some((e) => e.id === 'flip')).toBe(false);
  });

  it('fire sustains while both fists stay high', () => {
    const d = new EggDetector();
    const L = hand({ wrist: [0.7, 0.2, 0], fist: true, fingers: [false, false, false, false, false] });
    const R = hand({ wrist: [0.3, 0.2, 0], fist: true, fingers: [false, false, false, false, false] });
    const { events } = run(d, Array(60).fill({ L, R, lmL: lm([0.7, 0.2]), lmR: lm([0.3, 0.2]) }));
    const fire = events.filter((e) => e.id === 'fire');
    expect(fire.length).toBeGreaterThanOrEqual(3);
    expect(fire.filter((e) => !e.sustain)).toHaveLength(1);
  });

  it('konami sequence', () => {
    const k = new Konami();
    const seq = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    expect(seq.slice(0, -1).some((s) => k.key(s))).toBe(false);
    expect(k.key('A')).toBe(true);
    expect(k.key('x')).toBe(false);
  });

  it('heart curve is closed and centred', () => {
    const p = heartPoints(200, 1);
    expect(p.length).toBe(400);
    let cx = 0;
    for (let i = 0; i < 200; i++) cx += p[i * 2];
    expect(Math.abs(cx / 200)).toBeLessThan(1e-6);
  });
});
