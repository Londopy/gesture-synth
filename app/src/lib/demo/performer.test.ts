import { describe, expect, it } from 'vitest';
import { Performer, type SynthFn } from './performer';

/** Stub synthesiser: wrist at landmark 0, the call's parameters encoded in landmarks 1 and 2. */
const stub: SynthFn = (cx, cy, palm, fingers, tilt, right, thumb, pinch) => {
  const f = new Float32Array(63);
  f[0] = cx;
  f[1] = cy;
  f[2] = 0;
  f[3] = fingers;
  f[4] = tilt;
  f[5] = thumb;
  f[6] = right ? 1 : 0;
  f[7] = pinch ? 1 : 0;
  f[8] = palm;
  for (let i = 3; i < 21; i++) {
    f[i * 3] = cx + i * 0.001;
    f[i * 3 + 1] = cy - i * 0.001;
    f[i * 3 + 2] = 0.01;
  }
  return f;
};

function run(p: Performer, frames: number, t0 = 0, dt = 32) {
  const out: { t: number; hands: { x: number; y: number; z: number[]; left: boolean; fingers: number; tilt: number; thumb: number; pinch: number }[] }[] = [];
  for (let i = 0; i < frames; i++) {
    const t = t0 + i * dt;
    const f = p.frame(t);
    out.push({
      t,
      hands: f.hands.map((h) => ({
        x: h.landmarks[0].x,
        y: h.landmarks[0].y,
        z: h.landmarks.map((q) => q.z),
        left: h.left,
        fingers: h.landmarks[1].x,
        tilt: h.landmarks[1].y,
        thumb: h.landmarks[1].z,
        pinch: h.landmarks[2].y,
      })),
    });
  }
  return out;
}

const userLeft = (hs: ReturnType<typeof run>[number]['hands']) => hs.find((h) => !h.left)!;
const userRight = (hs: ReturnType<typeof run>[number]['hands']) => hs.find((h) => h.left)!;

describe('Performer', () => {
  it('emits no hands until enter(), then both with swapped tracker labels and the right hand at smaller x', () => {
    const p = new Performer(stub);
    expect(p.frame(0).hands.length).toBe(0);
    p.enter();
    const frames = run(p, 40, 32);
    for (const f of frames) {
      expect(f.hands.length).toBe(2);
      const l = userLeft(f.hands);
      const r = userRight(f.hands);
      expect(l.left).toBe(false);
      expect(r.left).toBe(true);
      expect(r.x).toBeLessThan(l.x);
      expect(l.x - r.x).toBeGreaterThanOrEqual(0.28 - 1e-9);
    }
    const last = frames[frames.length - 1];
    expect(Math.abs(userLeft(last.hands).y - p.left.y)).toBeLessThan(0.03);
    expect(Math.abs(userRight(last.hands).y - p.right.y)).toBeLessThan(0.03);
  });

  it('moves each wrist at most 0.03 per frame during entrance, presses and exit', () => {
    const p = new Performer(stub);
    p.enter();
    const frames = run(p, 30);
    p.press();
    frames.push(...run(p, 14, 30 * 32));
    p.exit();
    frames.push(...run(p, 6, 44 * 32)); // off stage: no hands emitted
    p.enter(); // re-entry from the bottom again
    frames.push(...run(p, 30, 50 * 32));
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1].hands;
      const b = frames[i].hands;
      if (a.length !== 2 || b.length !== 2) continue;
      for (const pick of [userLeft, userRight]) {
        const d = Math.hypot(pick(b).x - pick(a).x, pick(b).y - pick(a).y);
        expect(d, `frame ${i}`).toBeLessThanOrEqual(0.03 + 1e-6);
      }
    }
  });

  it('omits the hands during exit and the wrists slide off stage', () => {
    const p = new Performer(stub);
    p.enter();
    run(p, 40);
    p.exit();
    expect(p.visible).toBe(false);
    const frames = run(p, 25, 40 * 32);
    for (const f of frames) expect(f.hands.length).toBe(0);
    expect(p.leftWrist[1]).toBeGreaterThan(1.0);
    expect(p.rightWrist[1]).toBeGreaterThan(1.0);
  });

  it('flick() lowers every left z by 0.03 for exactly one frame, then raises by 0.01 per frame', () => {
    const p = new Performer(stub);
    p.enter();
    run(p, 40);
    const base = run(p, 1, 40 * 32)[0];
    p.flick();
    const after = run(p, 5, 41 * 32);
    const baseZ = userLeft(base.hands).z;
    const expectDelta = (frame: (typeof after)[number], d: number) => {
      const z = userLeft(frame.hands).z;
      for (let i = 0; i < 21; i++) expect(z[i] - baseZ[i]).toBeCloseTo(d, 6);
      // the right hand is untouched
      const rz = userRight(frame.hands).z;
      const rBase = userRight(base.hands).z;
      for (let i = 0; i < 21; i++) expect(rz[i] - rBase[i]).toBeCloseTo(0, 6);
    };
    expectDelta(after[0], -0.03);
    expectDelta(after[1], -0.02);
    expectDelta(after[2], -0.01);
    expectDelta(after[3], 0);
    expectDelta(after[4], 0);
  });

  it('passes finger masks, tilt, thumb pose and pinch straight through (no interpolation)', () => {
    const p = new Performer(stub);
    p.enter();
    run(p, 40);
    p.left.mask = 0b11110;
    p.left.tilt = -25;
    p.right.mask = 0b01110;
    p.right.thumb = 1;
    const f1 = run(p, 1, 40 * 32)[0];
    const l = userLeft(f1.hands);
    const r = userRight(f1.hands);
    expect(l.fingers).toBe(0b11110);
    expect(l.tilt).toBe(-25);
    // the left thumb bit is relaxed unless the degree needs it out
    expect(l.thumb).toBe(2);
    expect(r.fingers).toBe(0b01110);
    expect(r.thumb).toBe(1);
    expect(r.pinch).toBe(0);
    p.left.mask = 0b11111;
    p.right.pinch = true;
    p.right.thumb = 2;
    const f2 = run(p, 1, 41 * 32)[0];
    expect(userLeft(f2.hands).thumb).toBe(1);
    expect(userLeft(f2.hands).fingers).toBe(0b11110);
    expect(userRight(f2.hands).pinch).toBe(1);
    expect(userRight(f2.hands).thumb).toBe(2);
    p.right.pinch = false;
    p.right.thumb = 0;
    const f3 = run(p, 1, 42 * 32)[0];
    expect(userRight(f3.hands).pinch).toBe(0);
    expect(userRight(f3.hands).thumb).toBe(0);
  });

  it('eases the right tilt instead of snapping it', () => {
    const p = new Performer(stub);
    p.enter();
    run(p, 40);
    p.right.tilt = 40;
    const frames = run(p, 30, 40 * 32);
    expect(userRight(frames[0].hands).tilt).toBeLessThan(10);
    expect(userRight(frames[0].hands).tilt).toBeGreaterThan(0);
    expect(userRight(frames[29].hands).tilt).toBeGreaterThan(38);
  });

  it('freeze makes consecutive frames identical; appear() places the hands without a slide', () => {
    const p = new Performer(stub);
    p.enter();
    run(p, 40);
    p.freeze = true;
    const frames = run(p, 10, 40 * 32);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].hands.map((h) => [h.x, h.y, h.z])).toEqual(frames[0].hands.map((h) => [h.x, h.y, h.z]));
    }
    p.exit();
    run(p, 30, 50 * 32);
    p.freeze = false;
    p.appear();
    const back = run(p, 1, 80 * 32)[0];
    expect(back.hands.length).toBe(2);
    expect(Math.abs(userLeft(back.hands).y - p.left.y)).toBeLessThan(0.02);
    expect(Math.abs(userRight(back.hands).y - p.right.y)).toBeLessThan(0.02);
  });
});
