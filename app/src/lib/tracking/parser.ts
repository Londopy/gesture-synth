// Main-thread wrapper around the Rust GestureParser (WASM).

import init, { WasmParser, default_parser_config_json } from '../wasm/pkg/gsyn.js';
import { loadWasmModule } from '../audio/audio';
import { decodeEvents, decodeState, EVENT_FLOATS, STATE_FLOATS, type GEvent, type LiveState } from '../music';

export interface HandInfo {
  present: boolean;
  confidence: number;
  fingers: [boolean, boolean, boolean, boolean, boolean];
  tilt: number;
  wrist: [number, number, number];
  palm_size: number;
  thumb: number;
  pinch: boolean;
  fist: boolean;
  z_velocity: number;
}

export const emptyHand = (): HandInfo => ({
  present: false,
  confidence: 0,
  fingers: [false, false, false, false, false],
  tilt: 0,
  wrist: [0.5, 0.5, 0],
  palm_size: 0.1,
  thumb: 0,
  pinch: false,
  fist: false,
  z_velocity: 0,
});

export type LeftScheme = { kind: 'full' } | { kind: 'scale_only' } | { kind: 'fixed_degree'; degree: number };
export type RightScheme = { kind: 'full' } | { kind: 'fixed_style'; shape: 'root' | 'inv1' | 'seventh' | 'dom_or_dim7' } | { kind: 'dynamics_only' };

export interface ParserConfig {
  stable_ms: number;
  left: LeftScheme;
  right: RightScheme;
  mode: 'gesture' | 'theremin';
  fixed_quality: 'major' | 'minor' | 'diminished' | null;
  voicing: { minor_four_finger: 'half_dim7' | 'dim7'; open_voicing: boolean };
  calibration: { top_y: number; bottom_y: number; mirror_frame: boolean; swap_hands: boolean; invert_tilt: boolean };
  theremin_snap: boolean;
  theremin_base_midi: number;
  theremin_range: number;
  flick_threshold: number;
  latch_hold_ms: number;
  confidence_floor: number;
  cutoff_tc: number;
  volume_tc: number;
}

let wasmReady: Promise<void> | null = null;

/** Initialise the main-thread WASM instance (shared compiled module with the worklet). */
export function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = loadWasmModule().then((module) => init({ module_or_path: module }).then(() => undefined));
  }
  return wasmReady;
}

export function defaultParserConfig(): ParserConfig {
  return JSON.parse(default_parser_config_json());
}

export class ParserBridge {
  private p: WasmParser;
  readonly stateBuf = new Float32Array(STATE_FLOATS);
  readonly eventBuf = new Float32Array(EVENT_FLOATS * 16);
  nEvents = 0;
  state: LiveState;
  events: GEvent[] = [];
  left: HandInfo = emptyHand();
  right: HandInfo = emptyHand();
  private lmBuf = new Float32Array(126);
  private hdBuf = new Uint8Array(2);
  private cfBuf = new Float32Array(2);

  constructor(cfg?: ParserConfig) {
    this.p = new WasmParser(cfg ? JSON.stringify(cfg) : undefined);
    this.p.state_into(this.stateBuf);
    this.state = decodeState(this.stateBuf);
  }

  setConfig(cfg: ParserConfig) {
    this.p.set_config(JSON.stringify(cfg));
    this.refresh();
  }

  config(): ParserConfig {
    return JSON.parse(this.p.config_json());
  }

  /**
   * Feed detected hands. Each hand: 21 landmarks as {x,y,z}, the tracker's
   * handedness label and a confidence score.
   */
  feed(hands: { landmarks: ArrayLike<{ x: number; y: number; z: number }>; left: boolean; confidence: number }[], tMs: number) {
    const n = Math.min(2, hands.length);
    for (let h = 0; h < n; h++) {
      const lm = hands[h].landmarks;
      for (let i = 0; i < 21; i++) {
        const b = h * 63 + i * 3;
        this.lmBuf[b] = lm[i].x;
        this.lmBuf[b + 1] = lm[i].y;
        this.lmBuf[b + 2] = lm[i].z;
      }
      this.hdBuf[h] = hands[h].left ? 0 : 1;
      this.cfBuf[h] = hands[h].confidence;
    }
    this.p.feed(this.lmBuf.subarray(0, n * 63), this.hdBuf.subarray(0, n), this.cfBuf.subarray(0, n), tMs);
    this.refresh();
  }

  private refresh() {
    this.p.state_into(this.stateBuf);
    decodeState(this.stateBuf, this.state);
    this.nEvents = this.p.events_into(this.eventBuf);
    this.events = this.nEvents ? decodeEvents(this.eventBuf, this.nEvents) : [];
    if (this.nEvents || this.framesSinceHands++ % 2 === 0) {
      const [l, r] = JSON.parse(this.p.hands_json());
      this.left = l;
      this.right = r;
    }
  }
  private framesSinceHands = 0;

  chordName(): string {
    return this.p.chord_name();
  }

  absoluteChordName(): string {
    return this.p.absolute_chord_name();
  }

  setKey(key: number, minor: boolean) {
    this.p.set_key(key, minor);
    this.refresh();
  }

  stepKey(n: number) {
    this.p.step_key(n);
    this.refresh();
  }

  setFixedDegree(d: number) {
    this.p.set_fixed_degree(d);
    this.refresh();
  }

  setArp(on: boolean) {
    this.p.set_arp(on);
    this.refresh();
  }

  allOff() {
    this.p.all_off();
    this.refresh();
  }

  destroy() {
    this.p.free();
  }
}
