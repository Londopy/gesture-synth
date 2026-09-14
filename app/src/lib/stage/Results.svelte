<script lang="ts">
  // After a set: the Take rating reveals with a fanfare, then the numbers, the
  // timing constellation (every hit plotted early or late) and the local board.
  import { onMount } from 'svelte';
  import { demo } from '../demo/demo.svelte';
  import { songById } from '../learn/songs';
  import { DEMO_SONGS } from '../demo/songs';
  import { records } from './records.svelte';
  import { accuracy, JUDGMENT_INFO, RATING_INFO, rating, VARIATIONS, WINDOWS, type Judgment } from './score';
  import { sfx } from './sfx';
  import { stage } from './stage.svelte';

  const r = stage.lastResult;
  const s = r?.score;
  const rate = $derived(s ? rating(s) : 'rough');
  let revealed = $state(false);
  const judgments: Judgment[] = ['locked', 'onit', 'early', 'late', 'dropped'];
  const board = $derived(records.recent.filter((x) => x.songId === r?.songId).sort((a, b) => b.score - a.score).slice(0, 10));

  onMount(() => {
    const t = setTimeout(() => {
      revealed = true;
      if (rate === 'flawless' || rate === 'pocket') sfx.fanfare();
      else if (rate === 'rough') sfx.back();
      else sfx.confirm();
    }, 350);
    return () => clearTimeout(t);
  });

  function again() {
    sfx.click();
    if (r) stage.playSet(r.songId);
  }
  function watch() {
    if (!r) return;
    const song = songById(r.songId) ?? (DEMO_SONGS as any[]).find((x) => x.id === r.songId);
    if (!song) return;
    stage.screen = 'page';
    void demo.start(song, { mode: 'once' });
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') again();
    else if (e.key === 'Escape') { sfx.back(); stage.toSets(); }
  }

  // Constellation: x = offset in ms across ±late window, y = beat position.
  const W = 520;
  const H = 150;
  const dots = $derived(
    (s?.hits ?? [])
      .filter((h) => h.offsetMs !== undefined)
      .map((h) => ({ x: W / 2 + (Math.max(-WINDOWS.late, Math.min(WINDOWS.late, h.offsetMs!)) / WINDOWS.late) * (W / 2 - 16), y: 16 + (h.beat / Math.max(1, (s?.hits.at(-1)?.beat ?? 1) + 1)) * (H - 32), kind: h.judgment })),
  );
  const drops = $derived((s?.hits ?? []).filter((h) => h.offsetMs === undefined).length);
  const meanOffset = $derived.by(() => {
    const xs = (s?.hits ?? []).filter((h) => h.offsetMs !== undefined).map((h) => h.offsetMs!);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  });
</script>

<svelte:window onkeydown={onKey} />

{#if r && s}
  <div class="results">
    <div class="sheet glass strong fade-in">
      <div class="top">
        <div class="col" style="gap:2px">
          <span class="sm dim">TAKE RATING</span>
          <div class="rating display" class:revealed class:top={rate === 'flawless' || rate === 'pocket'}>{RATING_INFO[rate].label}</div>
          <span class="sm dim">{RATING_INFO[rate].blurb}</span>
        </div>
        <div class="col" style="text-align:right; gap:2px">
          <span class="display" style="font-size:18px">{r.songName}</span>
          <span class="sm num dim">{Math.round(r.bpm)} BPM{#if r.variations.length} · {r.variations.map((v) => VARIATIONS[v].label).join(' · ')}{/if}</span>
          {#if r.newBest}<span class="chip on">new best</span>{/if}
        </div>
      </div>

      <div class="nums">
        <div class="kv"><span class="sm dim">SCORE</span><span class="num big">{s.score.toLocaleString()}</span></div>
        <div class="kv"><span class="sm dim">ACCURACY</span><span class="num big">{(accuracy(s) * 100).toFixed(1)}%</span></div>
        <div class="kv"><span class="sm dim">BEST RUN</span><span class="num big">{s.bestRun}</span></div>
        <div class="kv"><span class="sm dim">XP</span><span class="num big">+{r.xpGained}</span></div>
      </div>

      <div class="row wrap" style="gap:6px">
        {#each judgments as j}<span class="chip {j}">{JUDGMENT_INFO[j].label} <b class="num">{s.counts[j]}</b></span>{/each}
      </div>

      <div class="col" style="gap:4px">
        <span class="sm dim">TIMING · {meanOffset < -15 ? `you play ${Math.round(-meanOffset)} ms early on average` : meanOffset > 15 ? `you play ${Math.round(meanOffset)} ms late on average` : 'centred on the beat'}{#if drops} · {drops} never came{/if}</span>
        <svg class="constellation" viewBox="0 0 {W} {H}" aria-hidden="true">
          <line x1={W / 2} y1="6" x2={W / 2} y2={H - 6} stroke="var(--accent)" stroke-opacity="0.6" />
          <line x1={W / 2 - (WINDOWS.locked / WINDOWS.late) * (W / 2 - 16)} y1="6" x2={W / 2 - (WINDOWS.locked / WINDOWS.late) * (W / 2 - 16)} y2={H - 6} stroke="var(--line)" stroke-dasharray="3 4" />
          <line x1={W / 2 + (WINDOWS.locked / WINDOWS.late) * (W / 2 - 16)} y1="6" x2={W / 2 + (WINDOWS.locked / WINDOWS.late) * (W / 2 - 16)} y2={H - 6} stroke="var(--line)" stroke-dasharray="3 4" />
          <text x="10" y={H - 4} class="axis">early</text>
          <text x={W - 10} y={H - 4} class="axis" text-anchor="end">late</text>
          {#each dots as d}
            <circle cx={d.x} cy={d.y} r={d.kind === 'locked' ? 4 : 3} class="dot {d.kind}" />
          {/each}
        </svg>
      </div>

      <div class="boards">
        <div class="col" style="gap:4px; flex:1">
          <span class="sm dim">LOCAL BOARD · {r.songName}</span>
          {#each board as b, i}
            <div class="brow" class:me={b.at === records.recent[0]?.at}>
              <span class="num dim">{i + 1}</span><span>{RATING_INFO[b.rating].label}</span><span class="num">{(b.accuracy * 100).toFixed(1)}%</span><span class="num">{b.score.toLocaleString()}</span>
            </div>
          {/each}
        </div>
        <div class="col" style="gap:4px; flex:1">
          <span class="sm dim">COMMUNITY BOARD</span>
          <span class="hint">Coming with the next release.</span>
        </div>
      </div>

      <div class="row" style="justify-content:space-between">
        <div class="row" style="gap:8px">
          <button class="primary" onclick={again}>Play again <kbd>Enter</kbd></button>
          <button onclick={() => { sfx.back(); stage.toSets(); }}>Sets <kbd>Esc</kbd></button>
          <button onclick={watch}>Watch the demo</button>
        </div>
        <button class="ghost" onclick={() => { sfx.click(); stage.toMenu(); }}>Menu</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .results {
    position: absolute;
    inset: 0;
    z-index: 35;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .sheet {
    pointer-events: auto;
    width: min(760px, 94vw);
    max-height: 92vh;
    overflow: auto;
    padding: 20px 24px;
    border-radius: 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }
  .rating {
    font-size: 44px;
    line-height: 1.05;
    opacity: 0;
    transform: translateX(-16px);
    transition: opacity 500ms var(--ease), transform 500ms var(--ease), text-shadow 500ms var(--ease);
  }
  .rating.revealed {
    opacity: 1;
    transform: none;
  }
  .rating.top {
    color: var(--accent);
    text-shadow: 0 0 22px var(--accent-glow);
  }
  .dim {
    color: var(--text-dim);
  }
  .nums {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
  }
  .kv {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
  }
  .big {
    font-size: 24px;
    font-variant-numeric: tabular-nums;
  }
  .chip.locked {
    border-color: var(--accent);
  }
  .chip.dropped {
    border-color: #ff6b6b;
  }
  .constellation {
    width: 100%;
    height: 150px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.02);
  }
  .axis {
    font-size: 10px;
    fill: var(--text-dim);
  }
  .dot {
    fill: var(--text);
    opacity: 0.85;
  }
  .dot.locked {
    fill: var(--accent);
  }
  .dot.early,
  .dot.late {
    fill: var(--text-dim);
  }
  .dot.dropped {
    fill: #ff6b6b;
  }
  .boards {
    display: flex;
    gap: 16px;
  }
  .brow {
    display: grid;
    grid-template-columns: 24px 1fr auto auto;
    gap: 10px;
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 8px;
  }
  .brow.me {
    background: var(--accent-soft);
  }
  kbd {
    font-size: 10px;
    margin-left: 6px;
  }
</style>
