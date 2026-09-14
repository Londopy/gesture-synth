// Achievement store: persistent stats, unlock records, the unlock queue and
// the hooks that feed stats from the runtime. Everything user-visible goes
// through `track()` so the sources are easy to find.

import { CATEGORIES, emptyStats, MEDALS, TIER_INFO, medalById, type Medal, type Stats } from './defs';
import { rt } from '../state/engine.svelte';
import { settings } from '../state/settings.svelte';
import { ui } from '../state/ui.svelte';

const KEY = 'gsyn.achievements.v1';

export interface Unlock {
  id: string;
  at: number; // epoch ms
}

interface Persisted {
  stats: Stats;
  unlocked: Unlock[];
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { stats: { ...emptyStats(), ...(p.stats ?? {}) }, unlocked: Array.isArray(p.unlocked) ? p.unlocked : [] };
    }
  } catch {
    /* fresh */
  }
  return { stats: emptyStats(), unlocked: [] };
}

export type TrackEvent =
  | { kind: 'chord'; degree: number; quality: number; shape: number; octave: number; key: number }
  | { kind: 'bass' }
  | { kind: 'arp' }
  | { kind: 'latch' }
  | { kind: 'key_gesture' }
  | { kind: 'loop'; bpm: number; beats: number; unit: number; overdub: boolean; tracksFilled: number }
  | { kind: 'step_mute' }
  | { kind: 'chord_edit' }
  | { kind: 'tutorial'; score: number; perfectStreak: number }
  | { kind: 'song_built' }
  | { kind: 'theme'; name: string }
  | { kind: 'instrument'; name: string }
  | { kind: 'clear_view' }
  | { kind: 'video' }
  | { kind: 'export' }
  | { kind: 'publish' }
  | { kind: 'session_saved' }
  | { kind: 'tour_done' }
  | { kind: 'secret'; id: string }
  | { kind: 'demo_watched'; id: string };

class Achievements {
  stats = $state<Stats>(load().stats);
  unlocked = $state<Unlock[]>(load().unlocked);
  /** medals waiting to be shown, one at a time */
  queue = $state<Medal[]>([]);
  showing = $state<Medal | null>(null);
  private lastQuality = -1;
  private lastQualityAt = 0;
  private saveTimer = 0;
  private started = false;
  /** while a demo plays, nothing it produces counts as the user's own playing */
  private demoMuted = false;

  get unlockedIds(): Set<string> {
    return new Set(this.unlocked.map((u) => u.id));
  }

  get points(): number {
    return this.unlocked.reduce((n, u) => n + (TIER_INFO[medalById(u.id)?.tier ?? 'bronze'].points ?? 0), 0);
  }

  get maxPoints(): number {
    return MEDALS.reduce((n, m) => n + TIER_INFO[m.tier].points, 0);
  }

  isUnlocked(id: string): boolean {
    return this.unlocked.some((u) => u.id === id);
  }

  unlockedAt(id: string): number | null {
    return this.unlocked.find((u) => u.id === id)?.at ?? null;
  }

  /**
   * Mute every stat except demo_watched while the demo performer plays. Every
   * source funnels through track(), so this one switch covers the runtime
   * listener, the settings effects and the UI call sites alike.
   */
  setDemo(on: boolean) {
    this.demoMuted = on;
    if (!on) {
      // the demo's chords must not pair with the user's next one as a "quick change"
      this.lastQuality = -1;
      this.lastQualityAt = 0;
    }
  }

  /** Called once from App: wires runtime listeners and timers. */
  start() {
    if (this.started) return;
    this.started = true;
    rt.on((e) => {
      if (e.slot !== 4) return;
      if (e.type === 'chord_on') this.track({ kind: 'chord', degree: e.degree, quality: e.quality, shape: e.shape, octave: e.octave, key: rt.live.key });
      else if (e.type === 'bass') this.track({ kind: 'bass' });
      else if (e.type === 'arp' && e.on) this.track({ kind: 'arp' });
      else if (e.type === 'latch' && e.on) this.track({ kind: 'latch' });
    });
    // a key change caused by the two-fist gesture: the parser emits KeyChange without a keyboard/UI source
    let lastKey = rt.live.key;
    let uiKeyChangeAt = 0;
    window.addEventListener('keydown', (e) => {
      if (e.key === '[' || e.key === ']') uiKeyChangeAt = performance.now();
    });
    document.addEventListener('click', () => (uiKeyChangeAt = performance.now()), true);
    // recording lifecycle
    let lastRec = 0;
    let recTrackWasEmpty = true;
    let recBpm = 100;
    let recSig = [4, 4];
    $effect.root(() => {
      $effect(() => {
        const k = rt.live.key;
        if (k !== lastKey) {
          lastKey = k;
          if (performance.now() - uiKeyChangeAt > 400 && rt.left.present && rt.right.present) this.track({ kind: 'key_gesture' });
        }
      });
      $effect(() => {
        const p = rt.position;
        if (p.recording === 2 && lastRec !== 2) {
          const t = p.recTrack ?? p.selected;
          recTrackWasEmpty = rt.trackSummary[t]?.empty ?? true;
          recBpm = p.bpm;
          recSig = [p.beats, p.unit];
        } else if (p.recording !== 2 && lastRec === 2) {
          const filled = rt.trackSummary.filter((t) => !t.empty).length + (recTrackWasEmpty ? 1 : 0);
          this.track({ kind: 'loop', bpm: recBpm, beats: recSig[0], unit: recSig[1], overdub: !recTrackWasEmpty, tracksFilled: Math.min(4, filled) });
        }
        lastRec = p.recording;
      });
      $effect(() => {
        this.track({ kind: 'theme', name: settings.s.theme });
      });
      $effect(() => {
        this.track({ kind: 'instrument', name: settings.s.liveInstrument });
      });
      $effect(() => {
        if (settings.s.viewMode === 'clear') this.track({ kind: 'clear_view' });
      });
      $effect(() => {
        if (settings.s.tourDone) this.track({ kind: 'tour_done' });
      });
      $effect(() => {
        for (const id of settings.s.eggsFound) if (!this.stats.eggs.includes(id)) this.track({ kind: 'secret', id });
      });
    });
    // time: play seconds, theremin seconds, days, night sessions
    setInterval(() => {
      if (rt.phase !== 'ready' || document.visibilityState !== 'visible' || this.demoMuted) return;
      const s = this.stats;
      s.playSeconds++;
      if (rt.live.theremin && rt.live.thereminVol > 0.05) s.thereminSeconds++;
      const d = today();
      if (!s.days.includes(d)) s.days = [...s.days, d];
      const h = new Date().getHours();
      if (h < 4 && !this.nightCounted) {
        this.nightCounted = true;
        s.nightSessions++;
      }
      if (s.playSeconds % 15 === 0) this.evaluate();
    }, 1000);
    this.evaluate();
  }
  private nightCounted = false;

  track(e: TrackEvent) {
    if (this.demoMuted && e.kind !== 'demo_watched') return;
    const s = this.stats;
    const addDistinct = <T>(arr: T[], v: T) => (arr.includes(v) ? arr : [...arr, v]);
    switch (e.kind) {
      case 'chord': {
        s.chords++;
        s.chordsInOneSession++;
        s.bestChordsInOneSession = Math.max(s.bestChordsInOneSession, s.chordsInOneSession);
        if (e.shape >= 2) s.sevenths++;
        s.degrees = addDistinct(s.degrees, e.degree);
        s.shapes = addDistinct(s.shapes, e.shape);
        s.qualities = addDistinct(s.qualities, e.quality);
        s.octaves = addDistinct(s.octaves, e.octave);
        s.keys = addDistinct(s.keys, e.key);
        const now = performance.now();
        if (this.lastQuality >= 0 && this.lastQuality !== e.quality && now - this.lastQualityAt < 10000 && (e.quality === 0 || e.quality === 1) && (this.lastQuality === 0 || this.lastQuality === 1)) s.quickChanges++;
        this.lastQuality = e.quality;
        this.lastQualityAt = now;
        break;
      }
      case 'bass':
        s.bassHits++;
        break;
      case 'arp':
        s.arpToggles++;
        break;
      case 'latch':
        s.latches++;
        break;
      case 'key_gesture':
        s.keyGestures++;
        break;
      case 'loop':
        s.loops++;
        if (e.overdub) s.overdubs++;
        s.maxTracksFilled = Math.max(s.maxTracksFilled, e.tracksFilled);
        if (!(e.beats === 4 && e.unit === 4) && !(e.beats === 3 && e.unit === 4) && !(e.beats === 2 && e.unit === 4)) s.oddMeterLoops++;
        s.maxBpmRecorded = Math.max(s.maxBpmRecorded, e.bpm);
        s.minBpmRecorded = Math.min(s.minBpmRecorded, e.bpm);
        break;
      case 'step_mute':
        s.stepMutes++;
        break;
      case 'chord_edit':
        s.chordEdits++;
        break;
      case 'tutorial':
        s.tutorialsDone++;
        s.bestTutorialScore = Math.max(s.bestTutorialScore, e.score);
        s.bestPerfectStreak = Math.max(s.bestPerfectStreak, e.perfectStreak);
        break;
      case 'song_built':
        s.songsBuilt++;
        break;
      case 'theme':
        s.themesUsed = addDistinct(s.themesUsed, e.name);
        break;
      case 'instrument':
        s.instrumentsUsed = addDistinct(s.instrumentsUsed, e.name);
        break;
      case 'clear_view':
        s.clearViewUsed = true;
        break;
      case 'video':
        s.videosSaved++;
        break;
      case 'export':
        s.exports++;
        break;
      case 'publish':
        s.publishes++;
        break;
      case 'session_saved':
        s.sessionsSaved++;
        break;
      case 'tour_done':
        s.tourDone = true;
        break;
      case 'secret':
        s.eggs = addDistinct(s.eggs, e.id);
        s.secretsFound = s.eggs.length;
        break;
      case 'demo_watched':
        s.demosWatched = addDistinct(s.demosWatched, e.id);
        s.demoPlays++;
        break;
    }
    this.evaluate();
    this.save();
  }

  /** Check every locked medal against the stats; queue new unlocks. */
  evaluate() {
    const have = this.unlockedIds;
    const fresh: Medal[] = [];
    for (const m of MEDALS) {
      if (have.has(m.id) || m.id === 'completionist') continue;
      if (m.check(this.stats)) {
        this.unlocked = [...this.unlocked, { id: m.id, at: Date.now() }];
        have.add(m.id);
        fresh.push(m);
      }
    }
    if (!have.has('completionist') && MEDALS.every((m) => m.id === 'completionist' || have.has(m.id))) {
      const m = medalById('completionist')!;
      this.unlocked = [...this.unlocked, { id: m.id, at: Date.now() }];
      fresh.push(m);
    }
    if (fresh.length) {
      this.queue = [...this.queue, ...fresh];
      this.pump();
      this.save();
    }
  }

  private pump() {
    if (this.showing || this.queue.length === 0) return;
    const [next, ...rest] = this.queue;
    this.queue = rest;
    this.showing = next;
    chime(next);
    setTimeout(() => {
      this.showing = null;
      this.pump();
    }, 5200);
  }

  dismiss() {
    this.showing = null;
    this.pump();
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify({ stats: $state.snapshot(this.stats), unlocked: $state.snapshot(this.unlocked) }));
      } catch {
        /* storage unavailable */
      }
    }, 300);
  }

  reset() {
    this.stats = emptyStats();
    this.unlocked = [];
    this.queue = [];
    this.showing = null;
    this.save();
  }

  byCategory(cat: (typeof CATEGORIES)[number]): Medal[] {
    return MEDALS.filter((m) => m.category === cat);
  }
}

/** osu!-style unlock chime: three rising notes through the engine's context. */
function chime(m: Medal) {
  try {
    const ctx: AudioContext = rt.worklet?.ctx ?? new AudioContext();
    const t0 = ctx.currentTime + 0.02;
    const notes = m.tier === 'platinum' ? [523.25, 659.25, 783.99, 1046.5] : m.tier === 'gold' ? [523.25, 659.25, 783.99] : [659.25, 987.77];
    const master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const t = t0 + i * 0.11;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + 0.75);
    });
  } catch {
    /* no audio */
  }
}

export const achievements = new Achievements();
