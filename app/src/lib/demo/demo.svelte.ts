// Demo mode: a synthetic performer plays a song through the real gesture parser,
// so the hands, HUD, particles and audio are exactly what a player would get.
// The transport is the clock (position ticks from the worklet, ~62.5 Hz, also in
// hidden tabs); everything the demo changes on the runtime is snapshotted and
// restored when it ends.

import { achievements } from '../achievements/store.svelte';
import { KEY_INDEX, leftFingersFor, QUALITY_INDEX, rightFingersFor, SHAPE_INDEX, songById, tiltFor, type Song } from '../learn/songs';
import { router } from '../router/router.svelte';
import type { LearnTarget } from '../scene/types';
import { rt } from '../state/engine.svelte';
import { settings } from '../state/settings.svelte';
import { ui } from '../state/ui.svelte';
import type { TrackingFrame } from '../tracking/mediapipe';
import { ensureWasm, type ParserConfig } from '../tracking/parser';
import { bits, compile, exprAt, LATCH_HOLD_MS, leadBeats, type Cue, type Timeline } from './choreo';
import { Performer, type SynthFn } from './performer';
import { beatsPerBar, chordOnset, cutoffToTilt, DEMO_PASSES, DEMO_SONGS, demoById, validateDemoSong, volToY, type DemoChord, type DemoSong } from './songs';

export type DemoMode = 'cycle' | 'loop' | 'once';
export type DemoStopReason = 'esc' | 'key' | 'button' | 'hands' | 'transport' | 'route' | 'phase' | 'config' | 'tour' | 'end' | 'error';
export type DemoPhase = 'idle' | 'enter' | 'preroll' | 'playing' | 'outro' | 'between';

interface Snapshot {
  bpm: number;
  beats: number;
  unit: number;
  bars: number;
  key: number;
  minor: boolean;
  quantize: string;
  quantizeInput: string;
  mutes: boolean[];
  mutedTracks: number[];
  liveInstrument: string;
  parserConfig: ParserConfig;
  parserJson: string;
  dirty: boolean;
}

interface Sched {
  /** absolute due position in beats (pass * total + beat - lead) */
  due: number;
  cue: Cue;
  pass: number;
  /** anticipation press for a pose, not the pose itself */
  pre?: boolean;
}

/** Feed a frame at most this often (the worklet ticks every ~16 ms; cameras run ~30 fps). */
const FRAME_MIN_MS = 30;
/** Fallback timer period and the tick silence after which it takes over. */
const FALLBACK_MS = 40;
const TICK_STALE_MS = 100;
/** Frames of the pinch window (> 150 ms at any frame period we feed). */
const PINCH_FRAMES = 8;
/** Real-hand frames (out of the last 15) that hand the stage back to the user. */
const TAKEOVER_FRAMES = 8;
const TAKEOVER_WINDOW = 15;
const BETWEEN_MS = 1200;
const OUTRO_MS = 800;
/** Longest wait for the parser to commit chord 1 before the transport starts anyway. */
const PREROLL_MAX_MS = 1500;
/** Frame-period samples outside this band are dropped from the EMA (a stalled tab, a forced cue frame). */
const F_MIN_MS = 20;
const F_MAX_MS = 60;

class DemoStore {
  active = $state(false);
  songId = $state<string | null>(null);
  songIndex = $state(0);
  mode = $state<DemoMode>('cycle');
  phase = $state<DemoPhase>('idle');
  bar = $state(1);
  progress = $state(0);
  pass = $state(0);
  caption = $state('');
  lastReason = $state<DemoStopReason | ''>('');
  /** tests: no automatic ticks; drive with step() */
  manual = false;

  private song: Song | DemoSong | null = null;
  private tl: Timeline | null = null;
  private perf: Performer | null = null;
  private synth: SynthFn | null = null;
  private snap: Snapshot | null = null;
  private demoCfg: ParserConfig | null = null;
  private unsubTick: (() => void) | null = null;
  private fallback = 0;
  private effectRoot: (() => void) | null = null;
  private startSeq = 0;
  private starting = false;
  private returnTo: 'learn' | undefined;

  // clock: F is the measured period between fed frames (~32 ms), not the ~16 ms
  // position tick; the lead math counts frames because the parser debounce does
  private F = 32;
  private forceFrame = false;
  private prerollAt = -1;
  private tickBeat = 0;
  private tickState = 0;
  private tickArrivalMs = -1;
  private lastFrameMs = -1;
  private sawPlaying = false;

  // schedule
  private queue: Sched[] = [];
  private qi = 0;
  private passesQueued = 0;
  private passIdx = 0;
  private lastBeatPos = 0;
  private prerolled = false;
  private startedTransport = false;
  private issuedStop = false;
  private enterFrames = 0;
  private pinchLeft = 0;
  private pinchThumb: -1 | 0 | 1 | 2 = 0;
  private lastArp = false;
  private frozenVol = 0.6;
  private holdVol = false;
  private curVol = 0.6;
  private latching = false;
  private phaseUntil = 0;
  private watched = false;

  // takeover watch
  private handHits: boolean[] = [];

  // target() buffers
  private tgt: LearnTarget = { left: new Float32Array(63), right: new Float32Array(63), matchLeft: false, matchRight: false, countdown: 0 };

  /** Start a demo. `idOrSong`: a demo id, any song id, a Song object, or nothing for the first demo. */
  async start(idOrSong?: string | Song, opts: { mode?: DemoMode; returnTo?: 'learn' } = {}): Promise<void> {
    if (this.active || this.starting) this.stop('button');
    const seq = ++this.startSeq;
    this.starting = true;
    this.lastReason = '';
    try {
      const song = this.resolve(idOrSong);
      if (!song) return;
      if (rt.phase !== 'ready' || !rt.backend) return;
      const errs = validateDemoSong(song);
      if (errs.length) {
        ui.toast(`This song cannot be demoed: ${errs[0]}`, 'warn', 4000);
        return;
      }
      const hasLoops = rt.trackSummary.some((t) => !t.empty);
      if (hasLoops || rt.position.state !== 0) {
        const ok = await ui.ask('Watch a demo', 'The demo stops the transport, mutes your loops and changes tempo, key and bars while it plays. Everything is restored when it ends.', 'Watch');
        if (seq !== this.startSeq) return;
        if (!ok) return;
      }
      if (!this.synth) {
        const m = await import('../wasm/pkg/gsyn.js');
        await ensureWasm();
        if (seq !== this.startSeq) return;
        this.synth = m.synth_hand_landmarks_ex as SynthFn;
      }
      if (rt.phase !== 'ready') return;

      // demoMode is the picker's persisted default (settings own the field)
      const saved = (settings.s as { demoMode?: DemoMode }).demoMode;
      this.mode = opts.mode ?? saved ?? 'cycle';
      this.returnTo = opts.returnTo;
      this.snapshot();
      if (rt.position.state !== 0) rt.stop();
      // shared setup: grid-exact lead math needs a sixteenth grid and always-on quantize
      rt.cmd({ cmd: 'set_quantize', quantize: 'sixteenth' });
      rt.cmd({ cmd: 'set_quantize_input', mode: 'always' });
      for (const t of this.snap!.mutedTracks) rt.cmd({ cmd: 'set_mute', track: t, on: true });
      const cfg = settings.s.parser;
      this.demoCfg = {
        ...$state.snapshot(cfg),
        mode: 'gesture',
        left: { kind: 'full' },
        right: { kind: 'full' },
        calibration: { ...$state.snapshot(cfg.calibration), top_y: 0.15, bottom_y: 0.85, mirror_frame: false, swap_hands: false, invert_tilt: false },
        stable_ms: Math.max(60, Math.min(200, cfg.stable_ms)),
        // latching is enabled only for latch cues
        latch_hold_ms: 1e9,
      };
      rt.setParserConfigTransient(this.demoCfg);
      this.handHits = [];
      rt.cameraGate = (f) => this.gate(f);
      achievements.setDemo(true);
      this.active = true;
      this.perf = new Performer(this.synth);
      this.installEffects();
      await this.applySong(song);
      if (!this.manual) {
        this.unsubTick = rt.onPositionTick(() => this.onTick());
        this.fallback = window.setInterval(() => {
          const now = performance.now();
          if (now - this.tickArrivalMs > TICK_STALE_MS) this.step(now);
        }, FALLBACK_MS);
      }
    } catch (e) {
      console.error('[demo]', e);
      this.stop('error');
    } finally {
      if (seq === this.startSeq) this.starting = false;
    }
  }

  /** Idempotent teardown; restores everything the demo changed (order matters: see the demo plan, section 5). */
  stop(reason: DemoStopReason): void {
    if (!this.active && !this.starting) return;
    this.startSeq++;
    this.starting = false;
    this.lastReason = reason;
    this.unsubTick?.();
    this.unsubTick = null;
    clearInterval(this.fallback);
    this.fallback = 0;
    if (this.active) rt.clearLiveHands();
    if (this.startedTransport && rt.position.state !== 0) rt.stop();
    rt.cameraGate = null;
    const s = this.snap;
    if (s) {
      for (const t of s.mutedTracks) rt.cmd({ cmd: 'set_mute', track: t, on: s.mutes[t] });
      rt.cmd({ cmd: 'set_quantize', quantize: s.quantize });
      rt.cmd({ cmd: 'set_quantize_input', mode: s.quantizeInput });
      rt.setTimeSig(s.beats, s.unit);
      rt.setBars(s.bars);
      rt.setBpm(s.bpm);
      rt.setKey(s.key, s.minor);
      void rt.setLiveInstrument(s.liveInstrument);
      // the user's current config; identical to the snapshot unless they changed it mid-demo
      rt.setParserConfigTransient($state.snapshot(settings.s.parser));
    }
    this.effectRoot?.();
    this.effectRoot = null;
    this.active = false;
    this.phase = 'idle';
    this.caption = '';
    this.progress = 0;
    this.queue = [];
    this.qi = 0;
    this.perf = null;
    this.tl = null;
    this.song = null;
    this.latching = false;
    this.startedTransport = false;
    if (s) rt.dirty = s.dirty;
    this.snap = null;
    // last, so the restore's key/instrument effects are still muted
    achievements.setDemo(false);
    if (this.returnTo === 'learn') router.go('learn');
    this.returnTo = undefined;
  }

  /** Switch to the next built-in demo (snapshot kept). */
  next(): void {
    this.switchBy(1);
  }

  /** Switch to the previous built-in demo (snapshot kept). */
  prev(): void {
    this.switchBy(-1);
  }

  /** One driver tick (tests call this directly with `manual = true`). */
  step(nowMs = performance.now()): void {
    if (!this.active || !this.perf || !this.tl || !this.song) return;
    // without fresh ticks the transport position is frozen too (a suspended context), so nothing is extrapolated
    const stale = this.manual || this.tickArrivalMs < 0 || nowMs - this.tickArrivalMs > TICK_STALE_MS;
    if (stale) this.readPosition();
    const total = this.tl.total;
    const bpm = this.song.bpm;
    const extrap = !stale && this.tickState === 2 ? ((nowMs - this.tickArrivalMs) * bpm) / 60000 : 0;
    const beatPos = this.tickState === 2 ? this.tickBeat + extrap : this.tickBeat;
    const wantFrame = this.lastFrameMs < 0 || nowMs - this.lastFrameMs >= FRAME_MIN_MS;
    const feedNow = () => {
      if (wantFrame || this.forceFrame) this.feed(nowMs, !wantFrame);
    };

    switch (this.phase) {
      case 'enter': {
        this.expressAt(0);
        if (wantFrame) {
          this.feed(nowMs);
          this.enterFrames++;
        }
        const [, ly] = this.perf.leftWrist;
        if (this.enterFrames >= 12 && (Math.abs(ly - this.perf.left.y) < 0.02 || this.enterFrames >= 45)) {
          this.phase = 'preroll';
          this.prerollAt = nowMs;
          const first = this.tl.chords[0];
          if (first && chordOnset(first, this.tl.beats) === 0) {
            this.applyPose(this.poseCueOf(0));
            this.prerolled = true;
          } else {
            this.beginPlaying();
          }
        }
        break;
      }
      case 'preroll': {
        this.expressAt(0);
        if (wantFrame) {
          this.feed(nowMs);
          const c = this.tl.chords[0];
          const l = rt.live;
          // the octave lags the chord by its own debounce; a stalled commit must not hold the song hostage
          if ((c && l.degree === c.degree && l.shape === SHAPE_INDEX[c.shape] && l.octave === c.octave) || nowMs - this.prerollAt > PREROLL_MAX_MS) this.beginPlaying();
        }
        break;
      }
      case 'playing': {
        if (this.tickState === 2) this.sawPlaying = true;
        if (this.sawPlaying && this.tickState === 0 && !this.issuedStop) {
          this.stop('transport');
          return;
        }
        if (!this.sawPlaying) {
          // play() not yet processed by the engine: keep the pre-roll pose alive
          feedNow();
          break;
        }
        if (beatPos < this.lastBeatPos - total / 2) this.passIdx++;
        this.lastBeatPos = beatPos;
        this.pass = this.passIdx;
        const finite = this.mode !== 'loop';
        if (this.passIdx >= 1 && !this.watched) {
          this.watched = true;
          if (!finite) this.trackWatched();
        }
        if (finite && this.passIdx >= DEMO_PASSES) {
          this.finishSong(nowMs);
          break;
        }
        const A = this.passIdx * total + beatPos;
        this.ensureQueue();
        while (this.qi < this.queue.length && A >= this.queue[this.qi].due) this.fire(this.queue[this.qi++]);
        this.expressAt(beatPos);
        feedNow();
        this.bar = Math.min(this.song.bars, Math.floor(beatPos / this.tl.beats) + 1);
        this.progress = Math.max(0, Math.min(1, beatPos / total));
        break;
      }
      case 'outro': {
        feedNow();
        if (nowMs >= this.phaseUntil) {
          this.phase = 'between';
          this.phaseUntil = nowMs + BETWEEN_MS;
        }
        break;
      }
      case 'between': {
        if (nowMs >= this.phaseUntil) {
          if (this.mode === 'once') this.stop('end');
          else this.switchBy(1);
        }
        break;
      }
    }
  }

  /** Outline of the next chord for the scene (reused object). */
  target(): LearnTarget | null {
    if (!this.active || !this.tl || !this.perf || !this.synth || this.tl.chords.length === 0) return null;
    if (this.phase !== 'playing' && this.phase !== 'preroll' && this.phase !== 'enter') return null;
    const beatPos = this.phase === 'playing' ? this.lastBeatPos : -1;
    let idx = this.tl.chords.findIndex((c) => chordOnset(c, this.tl!.beats) > beatPos);
    if (idx < 0) idx = 0;
    const c = this.tl.chords[idx];
    let until = chordOnset(c, this.tl.beats) - beatPos;
    if (until < 0) until += this.tl.total;
    const lmask = bits(leftFingersFor(c.degree));
    const rmask = bits(rightFingersFor(SHAPE_INDEX[c.shape], 0)) & ~1;
    const [lx, ly] = this.perf.leftWrist;
    const [rx, ry] = this.perf.rightWrist;
    const palm = this.perf.palm * 1.05;
    const lthumb = lmask & 1 ? 1 : 2;
    this.tgt.left!.set(this.synth(lx, ly - 0.02, palm, lmask & ~1, tiltFor(QUALITY_INDEX[c.quality]), false, lthumb, false));
    this.tgt.right!.set(this.synth(rx, ry - 0.02, palm, rmask, 0, true, Math.max(-1, Math.min(1, c.octave)) as -1 | 0 | 1, false));
    this.tgt.matchLeft = rt.live.degree === c.degree && rt.live.quality === QUALITY_INDEX[c.quality];
    this.tgt.matchRight = rt.live.shape === SHAPE_INDEX[c.shape];
    this.tgt.countdown = Math.max(0, Math.min(1, 1 - until / 2));
    return this.tgt;
  }

  // ---- internals ----------------------------------------------------------------

  private resolve(idOrSong?: string | Song): Song | DemoSong | null {
    if (!idOrSong) return DEMO_SONGS[0];
    if (typeof idOrSong === 'string') return demoById(idOrSong) ?? songById(idOrSong) ?? null;
    return idOrSong;
  }

  private snapshot(): void {
    const p = rt.position;
    const summary = rt.trackSummary;
    const mutes = [0, 1, 2, 3].map((i) => summary[i]?.mute ?? false);
    const mutedTracks = [0, 1, 2, 3].filter((i) => summary[i] && !summary[i].empty);
    this.snap = {
      bpm: p.bpm,
      beats: p.beats,
      unit: p.unit,
      bars: p.bars,
      key: rt.live.key,
      minor: rt.live.minor,
      quantize: settings.s.quantize,
      quantizeInput: settings.s.quantizeInput,
      mutes,
      mutedTracks,
      liveInstrument: settings.s.liveInstrument,
      parserConfig: settings.s.parser,
      parserJson: JSON.stringify($state.snapshot(settings.s.parser)),
      dirty: rt.dirty,
    };
  }

  private installEffects(): void {
    const parserJson = this.snap?.parserJson ?? '';
    this.effectRoot = $effect.root(() => {
      $effect(() => {
        if (router.route.page !== 'play') this.stop('route');
      });
      $effect(() => {
        if (rt.phase !== 'ready') this.stop('phase');
      });
      $effect(() => {
        if (ui.tour) this.stop('tour');
      });
      $effect(() => {
        // Tab or Settings > Gestures replaced the parser config underneath the demo
        if (JSON.stringify(settings.s.parser) !== parserJson) this.stop('config');
      });
    });
  }

  /** Apply one song's transport, key and instrument and start its entrance. */
  private async applySong(song: Song | DemoSong): Promise<void> {
    this.song = song;
    this.songId = song.id ?? null;
    const idx = DEMO_SONGS.findIndex((d) => d.id === song.id);
    this.songIndex = idx;
    const beats = beatsPerBar(song);
    const unit = Number(song.time_sig.split('/')[1]) || 4;
    rt.setTimeSig(beats, unit);
    rt.setBars(song.bars);
    rt.setBpm(song.bpm);
    rt.setKey(KEY_INDEX[song.key] ?? 0, song.mode === 'minor');
    const inst = song.instrument ? await rt.builtinInstrument(song.instrument) : null;
    if (!this.active || !this.perf) return;
    // the instrument object leaves settings.s.liveInstrument alone
    if (inst) void rt.setLiveInstrument(inst);
    if (this.latching && this.demoCfg) {
      rt.setParserConfigTransient(this.demoCfg);
      this.latching = false;
    }
    this.tl = compile(song, { stableMs: this.demoCfg?.stable_ms, frameMs: this.F });
    this.queue = [];
    this.qi = 0;
    this.passesQueued = 0;
    this.passIdx = 0;
    this.pass = 0;
    this.bar = 1;
    this.progress = 0;
    this.lastBeatPos = 0;
    this.prerolled = false;
    this.startedTransport = false;
    this.issuedStop = false;
    this.sawPlaying = false;
    this.enterFrames = 0;
    this.forceFrame = false;
    this.pinchLeft = 0;
    this.holdVol = false;
    this.lastArp = false;
    this.watched = false;
    this.caption = this.tl.chords[0]?.perf?.say ?? '';
    const p = this.perf;
    p.freeze = false;
    p.left.mask = 0;
    p.left.tilt = 25;
    p.right.mask = 0;
    p.right.thumb = 0;
    p.right.pinch = false;
    p.enter();
    this.phase = 'enter';
  }

  private switchBy(delta: number): void {
    if (!this.active || !this.perf) return;
    const n = DEMO_SONGS.length;
    const idx = this.songIndex < 0 ? (delta > 0 ? 0 : n - 1) : (((this.songIndex + delta) % n) + n) % n;
    this.issuedStop = true;
    if (rt.position.state !== 0) rt.stop();
    rt.clearLiveHands();
    this.perf.exit();
    this.phase = 'between';
    // applySong flips the phase once the instrument has loaded; nothing fires meanwhile
    this.phaseUntil = Number.POSITIVE_INFINITY;
    void this.applySong(DEMO_SONGS[idx]);
  }

  private beginPlaying(): void {
    this.issuedStop = false;
    this.sawPlaying = false;
    rt.play();
    this.startedTransport = true;
    this.passIdx = 0;
    this.lastBeatPos = 0;
    this.phase = 'playing';
  }

  private finishSong(nowMs: number): void {
    this.issuedStop = true;
    rt.stop();
    rt.clearLiveHands();
    this.perf?.exit();
    this.trackWatched();
    this.phase = 'outro';
    this.phaseUntil = nowMs + OUTRO_MS;
    this.progress = 1;
  }

  private trackWatched(): void {
    const id = this.song?.id;
    if (id) achievements.track({ kind: 'demo_watched', id });
  }

  private readPosition(): void {
    const p = rt.position;
    this.tickBeat = (p.bar - 1) * p.beats + (p.beat - 1) + p.phase;
    this.tickState = p.state;
  }

  private onTick(): void {
    const now = performance.now();
    this.readPosition();
    this.tickArrivalMs = now;
    this.step(now);
  }

  private stableMs(): number {
    return this.demoCfg?.stable_ms ?? 90;
  }

  private lead(kind: Cue['kind']): number {
    return leadBeats(kind, { stableMs: this.stableMs(), frameMs: this.F, bpm: this.song?.bpm ?? 100 });
  }

  /** Keep two passes of cues ahead of the current one so cues due just before a wrap are already queued. */
  private ensureQueue(): void {
    if (!this.tl) return;
    const finite = this.mode !== 'loop';
    while (this.passesQueued < this.passIdx + 2 && (!finite || this.passesQueued < DEMO_PASSES)) {
      this.appendPass(this.passesQueued++);
    }
    // drop what has been fired so the queue never grows in loop mode
    if (this.qi > 64) {
      this.queue = this.queue.slice(this.qi);
      this.qi = 0;
    }
  }

  private appendPass(k: number): void {
    const tl = this.tl!;
    const total = tl.total;
    const pressBeats = (3 * this.F * (this.song?.bpm ?? 100)) / 60000;
    const items: Sched[] = [];
    for (const cue of tl.cues) {
      if (k === 0 && this.prerolled && cue.kind === 'pose' && cue.beat === 0) continue;
      const due = k * total + cue.beat - this.lead(cue.kind);
      if (cue.kind === 'pose') items.push({ due: due - pressBeats, cue, pass: k, pre: true });
      items.push({ due, cue, pass: k });
    }
    if (this.mode !== 'loop' && k === DEMO_PASSES - 1) {
      // release just before the final wrap: the stop lands on the wrap tick, and a fist that commits
      // after it would be swallowed silently by the teardown instead of closing the hands on screen
      const early = (1.5 * this.F * (this.song?.bpm ?? 100)) / 60000;
      items.push({ due: (k + 1) * total - this.lead('rest') - early, cue: { kind: 'rest', beat: total }, pass: k });
    }
    const pending = this.queue.slice(this.qi).concat(items).sort((a, b) => a.due - b.due);
    this.queue = pending;
    this.qi = 0;
  }

  private poseCueOf(chordIdx: number): Cue & { kind: 'pose' } {
    const c = this.tl!.cues.find((q) => q.kind === 'pose' && q.chordIdx === chordIdx) as (Cue & { kind: 'pose' }) | undefined;
    if (c) return c;
    const ch = this.tl!.chords[chordIdx];
    return {
      kind: 'pose',
      beat: chordOnset(ch, this.tl!.beats),
      chordIdx,
      left: { mask: bits(leftFingersFor(ch.degree)), tilt: tiltFor(QUALITY_INDEX[ch.quality]) },
      right: { mask: bits(rightFingersFor(SHAPE_INDEX[ch.shape], 0)) & ~1, thumb: Math.max(-1, Math.min(1, ch.octave)) as -1 | 0 | 1 },
    };
  }

  private applyPose(cue: Cue & { kind: 'pose' }): void {
    const p = this.perf!;
    const chord: DemoChord | undefined = this.tl?.chords[cue.chordIdx];
    p.freeze = false;
    p.left.mask = cue.left.mask;
    p.left.tilt = cue.left.tilt;
    p.right.mask = cue.right.mask;
    if (this.pinchLeft > 0) this.pinchThumb = cue.right.thumb;
    else p.right.thumb = cue.right.thumb;
    // latching is switched on by the freeze cue, after this pose has committed: the parser's
    // still-timer dates from the previous chord, so enabling it here would latch at once
    if (this.demoCfg && this.latching) {
      rt.setParserConfigTransient(this.demoCfg);
      this.latching = false;
    }
    // height must match the frozen volume before the arp is switched off, or the volume jumps
    if (chord?.perf?.arp === 'off') this.holdVol = true;
  }

  private fire(s: Sched): void {
    const p = this.perf!;
    if (s.pre) {
      p.press();
      return;
    }
    const c = s.cue;
    // a discrete change fed on the tick it is due removes the tick-vs-frame jitter from the onset
    if (c.kind === 'pose' || c.kind === 'rest' || c.kind === 'bass' || c.kind === 'pinch') this.forceFrame = true;
    switch (c.kind) {
      case 'pose':
        this.applyPose(c);
        break;
      case 'rest':
        p.left.mask = 0;
        break;
      case 'bass':
        p.flick();
        break;
      case 'pinch':
        this.pinchLeft = PINCH_FRAMES;
        this.pinchThumb = p.right.thumb;
        p.right.thumb = 2;
        p.right.pinch = true;
        break;
      case 'freeze':
        p.freeze = true;
        if (this.demoCfg && !this.latching) {
          rt.setParserConfigTransient({ ...this.demoCfg, latch_hold_ms: LATCH_HOLD_MS });
          this.latching = true;
        }
        break;
      case 'exit':
        p.exit();
        break;
      case 'enter':
        // back with the latched pose: no discrete change until the next pose cue lands on the beat
        p.freeze = false;
        p.appear();
        break;
    }
  }

  private expressAt(beat: number): void {
    if (!this.tl || !this.perf || this.perf.freeze) return;
    const e = exprAt(this.tl, beat);
    this.curVol = e.vol;
    this.perf.right.y = volToY(this.holdVol ? this.frozenVol : e.vol);
    this.perf.right.tilt = cutoffToTilt(e.cutoff);
    if (e.say !== this.caption) this.caption = e.say;
  }

  private feed(nowMs: number, forced = false): void {
    const p = this.perf!;
    rt.feedFrame(p.frame(nowMs));
    if (!forced && this.lastFrameMs >= 0) {
      const dt = nowMs - this.lastFrameMs;
      if (dt >= F_MIN_MS && dt <= F_MAX_MS) this.F += (dt - this.F) * 0.05;
    }
    this.lastFrameMs = nowMs;
    this.forceFrame = false;
    if (this.pinchLeft > 0) {
      this.pinchLeft--;
      if (this.pinchLeft === 0) {
        p.right.pinch = false;
        p.right.thumb = this.pinchThumb;
      }
    }
    const arp = rt.live.arp;
    if (arp !== this.lastArp) {
      this.lastArp = arp;
      if (arp) this.frozenVol = this.curVol;
      else this.holdVol = false;
    }
  }

  /** Camera frames while the demo runs: swallowed, but real hands hand the stage back. */
  private gate(f: TrackingFrame): boolean {
    const hit = f.hands.some((h) => h.confidence >= 0.7);
    this.handHits.push(hit);
    if (this.handHits.length > TAKEOVER_WINDOW) this.handHits.shift();
    const n = this.handHits.reduce((a, b) => a + (b ? 1 : 0), 0);
    if (n >= TAKEOVER_FRAMES) {
      this.stop('hands');
      ui.toast('Your hands are on camera. Over to you.', 'ok', 2500);
      return false;
    }
    return true;
  }
}

export const demo = new DemoStore();
