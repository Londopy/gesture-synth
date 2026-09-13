// Desktop backend: the Rust engine runs natively (cpal audio thread, midir MIDI)
// inside the Tauri core. Landmark-derived state is sent over IPC per camera
// frame; position/track state comes back as a 60 Hz Tauri event.

import type { EngineBackend, PosMessage } from '../audio/audio';
import { EVENT_FLOATS, STATE_FLOATS } from '../music';

export class TauriEngine implements EngineBackend {
  ready = false;
  sampleRate = 48000;
  outputLatencyMs = 0;
  private listeners = new Set<(m: PosMessage) => void>();
  private unlisten: (() => void) | null = null;
  private invoke!: (cmd: string, args?: any) => Promise<any>;
  private pending = false;
  private queuedState: Float32Array | null = null;
  private queuedEvents: number[] = [];

  async init(settingsJson?: string): Promise<{ device: string; sampleRate: number; latencyMs: number }> {
    const core = await import('@tauri-apps/api/core');
    const ev = await import('@tauri-apps/api/event');
    this.invoke = core.invoke;
    const info = (await core.invoke('native_audio_start', { settings: settingsJson ?? null })) as { device: string; sample_rate: number; latency_ms: number };
    this.sampleRate = info.sample_rate;
    this.outputLatencyMs = info.latency_ms;
    this.unlisten = await ev.listen<{ pos: number[]; tracks: number[]; events: number[]; midi: number[] }>('gsyn://position', (e) => {
      const p = e.payload;
      const m: PosMessage = {
        pos: Float32Array.from(p.pos),
        tracks: Float32Array.from(p.tracks),
        events: p.events?.length ? Float32Array.from(p.events) : null,
        n: (p.events?.length ?? 0) / EVENT_FLOATS,
        midi: null, // MIDI is sent by the Rust side (midir)
      };
      for (const cb of this.listeners) cb(m);
    });
    this.ready = true;
    return { device: info.device, sampleRate: info.sample_rate, latencyMs: info.latency_ms };
  }

  setLive(state: Float32Array, events: Float32Array, nEvents: number): void {
    // coalesce: never let IPC calls pile up; events accumulate, state is latest-wins
    this.queuedState = state.slice(0, STATE_FLOATS);
    for (let i = 0; i < nEvents * EVENT_FLOATS; i++) this.queuedEvents.push(events[i]);
    if (this.pending) return;
    this.pending = true;
    const flush = async () => {
      while (this.queuedState) {
        const s = Array.from(this.queuedState);
        const e = this.queuedEvents;
        this.queuedState = null;
        this.queuedEvents = [];
        try {
          await this.invoke('native_set_live', { state: s, events: e });
        } catch (err) {
          console.warn('[tauri] set_live failed', err);
        }
      }
      this.pending = false;
    };
    void flush();
  }

  command(cmd: object): void {
    void this.invoke('native_command', { json: JSON.stringify(cmd) });
  }

  call<T = any>(method: string, ...args: any[]): Promise<T> {
    return this.invoke('native_call', { method, args: JSON.stringify(args) }).then((r: any) => (typeof r === 'string' ? tryParse(r) : r));
  }

  onPosition(cb: (m: PosMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async resume(): Promise<void> {}
  async suspend(): Promise<void> {}

  destroy(): void {
    this.unlisten?.();
    void this.invoke?.('native_audio_stop');
  }
}

function tryParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
