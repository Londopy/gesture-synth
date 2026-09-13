import type { LiveState, Position } from '../music';
import type { Theme } from '../themes';

export interface SceneHand {
  present: boolean;
  /** 63 floats in image coords (x right, y down, 0..1) or null */
  landmarks: Float32Array | null;
  fingers: [boolean, boolean, boolean, boolean, boolean];
  tilt: number;
}

export interface SceneGhost {
  active: boolean;
  left: Float32Array | null;
  right: Float32Array | null;
  color: string;
  state: LiveState;
}

export interface Burst {
  slot: number; // 4 = live
  notes: number[];
  volume: number;
  seventh: boolean;
  root: number; // pitch class
}

export interface LearnTarget {
  left: Float32Array | null;
  right: Float32Array | null;
  matchLeft: boolean;
  matchRight: boolean;
  /** 0..1 progress until the chord is due */
  countdown: number;
}

export interface SceneFrame {
  time: number;
  dt: number;
  live: LiveState;
  left: SceneHand;
  right: SceneHand;
  ghosts: SceneGhost[];
  position: Position;
  bass: number;
  treble: number;
  level: number;
  theme: Theme;
  keyHue: number;
  /** consumed each frame */
  bursts: Burst[];
  bassHits: number;
  learn: LearnTarget | null;
  /** 0..1 pulse that decays after each beat, larger on bar starts */
  beatPulse: number;
  mirror: boolean;
}

export type QualityLevel = 0 | 1 | 2 | 3; // 0 full .. 3 lowest

export interface Layer {
  update(f: SceneFrame): void;
  resize(width: number, height: number, aspect: number): void;
  setQuality(q: QualityLevel): void;
  dispose(): void;
}

/** Convert image-space landmark to scene space (orthographic, y up, x in +-aspect). */
export function toScene(x: number, y: number, aspect: number, mirror: boolean): [number, number] {
  const sx = (mirror ? 0.5 - x : x - 0.5) * 2 * aspect;
  const sy = (0.5 - y) * 2;
  return [sx, sy];
}

export function hsl(h: number, s: number, l: number): string {
  return `hsl(${((h % 360) + 360) % 360} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}
