// The runtime: camera -> parser -> engine backend (worklet or native) and the
// reactive state the UI and scene read. One producer per slot (spec 3).

import { WorkletEngine, type EngineBackend, type PosMessage } from '../audio/audio';
import { midiOut } from '../audio/midi';
import { decodeEvents, decodePosition, decodeState, defaultPosition, defaultState, EVENT_FLOATS, STATE_FLOATS, hueOf, type GEvent, type LiveState, type Position } from '../music';
import { flags } from '../platform';
import { ensureWasm, ParserBridge, emptyHand, type HandInfo, type ParserConfig } from '../tracking/parser';
import { Tracking, type TrackingFrame, type TrackingStatus } from '../tracking/mediapipe';
import { flattenLandmarks, GhostTrack, LandmarkRecorder, type LandmarkFrame } from '../tracking/landmarks';
import { settings } from './settings.svelte';
import { TauriEngine } from './tauri-backend';
import type { Burst } from '../scene/types';

export type StartPhase = 'idle' | 'audio' | 'camera' | 'ready' | 'error';

export interface TrackSummary {
  name: string;
  instrument: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  midi_ch: number;
  length_bars: number;
  empty: boolean;
  events: number;
}

export interface GridCell {
  degree: number;
  quality: number;
  shape: number;
  octave: number;
  notes: number[];
  count: number;
  volume: number;
}

export interface Grid {
  cells: (GridCell | null)[][];
  mutes: boolean[][];
  steps_per_bar: number;
}

type Listener = (e: GEvent & { slot: number }) => void;

class Runtime {
  // ---- reactive state -------------------------------------------------------
  phase = $state<StartPhase>('idle');
  error = $state('');
  live = $state<LiveState>(defaultState());
  tracks = $state<LiveState[]>([defaultState(), defaultState(), defaultState(), defaultState()]);
  position = $state<Position>(defaultPosition());
  left = $state<HandInfo>(emptyHand());
  right = $state<HandInfo>(emptyHand());
  trackingStatus = $state<TrackingStatus>('idle');
  cameraFailed = $state(false);
  trackingFps = $state(0);
  inferenceMs = $state(0);
  latencyMs = $state(0);
  audioDevice = $state('');
  usingNative = $state(false);
  usingSAB = $state(false);
  chordName = $state('');
  absChordName = $state('');
  trackSummary = $state<TrackSummary[]>([]);
  grid = $state<Grid | null>(null);
  sessionName = $state('Untitled session');
  dirty = $state(false);
  keyHue = $derived(hueOf(this.live.key));

  // ---- non-reactive hot data (read by the scene each frame) -----------------
  leftLandmarks: Float32Array | null = null;
  rightLandmarks: Float32Array | null = null;
  ghosts: GhostTrack[] = [new GhostTrack(), new GhostTrack(), new GhostTrack(), new GhostTrack()];
  bursts: Burst[] = [];
  bassHits = 0;
  video: HTMLVideoElement | null = null;

  backend: EngineBackend | null = null;
  worklet: WorkletEngine | null = null;
  parser: ParserBridge | null = null;
  tracking: Tracking | null = null;
  private recorder: LandmarkRecorder | null = null;
  private lastRecording = 0;
  private lastRecTrack = -1;
  private listeners = new Set<Listener>();
  private posBuf = new Float32Array(STATE_FLOATS);
  private lastPosSeq = -1;
  private summaryTimer = 0;
  private lm = [new Float32Array(63), new Float32Array(63)];
  private trackFloats = new Float32Array(STATE_FLOATS * 4);

  // ---- lifecycle --------------------------------------------------------------

  /** First user click: start audio (autoplay policy), then camera. */
  async start(): Promise<void> {
    if (this.phase !== 'idle' && this.phase !== 'error') return;
    try {
      this.phase = 'audio';
      await ensureWasm();
      const cfg = settings.s.parser;
      this.parser = new ParserBridge(cfg);
      await this.startBackend();
      this.applySettingsToEngine();
      this.phase = 'camera';
      try {
        await this.startCamera();
      } catch (camErr: any) {
        // No camera is not fatal: audio, keyboard, loops and every page still work.
        this.error = camErr?.message ?? String(camErr);
        this.cameraFailed = true;
      }
      this.phase = 'ready';
      this.refreshSummary();
    } catch (e: any) {
      console.error(e);
      this.error = e?.message ?? String(e);
      this.phase = 'error';
    }
  }

  private async startBackend() {
    const wantNative = flags.isTauri && settings.s.nativeAudio;
    const settingsJson = JSON.stringify(this.engineSettings());
    if (wantNative) {
      try {
        const t = new TauriEngine();
        const info = await t.init(settingsJson);
        this.backend = t;
        this.usingNative = true;
        this.audioDevice = info.device;
        this.latencyMs = info.latencyMs;
      } catch (e) {
        console.warn('[audio] native backend failed, using webview AudioWorklet', e);
      }
    }
    if (!this.backend) {
      const w = new WorkletEngine({ latencyHint: 'interactive' });
      await w.resume();
      await w.init(settingsJson);
      this.worklet = w;
      this.backend = w;
      this.usingSAB = w.usingSAB;
      this.latencyMs = w.outputLatencyMs;
      this.audioDevice = 'Web Audio';
      w.setMetronomeMonitor(settings.s.metronomeMonitor);
    }
    this.recorder = new LandmarkRecorder(this.backend.sampleRate);
    this.backend.onPosition((m) => this.onPosition(m));
    if (settings.s.midiOut && midiOut.available) {
      await midiOut.init();
      if (settings.s.midiPortId) midiOut.select(settings.s.midiPortId);
      midiOut.enabled = true;
    }
  }

  private engineSettings() {
    const s = settings.s;
    return {
      quantize_input: s.quantizeInput,
      metronome_volume: s.metronomeVolume,
      metronome_enabled: s.metronomeEnabled,
      midi_enabled: s.midiOut,
      midi_live_channel: s.midiLiveChannel,
      midi_use_expression: false,
      reverb_enabled: true,
      delay_enabled: true,
      bounce_live: false,
    };
  }

  applySettingsToEngine() {
    const s = settings.s;
    if (!this.backend) return;
    this.cmd({ cmd: 'set_quantize', quantize: s.quantize });
    this.cmd({ cmd: 'set_record_mode', mode: s.recordMode });
    this.cmd({ cmd: 'set_loop_record', on: s.loopRecord });
    this.cmd({ cmd: 'set_wrap_at_loop_end', on: s.wrapAtLoopEnd });
    this.cmd({ cmd: 'set_quantize_input', mode: s.quantizeInput });
    this.cmd({ cmd: 'set_count_in_bars', bars: s.countInBars });
    this.cmd({ cmd: 'set_metronome_volume', volume: s.metronomeVolume });
    this.cmd({ cmd: 'set_metronome_enabled', on: s.metronomeEnabled });
    this.cmd({ cmd: 'set_midi_enabled', on: s.midiOut });
    this.worklet?.setMetronomeMonitor(s.metronomeMonitor);
    void this.setLiveInstrument(s.liveInstrument);
    void this.setThereminInstrument(s.thereminInstrument);
  }

  async startCamera(deviceId?: string) {
    if (!this.tracking) {
      this.tracking = new Tracking();
      this.tracking.onStatus = (st, err) => {
        this.trackingStatus = st;
        if (err) this.error = err;
      };
      this.tracking.onFrame = (f) => this.onFrame(f);
      this.video = this.tracking.video;
    }
    await this.tracking.start(deviceId ?? (settings.s.cameraDeviceId || undefined));
  }

  async switchCamera(deviceId: string) {
    settings.s.cameraDeviceId = deviceId;
    await this.tracking?.switchCamera(deviceId);
  }

  stopCamera() {
    this.tracking?.stop();
  }

  // ---- per-frame path ---------------------------------------------------------

  private onFrame(f: TrackingFrame) {
    if (!this.parser || !this.backend) return;
    this.trackingFps = this.tracking?.fps ?? 0;
    this.inferenceMs = Math.round(this.tracking?.inferenceMs ?? 0);
    this.parser.feed(f.hands, f.tMs);
    this.backend.setLive(this.parser.stateBuf, this.parser.eventBuf, this.parser.nEvents);
    // reactive copies (cheap: primitives + small arrays)
    const s = this.parser.state;
    const l = this.live;
    if (
      l.degree !== s.degree ||
      l.quality !== s.quality ||
      l.shape !== s.shape ||
      l.octave !== s.octave ||
      l.key !== s.key ||
      l.minor !== s.minor ||
      l.arp !== s.arp ||
      l.latched !== s.latched ||
      l.theremin !== s.theremin ||
      Math.abs(l.volume - s.volume) > 0.01 ||
      Math.abs(l.cutoff - s.cutoff) > 0.01 ||
      Math.abs(l.pan - s.pan) > 0.02 ||
      Math.abs(l.confidence - s.confidence) > 0.05 ||
      Math.abs(l.thereminHz - s.thereminHz) > 1 ||
      Math.abs(l.arpRate - s.arpRate) > 0.02
    ) {
      this.live = { ...s, notes: s.notes.slice() };
      this.chordName = this.parser.chordName();
      this.absChordName = this.parser.absoluteChordName();
    }
    this.left = this.parser.left;
    this.right = this.parser.right;
    // landmarks for the scene (parser has the mirror-corrected assignment)
    this.leftLandmarks = null;
    this.rightLandmarks = null;
    for (const h of f.hands) {
      // assign by proximity to the parser's wrist positions
      const wx = h.landmarks[0].x;
      const wy = h.landmarks[0].y;
      const dl = this.parser.left.present ? Math.hypot(wx - this.parser.left.wrist[0], wy - this.parser.left.wrist[1]) : 9;
      const dr = this.parser.right.present ? Math.hypot(wx - this.parser.right.wrist[0], wy - this.parser.right.wrist[1]) : 9;
      if (dl < dr && dl < 0.1) this.leftLandmarks = flattenLandmarks(h.landmarks, this.lm[0]);
      else if (dr < 0.1) this.rightLandmarks = flattenLandmarks(h.landmarks, this.lm[1]);
    }
    for (const e of this.parser.events) {
      if (e.type === 'key') this.dirty = true;
    }
    if (this.recorder?.active) {
      this.recorder.offer(this.position.position, this.leftLandmarks, this.rightLandmarks);
    }
  }

  private onPosition(m: PosMessage) {
    const p = decodePosition(m.pos, this.position);
    // reassign for reactivity (struct copy is small)
    this.position = { ...p };
    for (let t = 0; t < 4; t++) {
      const st = decodeState(m.tracks.subarray(t * STATE_FLOATS, (t + 1) * STATE_FLOATS));
      const cur = this.tracks[t];
      if (cur.degree !== st.degree || cur.shape !== st.shape || cur.quality !== st.quality || Math.abs(cur.volume - st.volume) > 0.02 || Math.abs(cur.cutoff - st.cutoff) > 0.02 || cur.arp !== st.arp) {
        this.tracks[t] = st;
      }
    }
    if (m.events && m.n > 0) {
      for (const e of decodeEvents(m.events, m.n)) {
        this.emit({ ...e, slot: 4 });
        if (e.type === 'chord_on') {
          this.bursts.push({ slot: 4, notes: e.notes, volume: this.live.volume, seventh: e.shape >= 2, root: e.notes[0] % 12 });
        } else if (e.type === 'bass') {
          this.bassHits++;
        }
      }
    }
    if (m.midi && midiOut.enabled) midiOut.send(m.midi);
    // recording lifecycle for ghost landmarks
    if (p.recording === 2 && this.lastRecording !== 2) {
      this.recorder?.start(p.recTrack ?? p.selected);
    } else if (p.recording !== 2 && this.lastRecording === 2) {
      const frames = this.recorder?.finish() ?? [];
      const track = this.lastRecTrack >= 0 ? this.lastRecTrack : p.selected;
      if (frames.length) {
        void this.backend?.call('set_track_landmarks_json', track, JSON.stringify(frames));
        this.ghosts[track].set(frames, p.loopLen);
      }
      this.dirty = true;
      this.refreshSummary();
    }
    this.lastRecording = p.recording;
    if (p.recTrack != null) this.lastRecTrack = p.recTrack;
    // track chord-on bursts (compare with previous)
  }

  /** Called by the scene each frame to advance ghost playback. */
  sampleGhosts(): void {
    const pos = this.position.position;
    for (let i = 0; i < 4; i++) {
      const g = this.ghosts[i];
      if (!g.empty) g.sample(pos);
    }
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: GEvent & { slot: number }) {
    for (const l of this.listeners) l(e);
  }

  // ---- commands ---------------------------------------------------------------

  cmd(c: object) {
    this.backend?.command(c);
    this.dirty = true;
    this.scheduleSummary();
  }

  togglePlay() {
    this.cmd({ cmd: 'toggle_play' });
  }
  play() {
    this.cmd({ cmd: 'play' });
  }
  stop() {
    this.cmd({ cmd: 'stop' });
  }
  record(track?: number) {
    this.cmd({ cmd: 'record', track: track ?? this.position.selected });
  }
  toggleRecord() {
    this.cmd({ cmd: 'toggle_record' });
  }
  selectTrack(i: number) {
    this.cmd({ cmd: 'select_track', track: i });
  }
  toggleMute(i = this.position.selected) {
    this.cmd({ cmd: 'toggle_mute', track: i });
  }
  toggleSolo(i = this.position.selected) {
    this.cmd({ cmd: 'toggle_solo', track: i });
  }
  clearTrack(i = this.position.selected) {
    this.cmd({ cmd: 'clear_track', track: i });
    this.ghosts[i].set([], 1);
  }
  clearAll() {
    this.cmd({ cmd: 'clear_all' });
    this.ghosts.forEach((g) => g.set([], 1));
  }
  setBpm(bpm: number) {
    this.cmd({ cmd: 'set_bpm', bpm });
  }
  nudgeBpm(delta: number) {
    this.cmd({ cmd: 'nudge_bpm', delta });
  }
  setTimeSig(beats: number, unit: number) {
    this.cmd({ cmd: 'set_time_sig', beats, unit });
  }
  setBars(bars: number) {
    this.cmd({ cmd: 'set_bars', bars });
  }
  panic() {
    this.cmd({ cmd: 'panic' });
    this.parser?.allOff();
    midiOut.allNotesOff();
  }
  setKey(key: number, minor: boolean) {
    this.parser?.setKey(key, minor);
    this.cmd({ cmd: 'set_key', key: keyName(key), mode: minor ? 'minor' : 'major' });
    this.syncLive();
  }
  stepKey(n: number) {
    this.parser?.stepKey(n);
    const s = this.parser?.state;
    if (s) this.cmd({ cmd: 'set_key', key: keyName(s.key), mode: s.minor ? 'minor' : 'major' });
    this.syncLive();
  }
  toggleMode() {
    const cfg = settings.s.parser;
    cfg.mode = cfg.mode === 'gesture' ? 'theremin' : 'gesture';
    this.setParserConfig(cfg);
  }
  setParserConfig(cfg: ParserConfig) {
    settings.s.parser = cfg;
    this.parser?.setConfig(cfg);
    this.syncLive();
  }
  setFixedDegree(d: number) {
    this.parser?.setFixedDegree(d);
    settings.s.parser = this.parser?.config() ?? settings.s.parser;
    this.syncLive();
  }
  toggleArp() {
    this.parser?.setArp(!this.live.arp);
    this.syncLive();
  }

  private syncLive() {
    if (!this.parser || !this.backend) return;
    this.backend.setLive(this.parser.stateBuf, this.parser.eventBuf, this.parser.nEvents);
    this.live = { ...this.parser.state, notes: this.parser.state.notes.slice() };
    this.chordName = this.parser.chordName();
    this.absChordName = this.parser.absoluteChordName();
  }

  toggleStepMute(track: number, step: number) {
    this.cmd({ cmd: 'toggle_step_mute', track, step });
    void this.refreshGrid();
  }

  async replaceChord(track: number, step: number, degree: number, quality: number, shape: number, octave = 0) {
    await this.backend?.call('replace_chord', track, step, degree, quality, shape, octave);
    this.dirty = true;
    await this.refreshGrid();
  }

  setTrackVolume(i: number, v: number) {
    this.cmd({ cmd: 'set_track_volume', track: i, volume: v });
  }
  setTrackPan(i: number, p: number) {
    this.cmd({ cmd: 'set_track_pan', track: i, pan: p });
  }
  setTrackLength(i: number, bars: number) {
    this.cmd({ cmd: 'set_track_length', track: i, bars });
  }
  setTrackMidi(i: number, ch: number) {
    this.cmd({ cmd: 'set_track_midi_channel', track: i, channel: ch });
  }

  async setTrackInstrument(track: number, inst: object) {
    await this.backend?.call('set_track_instrument', track, JSON.stringify(inst));
    this.dirty = true;
    this.scheduleSummary();
  }

  async setLiveInstrument(nameOrInst: string | object) {
    const inst = typeof nameOrInst === 'string' ? await this.builtinInstrument(nameOrInst) : nameOrInst;
    if (!inst) return;
    if (typeof nameOrInst === 'string') settings.s.liveInstrument = nameOrInst;
    await this.backend?.call('set_track_instrument', 4, JSON.stringify(inst));
  }

  async setThereminInstrument(nameOrInst: string | object) {
    const inst = typeof nameOrInst === 'string' ? await this.builtinInstrument(nameOrInst) : nameOrInst;
    if (!inst) return;
    if (typeof nameOrInst === 'string') settings.s.thereminInstrument = nameOrInst;
    await this.backend?.call('set_theremin_instrument', JSON.stringify(inst));
  }

  private builtinCache: any[] | null = null;
  async builtinInstruments(): Promise<any[]> {
    if (!this.builtinCache) {
      const { builtin_instruments_json } = await import('../wasm/pkg/gsyn.js');
      await ensureWasm();
      this.builtinCache = JSON.parse(builtin_instruments_json());
    }
    return this.builtinCache!;
  }
  async builtinInstrument(name: string): Promise<any | null> {
    const all = await this.builtinInstruments();
    return all.find((i) => i.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  // ---- summaries / grid ---------------------------------------------------------

  private scheduleSummary() {
    clearTimeout(this.summaryTimer);
    this.summaryTimer = window.setTimeout(() => this.refreshSummary(), 120);
  }

  async refreshSummary() {
    if (!this.backend?.ready) return;
    try {
      const s = await this.backend.call<string>('tracks_json');
      this.trackSummary = typeof s === 'string' ? JSON.parse(s) : s;
      await this.refreshGrid();
    } catch (e) {
      console.warn('summary failed', e);
    }
  }

  async refreshGrid() {
    if (!this.backend?.ready) return;
    const g = await this.backend.call<string>('grid_json');
    this.grid = typeof g === 'string' ? JSON.parse(g) : g;
  }

  // ---- sessions -------------------------------------------------------------------

  async sessionJson(): Promise<string> {
    const j = await this.backend!.call<string>('to_session_json');
    const s = JSON.parse(j);
    s.name = this.sessionName;
    s.theme = settings.s.theme;
    s.calibration = settings.s.parser.calibration;
    s.voicing = settings.s.parser.voicing;
    return JSON.stringify(s, null, 2) + '\n';
  }

  async loadSessionJson(json: string) {
    const s = JSON.parse(json);
    await this.backend!.call('load_session_json', json);
    this.sessionName = s.name ?? 'Untitled session';
    if (s.theme) settings.s.theme = s.theme;
    if (s.calibration) settings.s.parser.calibration = { ...settings.s.parser.calibration, ...s.calibration };
    const keyIdx = Math.max(0, ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(s.key));
    this.parser?.setKey(keyIdx, s.mode === 'minor');
    this.syncLive();
    for (let t = 0; t < 4; t++) {
      const frames: LandmarkFrame[] = s.tracks?.[t]?.landmarks15hz ?? [];
      const bpm = s.transport?.bpm ?? 100;
      const [beats] = String(s.transport?.time_sig ?? '4/4').split('/').map(Number);
      const sr = this.backend!.sampleRate;
      const loopLen = Math.round((sr * 60) / bpm) * (beats || 4) * (s.transport?.bars ?? 4);
      this.ghosts[t].set(frames, loopLen);
    }
    this.dirty = false;
    await this.refreshSummary();
  }

  async loadSongIntoTrack(songJson: string, track: number) {
    await this.backend!.call('load_song_into_track', songJson, track);
    const song = JSON.parse(songJson);
    const keyIdx = Math.max(0, ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(song.key));
    this.parser?.setKey(keyIdx, song.mode === 'minor');
    this.syncLive();
    this.dirty = true;
    await this.refreshSummary();
  }

  spectrum(): { bass: number; treble: number; level: number } {
    return this.worklet?.spectrum() ?? { bass: 0, treble: 0, level: 0 };
  }
}

function keyName(i: number): string {
  return ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((i % 12) + 12) % 12];
}

export const rt = new Runtime();

// Dev hook: window.__gsyn exposes the runtime and a synthetic-hand feeder so the
// full pipeline (parser -> engine -> scene) can be exercised without a camera.
// `__gsyn.synth(leftMask, rightMask, leftTilt, rightTilt, rightY)`.
if (typeof window !== 'undefined') {
  (window as any).__gsyn = {
    rt,
    /** the wasm-bindgen module (render_midi, render_wav, parse_progression, ...) */
    wasm: () => import('../wasm/pkg/gsyn.js').then(async (m) => (await ensureWasm(), m)),
    async synth(leftMask = 0b00010, rightMask = 0b00010, leftTilt = 20, rightTilt = 0, rightY = 0.4, frames = 8) {
      const m = await import('../wasm/pkg/gsyn.js');
      await ensureWasm();
      const mk = (cx: number, cy: number, mask: number, tilt: number, right: boolean) => {
        const f = m.synth_hand_landmarks(cx, cy, 0.12, mask, tilt, right);
        const lm: { x: number; y: number; z: number }[] = [];
        for (let i = 0; i < 21; i++) lm.push({ x: f[i * 3], y: f[i * 3 + 1], z: f[i * 3 + 2] });
        // raw (non-mirrored) frame: tracker labels are swapped relative to the user
        return { landmarks: lm, left: right, confidence: 0.95 };
      };
      for (let i = 0; i < frames; i++) {
        const hands = [] as any[];
        if (leftMask >= 0) hands.push(mk(0.7, 0.5, leftMask, leftTilt, false));
        if (rightMask >= 0) hands.push(mk(0.3, rightY, rightMask, rightTilt, true));
        (rt as any).onFrame({ hands, tMs: performance.now(), inferenceMs: 0 });
        await new Promise((r) => setTimeout(r, 33));
      }
      return { state: $state.snapshot(rt.live), chord: rt.chordName };
    },
  };
}
