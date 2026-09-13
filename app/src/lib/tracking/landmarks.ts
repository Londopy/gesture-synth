// Landmark recording at 15 Hz alongside a loop recording, and interpolated
// playback for the translucent "ghost" hands (spec 8 "Loop visuals").

export interface LandmarkFrame {
  t: number; // loop position, samples
  left?: number[]; // 63 floats
  right?: number[];
}

const RATE_HZ = 15;

export class LandmarkRecorder {
  frames: LandmarkFrame[] = [];
  private nextT = -1;
  private intervalSamples: number;
  active = false;
  track = -1;

  constructor(sampleRate: number) {
    this.intervalSamples = Math.round(sampleRate / RATE_HZ);
  }

  start(track: number) {
    this.frames = [];
    this.nextT = 0;
    this.active = true;
    this.track = track;
  }

  /** Offer the current hands at loop position `pos`. */
  offer(pos: number, left: Float32Array | null, right: Float32Array | null) {
    if (!this.active) return;
    if (pos < this.nextT - this.intervalSamples * 2) {
      // wrapped: the recording is over for this pass; keep frames, stop
      return;
    }
    if (pos >= this.nextT) {
      this.frames.push({
        t: Math.round(pos),
        left: left ? Array.from(left) : undefined,
        right: right ? Array.from(right) : undefined,
      });
      this.nextT = pos + this.intervalSamples;
    }
  }

  finish(): LandmarkFrame[] {
    this.active = false;
    const f = this.frames;
    this.frames = [];
    return f;
  }
}

export class GhostTrack {
  frames: LandmarkFrame[] = [];
  loopLen = 1;
  private outL = new Float32Array(63);
  private outR = new Float32Array(63);
  hasLeft = false;
  hasRight = false;

  set(frames: LandmarkFrame[], loopLen: number) {
    this.frames = frames.slice().sort((a, b) => a.t - b.t);
    this.loopLen = Math.max(1, loopLen);
  }

  get empty(): boolean {
    return this.frames.length === 0;
  }

  /** Interpolated landmarks at loop position `pos`. Returns [left|null, right|null]. */
  sample(pos: number): [Float32Array | null, Float32Array | null] {
    const n = this.frames.length;
    if (n === 0) return [null, null];
    const p = ((pos % this.loopLen) + this.loopLen) % this.loopLen;
    // binary search for the frame after p
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid].t <= p) lo = mid + 1;
      else hi = mid;
    }
    const b = this.frames[lo % n];
    const a = this.frames[(lo + n - 1) % n];
    let span = b.t - a.t;
    let dt = p - a.t;
    if (span <= 0) {
      span += this.loopLen;
      if (dt < 0) dt += this.loopLen;
    }
    const k = span > 0 ? Math.min(1, Math.max(0, dt / span)) : 0;
    this.hasLeft = lerpInto(this.outL, a.left, b.left, k);
    this.hasRight = lerpInto(this.outR, a.right, b.right, k);
    return [this.hasLeft ? this.outL : null, this.hasRight ? this.outR : null];
  }
}

function lerpInto(out: Float32Array, a: number[] | undefined, b: number[] | undefined, k: number): boolean {
  if (!a && !b) return false;
  if (a && !b) {
    out.set(a);
    return k < 0.5;
  }
  if (!a && b) {
    out.set(b);
    return k >= 0.5;
  }
  for (let i = 0; i < 63; i++) out[i] = a![i] + (b![i] - a![i]) * k;
  return true;
}

/** Flatten MediaPipe landmarks to 63 floats. */
export function flattenLandmarks(lm: ArrayLike<{ x: number; y: number; z: number }>, out = new Float32Array(63)): Float32Array {
  for (let i = 0; i < 21; i++) {
    out[i * 3] = lm[i].x;
    out[i * 3 + 1] = lm[i].y;
    out[i * 3 + 2] = lm[i].z;
  }
  return out;
}

/** MediaPipe hand skeleton as landmark index pairs. */
export const HAND_BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const FINGERTIPS = [4, 8, 12, 16, 20];
/** landmark index -> finger (0 thumb .. 4 pinky), wrist = -1 */
export const LANDMARK_FINGER = [-1, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
