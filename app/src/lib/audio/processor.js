// AudioWorkletProcessor hosting the Rust engine (spec 3 "Web build differences").
//
// Output 0: main stereo mix. Output 1: metronome cue (mono), routed to a
// separate GainNode so recordings/exports can exclude it.
//
// Live MusicalState arrives either through a SharedArrayBuffer ring (when the
// page is cross-origin isolated) or via postMessage per camera frame.

import './text-polyfill.js';
import { initSync, WasmEngine } from '../wasm/pkg/gsyn.js';

const STATE_FLOATS = 24;
const EVENT_FLOATS = 8;
const MAX_EVENTS = 16;
const POSITION_FLOATS = 21;
// SAB layout (Float32): [0]=seq [1..24]=state [25]=event count [26..26+128]=events
const SAB_SEQ = 0;
const SAB_STATE = 1;
const SAB_NEVENTS = 1 + STATE_FLOATS;
const SAB_EVENTS = SAB_NEVENTS + 1;
export const SAB_FLOATS = SAB_EVENTS + EVENT_FLOATS * MAX_EVENTS;

class GsynProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = null;
    this.sab = null;
    this.sabInt = null;
    this.lastSeq = -1;
    this.blocksUntilPost = 0;
    this.posBuf = new Float32Array(POSITION_FLOATS);
    this.trackBuf = new Float32Array(STATE_FLOATS * 4);
    this.evBuf = new Float32Array(EVENT_FLOATS * 32);
    this.liveState = new Float32Array(STATE_FLOATS);
    this.liveEvents = new Float32Array(EVENT_FLOATS * MAX_EVENTS);
    this.postEvery = Math.max(1, Math.round(sampleRate / 128 / 60)); // ~60 Hz
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    try {
      switch (msg.type) {
        case 'init': {
          // Chromium drops port messages carrying a WebAssembly.Module, so the main
          // thread sends raw bytes and we compile here (sync compile is allowed in worklets).
          const module = msg.module instanceof WebAssembly.Module ? msg.module : new WebAssembly.Module(msg.bytes);
          initSync({ module });
          this.engine = new WasmEngine(sampleRate);
          if (msg.sab) {
            this.sab = new Float32Array(msg.sab);
            this.sabInt = new Int32Array(msg.sab);
          }
          if (msg.settings) this.engine.set_settings(msg.settings);
          this.port.postMessage({ type: 'ready', sampleRate });
          break;
        }
        case 'live': {
          if (!this.engine) return;
          this.engine.set_live(msg.state, msg.events);
          break;
        }
        case 'cmd': {
          if (!this.engine) return;
          this.engine.command(msg.json);
          break;
        }
        case 'call': {
          if (!this.engine) return;
          let value;
          const fn = this.engine[msg.method];
          if (typeof fn !== 'function') throw new Error('unknown method ' + msg.method);
          value = fn.apply(this.engine, msg.args || []);
          this.port.postMessage({ type: 'result', id: msg.id, value });
          break;
        }
      }
    } catch (err) {
      this.port.postMessage({ type: 'error', id: msg.id, message: String(err && err.message ? err.message : err) });
    }
  }

  readSab() {
    const seq = Atomics.load(this.sabInt, SAB_SEQ);
    if (seq === this.lastSeq) return;
    this.lastSeq = seq;
    this.liveState.set(this.sab.subarray(SAB_STATE, SAB_STATE + STATE_FLOATS));
    const n = Math.min(MAX_EVENTS, this.sab[SAB_NEVENTS] | 0);
    const ev = this.sab.subarray(SAB_EVENTS, SAB_EVENTS + n * EVENT_FLOATS);
    this.engine.set_live(this.liveState, ev);
    if (n > 0) {
      // consume events so a re-read of the same seq never replays them
      this.sab[SAB_NEVENTS] = 0;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const cueOut = outputs[1];
    if (!this.engine || !out || out.length < 2) return true;
    if (this.sab) this.readSab();
    const l = out[0];
    const r = out[1];
    const cue = cueOut && cueOut[0] ? cueOut[0] : this.scratchCue || (this.scratchCue = new Float32Array(l.length));
    this.engine.process(l, r, cue);

    if (--this.blocksUntilPost <= 0) {
      this.blocksUntilPost = this.postEvery;
      this.engine.position_into(this.posBuf);
      for (let t = 0; t < 4; t++) {
        this.engine.track_state_into(t, this.trackBuf.subarray(t * STATE_FLOATS, (t + 1) * STATE_FLOATS));
      }
      const n = this.engine.take_ui_events_into(this.evBuf);
      const midi = this.engine.drain_midi();
      this.port.postMessage({
        type: 'pos',
        pos: this.posBuf,
        tracks: this.trackBuf,
        events: n > 0 ? this.evBuf.slice(0, n * EVENT_FLOATS) : null,
        n,
        midi: midi.length ? midi : null,
      });
    }
    return true;
  }
}

registerProcessor('gsyn-engine', GsynProcessor);
