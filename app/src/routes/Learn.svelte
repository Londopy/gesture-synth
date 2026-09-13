<script lang="ts">
  // Learn page (spec 9): song tutorials. The scene shows the NEXT required
  // hand shape as a ghost outline with a countdown; your hand turns green
  // when it matches. Score = timing + shape accuracy. Section loop, slow-down,
  // hints toggle.
  import { rt } from '../lib/state/engine.svelte';
  import { ui } from '../lib/state/ui.svelte';
  import { router } from '../lib/router/router.svelte';
  import { BUILTIN_SONGS, judge, leftFingersFor, markMissed, newScore, rightFingersFor, scorePercent, songById, songTargets, tiltFor, type Song, type TutorialTarget, type ScoreState } from '../lib/learn/songs';
  import { chordName, KEY_INDEX_FROM_NAME, type Quality, type Shape } from './learn-util';
  import type { LearnTarget } from '../lib/scene/types';
  import { learnState } from './learn-state.svelte';
  import { store, pickFile } from '../lib/storage/store';
  import { achievements } from '../lib/achievements/store.svelte';

  let song = $state<Song | null>(null);
  let targets = $state<TutorialTarget[]>([]);
  let score = $state<ScoreState>(newScore());
  let running = $state(false);
  let speed = $state(1);
  let hints = $state(true);
  let loopSection = $state(false);
  let sectionStart = $state(1);
  let sectionEnd = $state(4);
  let currentIdx = $state(-1);
  let nextIdx = $state(0);
  let judgedFor = new Set<number>();
  let lastDegree = -1;
  let lastShape = -1;
  let lastQuality = -1;
  let customSongs = $state<{ name: string }[]>([]);
  let synthLm: ((cx: number, cy: number, palm: number, mask: number, tilt: number, right: boolean) => Float32Array) | null = null;
  let leftLm = new Float32Array(63);
  let rightLm = new Float32Array(63);

  $effect(() => {
    import('../lib/wasm/pkg/gsyn.js').then((m) => (synthLm = m.synth_hand_landmarks));
    store.list('song').then((l) => (customSongs = l));
  });

  // open from route /learn/<id>
  $effect(() => {
    router.openSeq;
    const id = router.route.kind === 'learn' ? router.route.id : undefined;
    if (id) {
      const s = songById(id);
      if (s) void select(s);
      else if (learnState.pending?.id === id) void select(learnState.pending);
    }
  });

  async function select(s: Song) {
    stop();
    song = s;
    targets = songTargets(s);
    sectionStart = 1;
    sectionEnd = s.bars;
    // configure engine: tempo, sig, bars, key, backing as track 4 muted (metronome only by default)
    const [beats, unit] = s.time_sig.split('/').map(Number);
    rt.setTimeSig(beats, unit);
    rt.setBars(s.bars);
    rt.setBpm(s.bpm * speed);
    rt.setKey(KEY_INDEX_FROM_NAME(s.key), s.mode === 'minor');
    if (s.hints?.left_scheme || s.hints?.right_scheme) {
      // suggested schemes are applied only as hints text; the user's scheme stays
    }
  }

  function start() {
    if (!song) return;
    score = newScore();
    judgedFor = new Set();
    perfectStreak = { cur: 0, best: 0 };
    running = true;
    rt.setBpm(song.bpm * speed);
    rt.play();
  }
  function stop() {
    if (running && score.total >= targets.length && targets.length > 0) {
      achievements.track({ kind: 'tutorial', score: scorePercent(score), perfectStreak: perfectStreak.best });
    }
    running = false;
    rt.stop();
  }
  // perfect-hit streak for the Flawless medal
  let perfectStreak = { cur: 0, best: 0 };
  $effect(() => {
    const j = score.lastJudgement;
    const at = score.lastJudgementAt;
    if (!at) return;
    if (j === 'perfect') {
      perfectStreak.cur++;
      perfectStreak.best = Math.max(perfectStreak.best, perfectStreak.cur);
    } else if (j) perfectStreak.cur = 0;
  });
  function setSpeed(v: number) {
    speed = v;
    if (song) rt.setBpm(song.bpm * speed);
  }

  // main tutorial tick: driven by position updates
  $effect(() => {
    if (!running || !song) return;
    const p = rt.position;
    const beatsPerBar = p.beats;
    const beatPos = (p.bar - 1) * beatsPerBar + (p.beat - 1) + p.phase;
    // section loop: jump handled by re-issuing play at section end (transport is bar-based; approximate with mute of outside targets)
    const inSection = !loopSection || (p.bar >= sectionStart && p.bar <= sectionEnd);
    // find current + next target
    let cur = -1;
    for (let i = 0; i < targets.length; i++) if (targets[i].startBeat <= beatPos + 1e-6) cur = i;
    currentIdx = cur;
    nextIdx = (cur + 1) % targets.length;
    // missed: a target's window closed without a judgement
    if (cur >= 0 && !judgedFor.has(cur) && beatPos > targets[cur].startBeat + 1 && inSection) {
      judgedFor.add(cur);
      score = { ...markMissed(score) };
    }
    // wrap: reset judgements
    if (p.loopCount > 0 && beatPos < 0.5 && judgedFor.size >= targets.length - 1) judgedFor = new Set();
  });

  // judge on live chord changes
  $effect(() => {
    const l = rt.live;
    if (!running || !song || l.degree === 0) return;
    if (l.degree === lastDegree && l.shape === lastShape && l.quality === lastQuality) return;
    lastDegree = l.degree;
    lastShape = l.shape;
    lastQuality = l.quality;
    const p = rt.position;
    const beatPos = (p.bar - 1) * p.beats + (p.beat - 1) + p.phase;
    // nearest target by start beat (with wrap)
    let best = -1;
    let bestD = 1e9;
    const total = song.bars * p.beats;
    for (let i = 0; i < targets.length; i++) {
      let d = Math.abs(beatPos - targets[i].startBeat);
      d = Math.min(d, Math.abs(beatPos - total - targets[i].startBeat), Math.abs(beatPos + total - targets[i].startBeat));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0 && bestD <= 1 && !judgedFor.has(best)) {
      judgedFor.add(best);
      const checkShape = song.hints?.right_scheme?.kind !== 'fixed_style';
      score = { ...judge(score, targets[best], beatPos <= targets[best].startBeat + 1 ? beatPos : beatPos - total, { degree: l.degree, quality: l.quality, shape: l.shape, octave: l.octave }, checkShape) };
    }
  });

  /** Called by the scene each frame. */
  export function learnTarget(): LearnTarget | null {
    if (!running || !song || !hints || !synthLm || targets.length === 0) return null;
    const t = targets[nextIdx] ?? targets[0];
    const p = rt.position;
    const beatPos = (p.bar - 1) * p.beats + (p.beat - 1) + p.phase;
    let until = t.startBeat - beatPos;
    if (until < 0) until += song.bars * p.beats;
    const countdown = Math.max(0, Math.min(1, 1 - until / 2));
    const lf = leftFingersFor(t.degree);
    const rf = rightFingersFor(t.shape, t.octave);
    const lmask = lf.reduce((m, b, i) => m | (b ? 1 << i : 0), 0);
    const rmask = rf.reduce((m, b, i) => m | (b ? 1 << i : 0), 0);
    // place ghost outlines near the user's hands (or default spots)
    const lw = rt.left.present ? rt.left.wrist : [0.68, 0.55, 0];
    const rw = rt.right.present ? rt.right.wrist : [0.32, 0.55, 0];
    leftLm.set(synthLm(lw[0], lw[1] - 0.02, (rt.left.palm_size || 0.12) * 1.05, lmask, tiltFor(t.quality), false));
    rightLm.set(synthLm(rw[0], rw[1] - 0.02, (rt.right.palm_size || 0.12) * 1.05, rmask, 0, true));
    const matchLeft = rt.live.degree === t.degree && rt.live.quality === t.quality;
    const matchRight = rt.live.shape === t.shape;
    return { left: leftLm, right: rightLm, matchLeft, matchRight, countdown };
  }
  learnState.provider = learnTarget;

  async function importSong() {
    const f = await pickFile();
    if (!f) return;
    try {
      const s = JSON.parse(f.text) as Song;
      s.id = s.id ?? s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await store.write(s.name, 'song', JSON.stringify(s, null, 2));
      customSongs = await store.list('song');
      await select(s);
    } catch (e: any) {
      ui.toast('Not a valid song file', 'error');
    }
  }
  async function openCustom(name: string) {
    const s = JSON.parse(await store.read(name, 'song')) as Song;
    await select(s);
  }
  function useAsBacking() {
    if (!song) return;
    void rt.loadSongIntoTrack(JSON.stringify(song), 3);
    ui.toast('Song dropped into track 4', 'ok');
  }
</script>

<div class="page">
  <div class="page-inner">
    <div class="row" style="justify-content:space-between; align-items:flex-end">
      <div>
        <h2>Learn</h2>
        <p>Pick a song. The scene shows the next chord's hand shapes as an outline; hit it on the downbeat.</p>
      </div>
      <button onclick={importSong}>Import .song.gsyn.json</button>
    </div>
    <div class="layout">
      <aside class="songs glass card">
        <span class="label">Built in</span>
        {#each BUILTIN_SONGS as s}
          <button class="song" class:active={song?.id === s.id} onclick={() => select(s)}>
            <span class="sn">{s.name}</span>
            <span class="sm">{s.key} {s.mode} · {s.bpm} bpm · {s.bars} bars</span>
            <span class="tags">{#each s.tags.filter((t) => t !== 'builtin') as t}<span class="chip">{t}</span>{/each}</span>
          </button>
        {/each}
        {#if customSongs.length}
          <span class="label" style="margin-top:8px">Yours</span>
          {#each customSongs as s}
            <button class="song" class:active={song?.name === s.name} onclick={() => openCustom(s.name)}><span class="sn">{s.name}</span></button>
          {/each}
        {/if}
      </aside>
      <section class="detail glass card">
        {#if song}
          <div class="row" style="justify-content:space-between">
            <div>
              <h2 style="margin:0">{song.name}</h2>
              <p style="margin:2px 0 0">{song.description ?? ''}</p>
            </div>
            <div class="score">
              <span class="display big">{scorePercent(score)}%</span>
              <span class="label">score</span>
            </div>
          </div>
          <div class="chords">
            {#each targets as t, i}
              <div class="ch" class:cur={running && i === currentIdx} class:next={running && i === nextIdx} class:hit={judgedFor.has(i) && score.lastJudgement !== 'miss' && i === currentIdx}>
                <span class="bar num">{Math.floor(t.startBeat / (Number(song.time_sig.split('/')[0]) || 4)) + 1}</span>
                <span class="nm">{chordName(t.degree, t.quality as Quality, t.shape as Shape)}</span>
              </div>
            {/each}
          </div>
          <div class="row wrap controls">
            {#if running}
              <button class="primary" onclick={stop}>Stop</button>
            {:else}
              <button class="primary" onclick={start} disabled={rt.phase !== 'ready'}>Start</button>
            {/if}
            <label class="row small">Speed
              <select value={speed} onchange={(e) => setSpeed(Number((e.target as HTMLSelectElement).value))}>
                {#each [0.5, 0.6, 0.7, 0.8, 0.9, 1] as v}<option value={v}>{Math.round(v * 100)}%</option>{/each}
              </select></label>
            <label class="row small"><input type="checkbox" bind:checked={hints} /> hints</label>
            <label class="row small"><input type="checkbox" bind:checked={loopSection} /> loop bars
              <input type="number" min="1" max={song.bars} bind:value={sectionStart} style="width:48px" disabled={!loopSection} /> –
              <input type="number" min="1" max={song.bars} bind:value={sectionEnd} style="width:48px" disabled={!loopSection} /></label>
            <button onclick={useAsBacking} title="Load the chords into loop track 4 as a backing">Use as backing</button>
          </div>
          <div class="stats row num">
            <span>hits {score.hits}</span><span>misses {score.misses}</span><span>streak {score.streak} (best {score.bestStreak})</span>
            {#if score.lastJudgement}<span class="judge {score.lastJudgement}">{score.lastJudgement}</span>{/if}
          </div>
          <p class="hint">
            Suggested schemes: left {song.hints?.left_scheme?.kind ?? 'full'}, right {song.hints?.right_scheme?.kind ?? 'full'}{song.hints?.right_scheme?.shape ? ` (${song.hints.right_scheme.shape})` : ''}. Change them in the top-left menu.
          </p>
        {:else}
          <p>Select a song to begin.</p>
        {/if}
      </section>
    </div>
  </div>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 300px 1fr;
    gap: 14px;
  }
  .songs {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .song {
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
  }
  .sn {
    font-weight: 500;
  }
  .sm {
    font-size: 11px;
    color: var(--text-faint);
  }
  .tags {
    display: flex;
    gap: 4px;
    margin-top: 2px;
  }
  .detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .score {
    text-align: right;
  }
  .big {
    font-size: 44px;
    display: block;
  }
  .chords {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .ch {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    min-width: 76px;
    transition: all var(--dur) var(--ease);
  }
  .ch .bar {
    font-size: 10px;
    color: var(--text-faint);
  }
  .ch .nm {
    font-family: var(--font-display);
    font-size: 22px;
  }
  .ch.cur {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .ch.next {
    border-style: dashed;
    border-color: var(--line-strong);
  }
  .ch.hit {
    border-color: var(--ok);
  }
  .controls {
    flex-wrap: wrap;
    gap: 12px;
  }
  .small {
    font-size: 12px;
    color: var(--text-dim);
    gap: 6px;
  }
  .small select,
  .small input[type='number'] {
    font-size: 12px;
    padding: 3px 6px;
  }
  .stats {
    gap: 16px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .judge {
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 11px;
  }
  .judge.perfect {
    color: var(--ok);
  }
  .judge.good {
    color: var(--accent);
  }
  .judge.late {
    color: var(--warn);
  }
  .judge.miss {
    color: var(--danger);
  }
  .hint {
    font-size: 12px;
    color: var(--text-faint);
  }
</style>
