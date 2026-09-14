// The synthetic performer: two hands whose wrists ease toward targets while
// the finger geometry snaps. Emits TrackingFrames in the raw (un-mirrored)
// camera convention the parser expects. The landmark synthesiser is injected
// so the class can be tested without the wasm module.

import type { TrackedHand, TrackingFrame } from '../tracking/mediapipe';
import { volToY } from './songs';

export type SynthFn = (cx: number, cy: number, palm: number, fingers: number, tiltDeg: number, right: boolean, thumb: -1 | 0 | 1 | 2, pinch: boolean) => Float32Array;

export interface HandTarget {
  present: boolean;
  x: number;
  y: number;
  mask: number;
  tilt: number;
  /** -1 folded in, 0 tucked down, 1 out, 2 relaxed */
  thumb: -1 | 0 | 1 | 2;
  pinch: boolean;
}

/** Wrist easing time constant (s); slow enough to read as a hand, fast enough to settle inside a chord. */
const WRIST_TC = 0.18;
const TILT_TC = 0.25;
/** Largest wrist move per frame: the scene drops a hand that jumps more than 0.1 between frames. */
const MAX_STEP = 0.03;
/** Wrists this far apart never confuse the parser's x-ordered assignment. */
const MIN_SEPARATION = 0.28;
/** Off-screen y the hands enter from and leave to. */
const OFFSTAGE_Y = 1.12;
const FLICK_FRAMES = 4;
const PRESS_FRAMES = 10;

export class Performer {
  readonly left: HandTarget = { present: true, x: 0.66, y: 0.54, mask: 0, tilt: 25, thumb: 2, pinch: false };
  readonly right: HandTarget = { present: true, x: 0.36, y: volToY(0.6), mask: 0, tilt: 0, thumb: 0, pinch: false };
  /** latch: no sway, no easing, no press */
  freeze = false;

  private lx = 0.66;
  private ly = OFFSTAGE_Y;
  private rx = 0.36;
  private ry = OFFSTAGE_Y;
  private rtilt = 0;
  private onStage = false;
  private lastMs = -1;
  private t0 = -1;
  private flick_ = 0;
  private press_ = 0;
  private emittedL: [number, number] | null = null;
  private emittedR: [number, number] | null = null;
  private readonly lmL: { x: number; y: number; z: number }[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  private readonly lmR: { x: number; y: number; z: number }[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  // raw frame: the tracker labels the user's right hand "left" (mirrored selfie assumption)
  private readonly handL: TrackedHand = { landmarks: this.lmL, left: false, confidence: 0.95 };
  private readonly handR: TrackedHand = { landmarks: this.lmR, left: true, confidence: 0.95 };
  private readonly out: TrackingFrame = { hands: [], tMs: 0, inferenceMs: 0 };

  constructor(
    private readonly synth: SynthFn,
    readonly palm = 0.12,
  ) {}

  /** Whether frames currently carry hands. */
  get visible(): boolean {
    return this.onStage;
  }

  /** Current (eased) wrist positions, for anchoring outlines near the hands. */
  get leftWrist(): [number, number] {
    return [this.lx, this.ly];
  }
  get rightWrist(): [number, number] {
    return [this.rx, this.ry];
  }

  /** Hands appear at the bottom edge and slide up to their targets. */
  enter(): void {
    if (!this.onStage) {
      this.ly = OFFSTAGE_Y;
      this.ry = OFFSTAGE_Y;
      this.emittedL = null;
      this.emittedR = null;
    }
    this.onStage = true;
  }

  /** Hands appear in place (the mesh fades in); used to return under a latched chord without a volume dip. */
  appear(): void {
    this.ly = this.left.y;
    this.ry = this.right.y;
    this.lx = this.left.x;
    this.rx = this.right.x;
    this.emittedL = null;
    this.emittedR = null;
    this.onStage = true;
  }

  /** Hands leave the frame: omitted from frames immediately, wrists slide off stage. */
  exit(): void {
    this.onStage = false;
  }

  /** Next frame lowers every left landmark's z by 0.03 (a flick toward the camera); the following three raise it back 0.01 each. */
  flick(): void {
    this.flick_ = FLICK_FRAMES;
  }

  /** Anticipation before a pose switch: the left wrist rises over three frames, drops on the fourth, eases back over six. */
  press(): void {
    this.press_ = PRESS_FRAMES;
  }

  frame(nowMs: number): TrackingFrame {
    const dt = this.lastMs < 0 ? 0.032 : Math.max(0.001, Math.min(0.1, (nowMs - this.lastMs) / 1000));
    if (this.t0 < 0) this.t0 = nowMs;
    this.lastMs = nowMs;
    const t = (nowMs - this.t0) / 1000;
    const alpha = 1 - Math.exp(-dt / WRIST_TC);
    const tiltAlpha = 1 - Math.exp(-dt / TILT_TC);

    if (!this.freeze) {
      const tly = this.onStage ? this.left.y : OFFSTAGE_Y;
      const try_ = this.onStage ? this.right.y : OFFSTAGE_Y;
      this.lx += (this.left.x - this.lx) * alpha;
      this.ly += (tly - this.ly) * alpha;
      this.rx += (this.right.x - this.rx) * alpha;
      this.ry += (try_ - this.ry) * alpha;
      this.rtilt += (this.right.tilt - this.rtilt) * tiltAlpha;
    }

    // press offset on the left wrist (negative y = up)
    let press = 0;
    if (this.press_ > 0) {
      const k = PRESS_FRAMES - this.press_; // 0..9
      press = k < 3 ? -0.005 * (k + 1) : k === 3 ? 0.005 : 0.005 * (1 - (k - 3) / 6);
      if (!this.freeze) this.press_--;
    }
    // sway is purely visual: latching is disabled by config, not defeated by motion
    let swLx = 0;
    let swLy = 0;
    let swRx = 0;
    let swRy = 0;
    if (!this.freeze) {
      swLx = 0.008 * Math.sin(2 * Math.PI * 0.35 * t);
      swLy = 0.005 * Math.sin(2 * Math.PI * 0.5 * t + 1.1);
      swRx = 0.008 * Math.sin(2 * Math.PI * 0.35 * t + 2.3);
      swRy = 0.005 * Math.sin(2 * Math.PI * 0.5 * t + 3.9);
    }
    let lxE = this.lx + swLx;
    let lyE = this.ly + swLy + press;
    let rxE = this.rx + swRx;
    let ryE = this.ry + swRy;
    // keep the user's left hand on the right of the image and the wrists apart
    const gap = lxE - rxE;
    if (gap < MIN_SEPARATION) {
      const push = (MIN_SEPARATION - gap) / 2;
      lxE += push;
      rxE -= push;
    }
    if (this.freeze) {
      // identical frames while frozen: reuse the last emitted wrists
      if (this.emittedL) [lxE, lyE] = this.emittedL;
      if (this.emittedR) [rxE, ryE] = this.emittedR;
    } else {
      [lxE, lyE] = this.limit(this.emittedL, lxE, lyE);
      [rxE, ryE] = this.limit(this.emittedR, rxE, ryE);
    }
    this.emittedL = [lxE, lyE];
    this.emittedR = [rxE, ryE];

    const hands = this.out.hands;
    hands.length = 0;
    if (this.onStage) {
      if (this.left.present) {
        // the left thumb only matters as a finger (degrees V and VII): out when its bit is set
        const thumb = this.left.mask & 1 ? 1 : 2;
        this.fill(this.lmL, this.synth(lxE, lyE, this.palm, this.left.mask & ~1, this.left.tilt, false, thumb, false));
        if (this.flick_ > 0) {
          const dz = -0.01 * (this.flick_ - 1);
          for (const q of this.lmL) q.z += dz;
        }
        hands.push(this.handL);
      }
      if (this.right.present) {
        this.fill(this.lmR, this.synth(rxE, ryE, this.palm, this.right.mask & ~1, this.rtilt, true, this.right.thumb, this.right.pinch));
        hands.push(this.handR);
      }
    }
    if (this.flick_ > 0) this.flick_--;
    this.out.tMs = nowMs;
    return this.out;
  }

  private limit(prev: [number, number] | null, x: number, y: number): [number, number] {
    if (!prev) return [x, y];
    const dx = x - prev[0];
    const dy = y - prev[1];
    const d = Math.hypot(dx, dy);
    if (d <= MAX_STEP) return [x, y];
    const k = MAX_STEP / d;
    return [prev[0] + dx * k, prev[1] + dy * k];
  }

  private fill(lm: { x: number; y: number; z: number }[], f: Float32Array): void {
    for (let i = 0; i < 21; i++) {
      const q = lm[i];
      q.x = f[i * 3];
      q.y = f[i * 3 + 1];
      q.z = f[i * 3 + 2];
    }
  }
}
