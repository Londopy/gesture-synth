<script lang="ts">
  // Playing a set: one pass through a song for a Take rating. The engine and
  // parser run exactly as in free play; this screen only sets the transport
  // up, judges each chord change against the song's targets with signed
  // timing, draws the game HUD (Groove, Run, score, judgment words at the hand
  // that played) and hands the finished score to the Results screen.
  import { onDestroy, onMount } from 'svelte';
  import { achievements } from '../achievements/store.svelte';
  import { demo } from '../demo/demo.svelte';
  import { DEMO_SONGS } from '../demo/songs';
  import { leftFingersFor, rightFingersFor, songById, songTargets, tiltFor, type Song, type TutorialTarget } from '../learn/songs';
  import { learnState } from '../../routes/learn-state.svelte';
  import { KEY_INDEX_FROM_NAME } from '../../routes/learn-util';
  import { ROMAN } from '../music';
  import type { LearnTarget } from '../scene/types';
  import { rt } from '../state/engine.svelte';
  import { settings } from '../state/settings.svelte';
  import { store } from '../storage/store';
  import { ensureWasm } from '../tracking/parser';
  import { records } from './records.svelte';
  import { accuracy, applyHit, inTheGroove, JUDGMENT_INFO, judgeHit, newSetScore, rating, RATING_ORDER, VARIATIONS, WINDOWS, type Judgment, type SetScore } from './score';
  import { sfx } from './sfx';
  import { stage } from './stage.svelte';

  let song = $state<Song | null>(null);
  let targets = $state<TutorialTarget[]>([]);
  let phase = $state<'loading' | 'camera' | 'ready' | 'countin' | 'playing' | 'paused' | 'done'>('loading');
  let error = $state('');
  let score = $state<SetScore>(newSetScore(0));
  let count = $state(0); // count-in beats remaining
  let judged = new Set<number>();
  let lastLive = { degree: -1, quality: -1, shape: -1 };
  let popups = $state<{ id: number; text: string; x: number; y: number; kind: Judgment; arrow: '' | '←' | '→' }[]>([]);
  let popupId = 0;
  const vars = stage.variations;
  const strict = vars.includes('strict');
  const blind = vars.includes('blind');
  const tempo = vars.includes('halftime') ? 0.75 : vars.includes('doubletime') ? 1.25 : 1;

  // Transport snapshot so a set leaves the user's session exactly as it was.
  let snap: { bpm: number; beats: number; unit: number; bars: number; key: number; minor: boolean; parser: typeof settings.s.parser; dirty: boolean } | null = null;

  const total = $derived(song ? song.bars * (Number(song.time_sig.split('/')[0]) || 4) : 0);
  const bpm = $derived(song ? song.bpm * tempo : 100);
  const msPerBeat = $derived(60000 / bpm);
  const beatPos = $derived.by(() => {
    const p = rt.position;
    return (p.bar - 1) * p.beats + (p.beat - 1) + p.phase;
  });
  const progress = $derived(total ? Math.min(1, beatPos / total) : 0);
  const nextTarget = $derived.by(() => targets.find((t) => !judged.has(t.index) && t.startBeat + WINDOWS.late / msPerBeat >= beatPos) ?? null);
  const grooving = $derived(inTheGroove(score));

  async function loadSong(id: string): Promise<Song | undefined> {
    const built = songById(id) ?? (DEMO_SONGS as Song[]).find((s) => s.id === id);
    if (built) return built;
    for (const f of await store.list('song')) {
      try {
        const s = JSON.parse(await store.read(f.name, 'song')) as Song;
        if ((s.id ?? f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')) === id) return { ...s, id };
      } catch {
        /* skip */
      }
    }
    return undefined;
  }

  onMount(async () => {
    const id = stage.selectedSet;
    const s = id ? await loadSong(id) : undefined;
    if (!s) {
      error = 'That song is not available.';
      return;
    }
    song = s;
    targets = songTargets(s);
    score = newSetScore(targets.length);
    if (rt.phase !== 'ready') await rt.start({ camera: false });
    if (rt.phase !== 'ready') {
      error = 'The sound engine could not start.';
      return;
    }
    phase = 'camera';
    if (rt.trackingStatus === 'idle' && !rt.cameraFailed) {
      try {
        await rt.startCamera();
      } catch {
        /* status below says why */
      }
    }
    // window.__gsyn.rt.cameraGate lets the camera-less checks feed hands themselves
    if ((rt.cameraFailed || rt.trackingStatus === 'error' || rt.trackingStatus === 'denied') && !rt.cameraGate) {
      error = rt.trackingStatus === 'denied' ? 'A set needs the camera. Allow it in the browser, or watch the demo instead.' : 'A set needs the camera and it could not start. Check Settings › Camera, or watch the demo instead.';
      return;
    }
    const p = rt.position;
    snap = { bpm: p.bpm, beats: p.beats, unit: p.unit, bars: p.bars, key: rt.live.key, minor: rt.live.minor, parser: settings.s.parser, dirty: rt.dirty };
    rt.stop();
    const [b, u] = s.time_sig.split('/').map(Number);
    rt.setTimeSig(b || 4, u || 4);
    rt.setBars(s.bars);
    rt.setBpm(s.bpm * tempo);
    rt.setKey(KEY_INDEX_FROM_NAME(s.key), s.mode === 'minor');
    if (vars.includes('mirror')) {
      const cal = settings.s.parser.calibration;
      rt.setParserConfigTransient({ ...settings.s.parser, calibration: { ...cal, swap_hands: !cal.swap_hands } });
    }
    learnState.provider = provideTarget;
    await ensureWasm();
    const m = await import('../wasm/pkg/gsyn.js');
    synthLm = m.synth_hand_landmarks;
    phase = 'ready';
  });

  function restore() {
    learnState.provider = null;
    if (!snap) return;
    rt.stop();
    rt.setTimeSig(snap.beats, snap.unit);
    rt.setBars(snap.bars);
    rt.setBpm(snap.bpm);
    rt.setKey(snap.key, snap.minor);
    rt.setParserConfigTransient(snap.parser);
    rt.dirty = snap.dirty;
    snap = null;
  }
  onDestroy(restore);

  // ---- count-in and start ----------------------------------------------------
  let countTimer: ReturnType<typeof setInterval> | undefined;
  function begin() {
    if (!song || phase !== 'ready') return;
    sfx.click();
    phase = 'countin';
    const beats = Number(song.time_sig.split('/')[0]) || 4;
    count = beats;
    sfx.tick();
    countTimer = setInterval(() => {
      count--;
      if (count > 0) sfx.tick();
      else {
        clearInterval(countTimer);
        judged = new Set();
        lastLive = { degree: -1, quality: -1, shape: -1 };
        score = newSetScore(targets.length);
        rt.play();
        phase = 'playing';
      }
    }, msPerBeat);
  }

  function pause() {
    if (phase !== 'playing') return;
    rt.stop();
    phase = 'paused';
  }
  function retry() {
    rt.stop();
    phase = 'ready';
    popups = [];
    begin();
  }
  function quit() {
    sfx.back();
    restore();
    stage.toSets();
  }

  // ---- judging -----------------------------------------------------------------
  function popup(text: string, kind: Judgment, arrow: '' | '←' | '→', hand: 'left' | 'right') {
    const h = hand === 'left' ? rt.left : rt.right;
    const mirror = !settings.s.parser.calibration.mirror_frame;
    const x = h.present ? (mirror ? 1 - h.wrist[0] : h.wrist[0]) : hand === 'left' ? 0.68 : 0.32;
    const y = h.present ? h.wrist[1] - 0.12 : 0.5;
    const id = ++popupId;
    popups = [...popups.slice(-5), { id, text, x, y, kind, arrow }];
    setTimeout(() => (popups = popups.filter((p) => p.id !== id)), 900);
  }

  function settle(t: TutorialTarget, j: Judgment, offsetMs?: number) {
    judged.add(t.index);
    const before = score.run;
    score = applyHit(score, { target: t.index, judgment: j, offsetMs, beat: t.startBeat }, vars);
    const info = JUDGMENT_INFO[j];
    sfx.judge(j, t.degree);
    if (j === 'dropped' && before >= 8) sfx.runBreak();
    popup(info.label, j, j === 'early' ? '←' : j === 'late' ? '→' : '', 'left');
    if (score.failed) finish();
  }

  // Missed targets: the late window closed with no chord.
  $effect(() => {
    if (phase !== 'playing' || !song) return;
    const lateBeats = WINDOWS.late / msPerBeat;
    for (const t of targets) {
      if (judged.has(t.index)) continue;
      if (beatPos > t.startBeat + lateBeats && beatPos < t.startBeat + lateBeats + 1) settle(t, 'dropped');
    }
    // End of the single pass: the transport wrapped.
    if (rt.position.loopCount >= 1 || beatPos >= total - 1e-6) finish();
  });

  // Chord changes from the live parser.
  $effect(() => {
    const l = rt.live;
    if (phase !== 'playing' || !song) return;
    if (l.degree === 0) return;
    if (l.degree === lastLive.degree && l.quality === lastLive.quality && l.shape === lastLive.shape) return;
    lastLive = { degree: l.degree, quality: l.quality, shape: l.shape };
    // nearest unjudged target within the late window either side
    let best: TutorialTarget | null = null;
    let bestMs = Infinity;
    for (const t of targets) {
      if (judged.has(t.index)) continue;
      const ms = (beatPos - t.startBeat) * msPerBeat;
      if (Math.abs(ms) < Math.abs(bestMs)) {
        bestMs = ms;
        best = t;
      }
    }
    if (!best || Math.abs(bestMs) > WINDOWS.late) return;
    settle(best, judgeHit(best, { degree: l.degree, quality: l.quality, shape: l.shape, octave: l.octave }, bestMs, strict), bestMs);
  });

  // A chord held from an identical previous target counts when its beat comes.
  $effect(() => {
    if (phase !== 'playing' || !song) return;
    const l = rt.live;
    for (const t of targets) {
      if (judged.has(t.index) || beatPos < t.startBeat || beatPos > t.startBeat + 0.05) continue;
      const prev = targets[t.index - 1];
      if (!prev || !judged.has(prev.index)) continue;
      const same = prev.degree === t.degree && prev.quality === t.quality && (!strict || prev.shape === t.shape);
      if (same && l.degree === t.degree && l.quality === t.quality && (!strict || l.shape === t.shape)) settle(t, 'locked', 0);
    }
  });

  let finished = false;
  function finish() {
    if (finished || !song) return;
    finished = true;
    rt.stop();
    phase = 'done';
    // anything never judged is a drop
    for (const t of targets) if (!judged.has(t.index)) score = applyHit(score, { target: t.index, judgment: 'dropped', beat: t.startBeat }, vars);
    const r = rating(score);
    const rec = records.record({ songId: song.id ?? song.name, songName: song.name, score: score.score, accuracy: accuracy(score), bestRun: score.bestRun, rating: r, variations: vars, at: Date.now() });
    if (!vars.includes('rehearsal')) achievements.track({ kind: 'set_done', songId: song.id ?? song.name, ratingTier: RATING_ORDER.indexOf(r), bestRun: score.bestRun });
    stage.lastResult = { songId: song.id ?? song.name, songName: song.name, score, variations: vars, bpm, newBest: rec.newBest, xpGained: rec.xpGained };
    restore();
    setTimeout(() => (stage.screen = 'results'), 500);
  }

  // ---- next-chord outline for the scene ---------------------------------------------
  let synthLm: ((cx: number, cy: number, palm: number, mask: number, tilt: number, right: boolean) => Float32Array) | null = null;
  const leftLm = new Float32Array(63);
  const rightLm = new Float32Array(63);
  function provideTarget(): LearnTarget | null {
    const t = nextTarget;
    if (!t || !synthLm || phase !== 'playing' && phase !== 'countin') return null;
    const until = t.startBeat - beatPos;
    if (blind && until < 1 && until > 0.02) return null;
    const lmask = leftFingersFor(t.degree).reduce((m, b, i) => m | (b ? 1 << i : 0), 0);
    const rmask = rightFingersFor(t.shape, t.octave).reduce((m, b, i) => m | (b ? 1 << i : 0), 0);
    const lw = rt.left.present ? rt.left.wrist : [0.68, 0.55, 0];
    const rw = rt.right.present ? rt.right.wrist : [0.32, 0.55, 0];
    leftLm.set(synthLm(lw[0], lw[1] - 0.02, (rt.left.palm_size || 0.12) * 1.05, lmask, tiltFor(t.quality), false));
    rightLm.set(synthLm(rw[0], rw[1] - 0.02, (rt.right.palm_size || 0.12) * 1.05, rmask, 0, true));
    return { left: leftLm, right: rightLm, matchLeft: rt.live.degree === t.degree && rt.live.quality === t.quality, matchRight: rt.live.shape === t.shape, countdown: Math.max(0, Math.min(1, 1 - until / 2)) };
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (phase === 'playing') pause();
      else if (phase === 'paused') { phase = 'playing'; rt.play(); }
      else if (phase === 'ready' || phase === 'camera' || !!error) quit();
    } else if (e.key === 'Enter' && phase === 'ready') begin();
  }

  // Groove arc geometry: a 220 degree arc across the top.
  const R = 120;
  const arcLen = (Math.PI * 220) / 180 * R;
  const barsList = $derived(song ? Array.from({ length: song.bars }, (_, i) => i) : []);
  const currentBar = $derived(rt.position.bar);
</script>

<svelte:window onkeydown={onKey} />

<div class="set" class:grooving>
  {#if error}
    <div class="panel glass strong">
      <p>{error}</p>
      <div class="row">
        <button onclick={quit}>Back to sets</button>
        {#if song}<button onclick={() => { restore(); stage.screen = 'page'; void demo.start(song!, { mode: 'once' }); }}>Watch the demo</button>{/if}
      </div>
    </div>
  {:else if phase === 'loading' || phase === 'camera'}
    <div class="panel glass strong"><p>{phase === 'camera' ? 'Starting the camera…' : 'Loading…'}</p></div>
  {:else}
    <!-- top: groove arc + score -->
    <svg class="groove" viewBox="0 0 300 150" aria-label="Groove {Math.round(score.groove * 100)}%">
      <path d="M 30 130 A 120 120 0 1 1 270 130" fill="none" stroke="var(--line)" stroke-width="4" stroke-linecap="round" />
      <path d="M 30 130 A 120 120 0 1 1 270 130" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" stroke-dasharray="{arcLen}" stroke-dashoffset="{arcLen * (1 - score.groove)}" style="filter: drop-shadow(0 0 {grooving ? 10 : 3}px var(--accent-glow))" />
      <text x="150" y="120" text-anchor="middle" class="glabel">GROOVE</text>
    </svg>
    <div class="ticks" aria-hidden="true">
      {#each barsList as b}<span class:on={phase === 'playing' && currentBar === b + 1} class:past={phase === 'playing' && currentBar > b + 1}></span>{/each}
    </div>
    <div class="scorebox">
      <div class="num big">{score.score.toLocaleString()}</div>
      <div class="sm num dim">{(accuracy(score) * 100).toFixed(1)}%</div>
    </div>
    <div class="songbox">
      <div class="display">{song?.name}</div>
      <div class="sm num dim">{Math.round(bpm)} BPM{#if vars.length} · {vars.map((v) => VARIATIONS[v].label).join(' · ')}{/if}</div>
    </div>

    <!-- run -->
    <div class="runbox" class:pop={score.run > 0}>
      <div class="num run" style="font-size: {Math.min(64, 40 + score.run)}px">{score.run}</div>
      <div class="sm dim">RUN</div>
    </div>

    <!-- judgment words at the hands -->
    {#each popups as p (p.id)}
      <div class="judge {p.kind}" style="left:{p.x * 100}%; top:{p.y * 100}%">{p.arrow === '←' ? '← ' : ''}{p.text}{p.arrow === '→' ? ' →' : ''}</div>
    {/each}

    {#if phase === 'ready'}
      <div class="panel glass strong fade-in centre">
        <div class="display" style="font-size:20px">{song?.name}</div>
        <p class="hint">{rt.left.present || rt.right.present ? 'Hands seen. Press Start; the count-in is one bar.' : 'Hold both hands up so the camera sees them.'}</p>
        <div class="row" style="gap:8px">
          <button class="primary" onclick={begin}>Start</button>
          <button class="ghost" onclick={quit}>Back</button>
        </div>
      </div>
    {:else if phase === 'countin'}
      <div class="count display">{count}</div>
    {:else if phase === 'paused'}
      <div class="panel glass strong fade-in centre">
        <div class="display" style="font-size:20px">Paused</div>
        <div class="row" style="gap:8px">
          <button class="primary" onclick={() => { phase = 'playing'; rt.play(); }}>Continue</button>
          <button onclick={retry}>Retry</button>
          <button class="ghost" onclick={quit}>Quit</button>
        </div>
      </div>
    {:else if phase === 'done'}
      <div class="count display" style="font-size:40px">{score.failed ? 'Take dropped' : 'Set complete'}</div>
    {/if}
    {#if phase === 'playing'}<button class="ghost small pausebtn" onclick={pause}>Pause <kbd>Esc</kbd></button>{/if}
  {/if}
</div>

<style>
  .set {
    position: absolute;
    inset: 0;
    z-index: 30;
    pointer-events: none;
  }
  .set > * {
    pointer-events: auto;
  }
  .groove {
    position: absolute;
    left: 50%;
    top: 8px;
    width: 300px;
    height: 150px;
    transform: translateX(-50%);
    pointer-events: none;
  }
  .glabel {
    font-size: 10px;
    letter-spacing: 0.2em;
    fill: var(--text-dim);
  }
  .ticks {
    position: absolute;
    left: 50%;
    top: 150px;
    transform: translateX(-50%);
    display: flex;
    gap: 4px;
    pointer-events: none;
  }
  .ticks span {
    width: 14px;
    height: 3px;
    border-radius: 2px;
    background: var(--line);
  }
  .ticks span.past {
    background: var(--text-dim);
  }
  .ticks span.on {
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-glow);
  }
  .scorebox {
    position: absolute;
    right: 28px;
    top: 22px;
    text-align: right;
  }
  .big {
    font-size: 34px;
    font-variant-numeric: tabular-nums;
  }
  .songbox {
    position: absolute;
    left: 28px;
    top: 22px;
  }
  .dim {
    color: var(--text-dim);
  }
  .runbox {
    position: absolute;
    left: 28px;
    bottom: 28px;
    text-align: center;
  }
  .run {
    line-height: 1;
    color: var(--accent);
    text-shadow: 0 0 16px var(--accent-glow);
    transition: font-size 120ms var(--ease);
  }
  .judge {
    position: absolute;
    transform: translate(-50%, -50%);
    font-weight: 700;
    font-size: 22px;
    letter-spacing: 0.04em;
    text-shadow: 0 0 12px rgba(0, 0, 0, 0.6);
    animation: rise 900ms var(--ease) both;
    pointer-events: none;
    white-space: nowrap;
  }
  .judge.locked {
    color: var(--accent);
    font-size: 26px;
  }
  .judge.onit {
    color: var(--text);
  }
  .judge.early,
  .judge.late {
    color: var(--text-dim);
  }
  .judge.dropped {
    color: #ff6b6b;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, -30%) scale(0.8);
    }
    20% {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1.1);
    }
    to {
      opacity: 0;
      transform: translate(-50%, -110%) scale(1);
    }
  }
  .panel {
    padding: 18px 22px;
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
    text-align: center;
  }
  .centre {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    min-width: 300px;
  }
  .count {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    font-size: 120px;
    color: var(--accent);
    text-shadow: 0 0 30px var(--accent-glow);
    pointer-events: none;
  }
  .pausebtn {
    position: absolute;
    right: 28px;
    bottom: 28px;
  }
  .grooving .groove {
    filter: saturate(1.4);
  }
</style>
