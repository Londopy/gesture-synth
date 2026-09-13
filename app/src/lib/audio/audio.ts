// Main-thread side of the browser audio engine: AudioContext, worklet node,
// analyser (for audio-reactive visuals), recording tap, and the message/SAB
// protocol to the Rust engine running inside the worklet.

import processorUrl from './processor.js?worker&url';
import wasmUrl from '../wasm/pkg/gsyn_bg.wasm?url';
import { EVENT_FLOATS, POSITION_FLOATS, STATE_FLOATS } from '../music';
import { hasSAB } from '../platform';

const MAX_EVENTS = 16;
const SAB_SEQ = 0;
const SAB_STATE = 1;
const SAB_NEVENTS = 1 + STATE_FLOATS;
const SAB_EVENTS = SAB_NEVENTS + 1;
const SAB_FLOATS = SAB_EVENTS + EVENT_FLOATS * MAX_EVENTS;

export interface PosMessage {
  pos: Float32Array;
  tracks: Float32Array;
  events: Float32Array | null;
  n: number;
  midi: Uint8Array | null;
}

export type EngineBackend = {
  readonly ready: boolean;
  readonly sampleRate: number;
  readonly outputLatencyMs: number;
  setLive(state: Float32Array, events: Float32Array, nEvents: number): void;
  command(cmd: object): void;
  call<T = any>(method: string, ...args: any[]): Promise<T>;
  onPosition(cb: (m: PosMessage) => void): () => void;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  destroy(): void;
};

let wasmBytes: Promise<ArrayBuffer> | null = null;
let compiledModule: Promise<WebAssembly.Module> | null = null;

/** Raw .wasm bytes (shared by the main thread and the worklet). */
export function loadWasmBytes(): Promise<ArrayBuffer> {
  if (!wasmBytes) {
    wasmBytes = fetch(wasmUrl).then(async (r) => {
      if (!r.ok) throw new Error(`wasm fetch failed: ${r.status}`);
      return r.arrayBuffer();
    });
  }
  return wasmBytes;
}

export function loadWasmModule(): Promise<WebAssembly.Module> {
  if (!compiledModule) compiledModule = loadWasmBytes().then((b) => WebAssembly.compile(b));
  return compiledModule;
}

export class WorkletEngine implements EngineBackend {
  ctx: AudioContext;
  node: AudioWorkletNode | null = null;
  master: GainNode;
  cueGain: GainNode;
  analyser: AnalyserNode;
  /** Everything except the cue bus (for MediaRecorder / bounce). */
  recordTap: MediaStreamAudioDestinationNode | null = null;
  ready = false;
  private sab: SharedArrayBuffer | null = null;
  private sabF: Float32Array | null = null;
  private sabI: Int32Array | null = null;
  private seq = 0;
  private posListeners = new Set<(m: PosMessage) => void>();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private nextId = 1;
  private fft = new Uint8Array(512);

  constructor(opts: { latencyHint?: AudioContextLatencyCategory | number; sampleRate?: number } = {}) {
    this.ctx = new AudioContext({ latencyHint: opts.latencyHint ?? 'interactive', sampleRate: opts.sampleRate ?? 48000 });
    this.master = this.ctx.createGain();
    this.cueGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.cueGain.connect(this.ctx.destination);
    if (typeof MediaStreamAudioDestinationNode !== 'undefined') {
      this.recordTap = this.ctx.createMediaStreamDestination();
      this.master.connect(this.recordTap);
    }
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get outputLatencyMs(): number {
    const base = this.ctx.baseLatency ?? 0;
    const out = (this.ctx as any).outputLatency ?? 0;
    return Math.round((base + out) * 1000);
  }

  get usingSAB(): boolean {
    return !!this.sab;
  }

  async init(settingsJson?: string): Promise<void> {
    const [bytes] = await Promise.all([loadWasmBytes(), this.ctx.audioWorklet.addModule(processorUrl)]);
    this.node = new AudioWorkletNode(this.ctx, 'gsyn-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 2,
      outputChannelCount: [2, 1],
    });
    this.node.connect(this.master, 0);
    this.node.connect(this.cueGain, 1);
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    if (hasSAB) {
      this.sab = new SharedArrayBuffer(SAB_FLOATS * 4);
      this.sabF = new Float32Array(this.sab);
      this.sabI = new Int32Array(this.sab);
    }
    const readyP = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    // send a copy of the bytes: a WebAssembly.Module is silently dropped by Chromium's worklet port
    this.node.port.postMessage({ type: 'init', bytes: bytes.slice(0), sab: this.sab, settings: settingsJson });
    await readyP;
    this.ready = true;
  }

  private readyResolve: (() => void) | null = null;

  private onMessage(m: any) {
    switch (m.type) {
      case 'ready':
        this.readyResolve?.();
        break;
      case 'pos':
        for (const cb of this.posListeners) cb(m as PosMessage);
        break;
      case 'result': {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          p.resolve(m.value);
        }
        break;
      }
      case 'error': {
        if (m.id != null) {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            p.reject(new Error(m.message));
            break;
          }
        }
        console.error('[worklet]', m.message);
        break;
      }
    }
  }

  setLive(state: Float32Array, events: Float32Array, nEvents: number): void {
    if (!this.node) return;
    if (this.sabF && this.sabI) {
      // append events if the worklet has not consumed the previous ones yet
      const existing = this.sabF[SAB_NEVENTS] | 0;
      const n = Math.min(MAX_EVENTS, existing + nEvents);
      if (nEvents > 0) {
        this.sabF.set(events.subarray(0, (n - existing) * EVENT_FLOATS), SAB_EVENTS + existing * EVENT_FLOATS);
      }
      this.sabF.set(state.subarray(0, STATE_FLOATS), SAB_STATE);
      this.sabF[SAB_NEVENTS] = n;
      Atomics.store(this.sabI, SAB_SEQ, ++this.seq);
    } else {
      this.node.port.postMessage({ type: 'live', state: state.slice(0, STATE_FLOATS), events: events.slice(0, nEvents * EVENT_FLOATS) });
    }
  }

  command(cmd: object): void {
    this.node?.port.postMessage({ type: 'cmd', json: JSON.stringify(cmd) });
  }

  call<T = any>(method: string, ...args: any[]): Promise<T> {
    if (!this.node) return Promise.reject(new Error('engine not ready'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.node!.port.postMessage({ type: 'call', id, method, args });
    });
  }

  onPosition(cb: (m: PosMessage) => void): () => void {
    this.posListeners.add(cb);
    return () => this.posListeners.delete(cb);
  }

  /** Bass (< ~150 Hz) and treble energies 0..1 for the visuals. */
  spectrum(): { bass: number; treble: number; level: number } {
    this.analyser.getByteFrequencyData(this.fft);
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const bassBins = Math.max(1, Math.floor(150 / binHz));
    let bass = 0;
    for (let i = 0; i < bassBins; i++) bass += this.fft[i];
    bass /= bassBins * 255;
    let treble = 0;
    const tStart = Math.floor(3000 / binHz);
    const tEnd = Math.min(this.fft.length, Math.floor(12000 / binHz));
    for (let i = tStart; i < tEnd; i++) treble += this.fft[i];
    treble /= Math.max(1, tEnd - tStart) * 255;
    let level = 0;
    for (let i = 0; i < this.fft.length; i++) level += this.fft[i];
    level /= this.fft.length * 255;
    return { bass, treble, level };
  }

  setMetronomeMonitor(on: boolean) {
    this.cueGain.gain.value = on ? 1 : 0;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async suspend(): Promise<void> {
    if (this.ctx.state === 'running') await this.ctx.suspend();
  }

  destroy(): void {
    this.node?.disconnect();
    this.node = null;
    void this.ctx.close();
  }
}

export { STATE_FLOATS, EVENT_FLOATS, POSITION_FLOATS, SAB_FLOATS };
