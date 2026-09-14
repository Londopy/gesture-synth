<script lang="ts">
  // Profile: rank and progress, totals, recent sets and every song's best take.
  import { achievements } from '../achievements/store.svelte';
  import { MEDALS } from '../achievements/defs';
  import Medal from '../ui/Medal.svelte';
  import { medalById } from '../achievements/defs';
  import { records } from './records.svelte';
  import { rankFor, RATING_INFO } from './score';
  import { sfx } from './sfx';
  import { stage } from './stage.svelte';
  import { ui } from '../state/ui.svelte';

  const xp = $derived(records.xp + achievements.points * 10);
  const rank = $derived(rankFor(xp));
  const bests = $derived(Object.values(records.bests).sort((a, b) => b.score - a.score));
  const latest = $derived(achievements.unlocked.slice(-6).reverse());

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { sfx.back(); stage.toMenu(); }
  }
  async function reset() {
    if (await ui.ask('Reset Stage records', 'Forget every best take, recent set and rank progress on this device? Medals are kept.', 'Reset')) records.reset();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="profile">
  <div class="sheet glass strong fade-in">
    <div class="row" style="justify-content:space-between; align-items:flex-start">
      <div class="col" style="gap:4px">
        <span class="sm dim">RANK</span>
        <div class="display" style="font-size:34px; line-height:1.05">{rank.rank} <span class="dim" style="font-size:18px">{rank.step}/5</span></div>
        <div class="bar"><div class="fill" style="width:{Math.round(rank.progress * 100)}%"></div></div>
        <span class="sm num dim">{xp.toLocaleString()} xp{#if rank.next} · {rank.next.toLocaleString()} to the next step{/if}</span>
      </div>
      <button class="ghost" onclick={() => { sfx.back(); stage.toMenu(); }}>‹ Menu</button>
    </div>

    <div class="nums">
      <div class="kv"><span class="sm dim">SETS</span><span class="num big">{records.sets}</span></div>
      <div class="kv"><span class="sm dim">MEDALS</span><span class="num big">{achievements.unlocked.length}<span class="dim" style="font-size:14px">/{MEDALS.length}</span></span></div>
      <div class="kv"><span class="sm dim">POINTS</span><span class="num big">{achievements.points}</span></div>
      <div class="kv"><span class="sm dim">BEST RUN</span><span class="num big">{Math.max(0, ...bests.map((b) => b.bestRun))}</span></div>
    </div>

    <div class="two">
      <div class="col" style="gap:6px">
        <span class="sm dim">BEST TAKES</span>
        {#if !bests.length}<span class="hint">Play a set from the Sets screen; your best take per song lands here.</span>{/if}
        {#each bests as b (b.songId)}
          <button class="brow" onclick={() => { sfx.click(); stage.playSet(b.songId); }}>
            <span>{b.songName}</span><span class="rt">{RATING_INFO[b.rating].label}</span><span class="num">{(b.accuracy * 100).toFixed(1)}%</span><span class="num">{b.score.toLocaleString()}</span>
          </button>
        {/each}
      </div>
      <div class="col" style="gap:6px">
        <span class="sm dim">LATEST MEDALS</span>
        <div class="row wrap" style="gap:8px">
          {#each latest as u (u.id)}
            {@const m = medalById(u.id)}
            {#if m}<div class="medal"><Medal medal={m} unlocked size={44} /><span class="sm">{m.name}</span></div>{/if}
          {/each}
          {#if !latest.length}<span class="hint">Nothing yet. Play, loop, learn, explore.</span>{/if}
        </div>
        <button class="ghost small" style="align-self:flex-start" onclick={() => { sfx.click(); stage.openPage('achievements'); }}>All medals</button>
        <span class="sm dim" style="margin-top:12px">RECENT SETS</span>
        {#each records.recent.slice(0, 6) as r (r.at)}
          <div class="brow flat"><span>{r.songName}</span><span class="rt">{RATING_INFO[r.rating].label}</span><span class="num">{(r.accuracy * 100).toFixed(1)}%</span><span class="num">{r.score.toLocaleString()}</span></div>
        {/each}
      </div>
    </div>
    <div class="row" style="justify-content:flex-end"><button class="ghost small" onclick={reset}>Reset records</button></div>
  </div>
</div>

<style>
  .profile {
    position: absolute;
    inset: 0;
    z-index: 35;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .sheet {
    pointer-events: auto;
    width: min(820px, 94vw);
    max-height: 92vh;
    overflow: auto;
    padding: 20px 24px;
    border-radius: 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .dim {
    color: var(--text-dim);
  }
  .bar {
    width: 320px;
    height: 4px;
    border-radius: 2px;
    background: var(--line);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-glow);
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
  }
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
  }
  .brow {
    display: grid;
    grid-template-columns: 1fr auto auto auto;
    gap: 10px;
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 8px;
    border: 1px solid transparent;
    text-align: left;
    color: var(--text);
  }
  .brow:not(.flat):hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .rt {
    color: var(--accent);
  }
  .medal {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    width: 72px;
    text-align: center;
  }
</style>
