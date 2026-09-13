// Easter-egg gesture detector. Pure: feed it the parser's HandInfo + raw
// landmarks each frame, get back zero or more egg events. Every trigger is
// chosen so it does not collide with a playing gesture (or only fires while
// the hand is already muted), and each has a hold time + cooldown so it
// cannot fire by accident mid-phrase.

import type { HandInfo } from '../tracking/parser';

export type EggId = 'heart' | 'thumbs' | 'wave' | 'clap' | 'fire' | 'ok' | 'prayer' | 'highfive' | 'flip' | 'konami';

export interface EggEvent {
  id: EggId;
  /** scene-relevant anchor in image coords (0..1), where the effect should start */
  x: number;
  y: number;
  /** true while a sustained egg (fire, heart) is still being held */
  sustain: boolean;
}

export const EGG_INFO: Record<EggId, { emoji: string; name: string; hint: string }> = {
  heart: { emoji: '❤️', name: 'Finger heart', hint: 'Touch both index tips and both thumb tips together.' },
  thumbs: { emoji: '👍', name: 'Double thumbs up', hint: 'Two thumbs, pointing up, hold a moment.' },
  wave: { emoji: '👋', name: 'Wave', hint: 'Open hand, wave it side to side.' },
  clap: { emoji: '👏', name: 'Clap', hint: 'Bring two open hands together fast.' },
  fire: { emoji: '🔥', name: 'Power up', hint: 'Both fists raised high, apart.' },
  ok: { emoji: '👌', name: 'Chef’s kiss', hint: 'Left hand OK sign, hold it.' },
  prayer: { emoji: '🙏', name: 'Namaste', hint: 'Palms together in front of you.' },
  highfive: { emoji: '✋', name: 'High five', hint: 'Push an open right hand at the camera.' },
  flip: { emoji: '🙃', name: 'Rude', hint: 'One finger. You know which one.' },
  konami: { emoji: '🕹️', name: 'Arcade', hint: 'Up up down down left right left right B A.' },
};

export const EGG_IDS = Object.keys(EGG_INFO) as EggId[];

const HOLD: Partial<Record<EggId, number>> = { heart: 350, thumbs: 800, ok: 800, prayer: 1100, flip: 900, fire: 600 };
const COOLDOWN: Record<EggId, number> = { heart: 3000, thumbs: 4000, wave: 2500, clap: 900, fire: 2500, ok: 4000, prayer: 5000, highfive: 1800, flip: 7000, konami: 0 };
const SUSTAIN_TICK = 450; // ms between repeated events while holding heart / fire

function tip(lm: Float32Array, i: number): [number, number, number] {
  return [lm[i * 3], lm[i * 3 + 1], lm[i * 3 + 2]];
}
function d2(a: ArrayLike<number>, b: ArrayLike<number>) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export class EggDetector {
  private heldSince: Partial<Record<EggId, number>> = {};
  private lastFired: Partial<Record<EggId, number>> = {};
  private lastTick: Partial<Record<EggId, number>> = {};
  private xHist: { t: number; x: number }[] = [];
  private prevWristDist = -1;
  private prevT = 0;
  private prevRightZ = 0;

  /** Call once per camera frame. */
  update(t: number, L: HandInfo, R: HandInfo, lmL: Float32Array | null, lmR: Float32Array | null): EggEvent[] {
    const out: EggEvent[] = [];
    const dt = this.prevT ? Math.min(0.25, (t - this.prevT) / 1000) : 0.033;
    this.prevT = t;
    const both = L.present && R.present && !!lmL && !!lmR;
    const palm = Math.max(0.04, both ? (L.palm_size + R.palm_size) / 2 : L.present ? L.palm_size : R.palm_size);
    const open = (h: HandInfo) => h.fingers[1] && h.fingers[2] && h.fingers[3] && h.fingers[4];
    const mid = (a: ArrayLike<number>, b: ArrayLike<number>): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    const check = (id: EggId, cond: boolean, x: number, y: number, sustained = false) => {
      const hold = HOLD[id] ?? 0;
      if (!cond) {
        delete this.heldSince[id];
        return;
      }
      if (this.heldSince[id] == null) this.heldSince[id] = t;
      const heldFor = t - this.heldSince[id]!;
      if (heldFor < hold) return;
      const last = this.lastFired[id] ?? -1e9;
      if (sustained) {
        const first = t - last > COOLDOWN[id] && (this.lastTick[id] == null || t - this.lastTick[id]! > COOLDOWN[id]);
        const tickDue = first || t - (this.lastTick[id] ?? -1e9) > SUSTAIN_TICK;
        if (tickDue) {
          this.lastTick[id] = t;
          if (first) this.lastFired[id] = t;
          out.push({ id, x, y, sustain: !first });
        }
        return;
      }
      if (t - last > COOLDOWN[id]) {
        this.lastFired[id] = t;
        out.push({ id, x, y, sustain: false });
      }
    };

    // ---- two-hand shapes --------------------------------------------------
    if (both) {
      const iL = tip(lmL!, 8), iR = tip(lmR!, 8), tL = tip(lmL!, 4), tR = tip(lmR!, 4);
      const wd = d2(L.wrist, R.wrist);
      // heart: index tips meet at the top, thumb tips meet below, hands apart
      const heart = d2(iL, iR) < 0.5 * palm && d2(tL, tR) < 0.6 * palm && (iL[1] + iR[1]) / 2 < (tL[1] + tR[1]) / 2 - 0.3 * palm && wd > 1.1 * palm && !L.fingers[2] && !R.fingers[2];
      const hm = mid(mid(iL, iR), mid(tL, tR));
      check('heart', heart, hm[0], hm[1], true);

      // double thumbs up: fists with thumbs out, thumb tip above the wrist
      const thumbsUp = (h: HandInfo, lm: Float32Array) => h.fingers[0] && !h.fingers[1] && !h.fingers[2] && !h.fingers[3] && !h.fingers[4] && tip(lm, 4)[1] < h.wrist[1] - 0.5 * h.palm_size;
      check('thumbs', thumbsUp(L, lmL!) && thumbsUp(R, lmR!), (L.wrist[0] + R.wrist[0]) / 2, (L.wrist[1] + R.wrist[1]) / 2 - 0.1);

      // prayer: open hands, palms together, tips up
      const prayer = open(L) && open(R) && wd < 0.9 * palm && d2(tip(lmL!, 12), tip(lmR!, 12)) < 0.8 * palm && tip(lmL!, 12)[1] < L.wrist[1];
      check('prayer', prayer, (L.wrist[0] + R.wrist[0]) / 2, (L.wrist[1] + R.wrist[1]) / 2);

      // clap: two open hands closing fast
      if (this.prevWristDist >= 0) {
        const closing = (this.prevWristDist - wd) / Math.max(1e-3, dt) / palm; // palm units per second
        check('clap', open(L) && open(R) && wd < 1.0 * palm && closing > 3.5, (L.wrist[0] + R.wrist[0]) / 2, (L.wrist[1] + R.wrist[1]) / 2);
      }
      this.prevWristDist = wd;

      // fire: both fists high and apart (does not collide with the key gesture, which needs fists touching)
      const fire = L.fist && R.fist && !L.fingers[0] && !R.fingers[0] && L.wrist[1] < 0.32 && R.wrist[1] < 0.32 && wd > 1.5 * palm;
      check('fire', fire, (L.wrist[0] + R.wrist[0]) / 2, Math.min(L.wrist[1], R.wrist[1]), true);
    } else {
      this.prevWristDist = -1;
      delete this.heldSince.heart;
      delete this.heldSince.thumbs;
      delete this.heldSince.prayer;
      delete this.heldSince.fire;
    }

    // ---- one-hand shapes --------------------------------------------------
    // OK sign, left hand: pinch + three fingers up (the parser treats it as "hold previous chord")
    check('ok', L.present && L.pinch && L.fingers[2] && L.fingers[3] && L.fingers[4], L.wrist[0], L.wrist[1] - 0.15);

    // the finger: exactly the middle finger, either hand, only one hand in view
    const flipL = L.present && !R.present && !L.fingers[1] && L.fingers[2] && !L.fingers[3] && !L.fingers[4];
    const flipR = R.present && !L.present && !R.fingers[1] && R.fingers[2] && !R.fingers[3] && !R.fingers[4];
    check('flip', flipL || flipR, (flipL ? L : R).wrist[0], (flipL ? L : R).wrist[1]);

    // wave: an open hand oscillating sideways (either hand)
    const waver = open(R) && R.present ? R : open(L) && L.present ? L : null;
    if (waver) {
      this.xHist.push({ t, x: waver.wrist[0] / Math.max(0.04, waver.palm_size) });
      while (this.xHist.length && t - this.xHist[0].t > 1300) this.xHist.shift();
      let reversals = 0;
      let dir = 0;
      let extent = 0;
      for (let i = 1; i < this.xHist.length; i++) {
        const dx = this.xHist[i].x - this.xHist[i - 1].x;
        if (Math.abs(dx) < 0.03) continue;
        const s = Math.sign(dx);
        if (dir && s !== dir) reversals++;
        dir = s;
      }
      if (this.xHist.length) {
        const xs = this.xHist.map((h) => h.x);
        extent = Math.max(...xs) - Math.min(...xs);
      }
      check('wave', reversals >= 3 && extent > 0.9, waver.wrist[0], waver.wrist[1]);
      if (reversals >= 3 && extent > 0.9) this.xHist = [];
    } else {
      this.xHist = [];
    }

    // high five: open right hand pushed toward the camera (left-hand flicks are bass hits already)
    if (R.present) {
      const zv = R.z_velocity;
      check('highfive', open(R) && zv > 2.2 && this.prevRightZ <= 2.2, R.wrist[0], R.wrist[1]);
      this.prevRightZ = zv;
    } else {
      this.prevRightZ = 0;
    }

    return out;
  }
}

/** Keyboard Konami code tracker. Returns true on completion. */
export class Konami {
  private static SEQ = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  private i = 0;
  key(k: string): boolean {
    const want = Konami.SEQ[this.i];
    const got = k.length === 1 ? k.toLowerCase() : k;
    if (got === want) {
      this.i++;
      if (this.i === Konami.SEQ.length) {
        this.i = 0;
        return true;
      }
    } else {
      this.i = got === Konami.SEQ[0] ? 1 : 0;
    }
    return false;
  }
}

/** Heart curve points (scene units, centered at 0,0, height ~1). */
export function heartPoints(n = 400, scale = 0.5): Float32Array {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    out[i * 2] = (x / 17) * scale;
    out[i * 2 + 1] = (y / 17) * scale;
  }
  return out;
}

/** Ring of points. */
export function ringPoints(n: number, r: number): Float32Array {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out[i * 2] = Math.cos(a) * r;
    out[i * 2 + 1] = Math.sin(a) * r;
  }
  return out;
}
