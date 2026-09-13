<script lang="ts">
  // Medals page: header with totals, category tabs, medal grid with progress,
  // detail panel. Hidden (hush-hush) medals show "?" until unlocked.
  import { achievements } from '../lib/achievements/store.svelte';
  import { CATEGORIES, CATEGORY_INFO, MEDALS, TIER_INFO, type Category, type Medal } from '../lib/achievements/defs';
  import MedalIcon from '../lib/ui/Medal.svelte';
  import { ui } from '../lib/state/ui.svelte';

  let cat = $state<Category | 'all'>('all');
  let selected = $state<Medal | null>(null);

  const unlockedIds = $derived(achievements.unlockedIds);
  const total = MEDALS.length;
  const count = $derived(achievements.unlocked.length);
  const shown = $derived(cat === 'all' ? MEDALS : MEDALS.filter((m) => m.category === cat));
  const tiers = $derived(
    (['bronze', 'silver', 'gold', 'platinum'] as const).map((t) => ({ tier: t, have: achievements.unlocked.filter((u) => MEDALS.find((m) => m.id === u.id)?.tier === t).length, of: MEDALS.filter((m) => m.tier === t).length })),
  );
  const recent = $derived([...achievements.unlocked].sort((a, b) => b.at - a.at).slice(0, 5));

  function pct(m: Medal): number | null {
    if (!m.progress || unlockedIds.has(m.id)) return null;
    const [a, b] = m.progress(achievements.stats);
    return Math.round((a / b) * 100);
  }
  function progressText(m: Medal): string {
    if (!m.progress) return '';
    const [a, b] = m.progress(achievements.stats);
    return `${Math.floor(a)} / ${b}`;
  }
  const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const hrs = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.floor(s / 60)} min`);

  async function reset() {
    if (await ui.ask('Reset medals', 'Clear every medal and all play statistics on this device?', 'Reset', true)) achievements.reset();
  }
</script>

<div class="page">
  <div class="page-inner">
    <div class="head glass card">
      <div class="col" style="gap:4px">
        <h2 style="margin:0">Medals</h2>
        <p style="margin:0">{count} of {total} unlocked · {achievements.points} / {achievements.maxPoints} points</p>
        <div class="pbar"><i style:width="{(count / total) * 100}%"></i></div>
      </div>
      <div class="tiers">
        {#each tiers as t}
          <div class="tier" style:--c={TIER_INFO[t.tier].color}>
            <span class="dot"></span>
            <span class="num">{t.have}/{t.of}</span>
            <span class="tn">{TIER_INFO[t.tier].name}</span>
          </div>
        {/each}
      </div>
      <div class="stats num">
        <span>{achievements.stats.chords} chords</span>
        <span>{achievements.stats.loops} loops</span>
        <span>{hrs(achievements.stats.playSeconds)} played</span>
        <span>{achievements.stats.days.length} days</span>
      </div>
    </div>

    <div class="row wrap">
      <div class="seg">
        <button class:active={cat === 'all'} onclick={() => (cat = 'all')}>All</button>
        {#each CATEGORIES as c}
          <button class:active={cat === c} onclick={() => (cat = c)} title={CATEGORY_INFO[c].blurb}>{CATEGORY_INFO[c].icon} {CATEGORY_INFO[c].name}</button>
        {/each}
      </div>
      {#if recent.length}
        <span class="small">Latest: {recent.map((u) => MEDALS.find((m) => m.id === u.id)?.name).filter(Boolean).join(' · ')}</span>
      {/if}
    </div>

    <div class="layout" class:withdetail={!!selected}>
      <div class="grid">
        {#each shown as m (m.id)}
          {@const got = unlockedIds.has(m.id)}
          {@const p = pct(m)}
          <button class="cell glass" class:got class:hidden={m.hidden && !got} class:sel={selected?.id === m.id} onclick={() => (selected = m)} style:--tier={TIER_INFO[m.tier].color} style:--tierglow={TIER_INFO[m.tier].glow}>
            <MedalIcon medal={m} unlocked={got} hidden={!!m.hidden} size={84} />
            <span class="mname">{got ? m.name : m.hidden ? '???' : m.name}</span>
            {#if p != null && !m.hidden}
              <span class="mprog"><i style:width="{p}%"></i></span>
            {:else if got}
              <span class="mdate">{fmt(achievements.unlockedAt(m.id)!)}</span>
            {:else}
              <span class="mdate">&nbsp;</span>
            {/if}
          </button>
        {/each}
      </div>
      {#if selected}
        {@const got = unlockedIds.has(selected.id)}
        <aside class="detail glass card col" style:--tier={TIER_INFO[selected.tier].color} style:--tierglow={TIER_INFO[selected.tier].glow}>
          <div class="row" style="justify-content:space-between">
            <span class="chip" style="border-color:var(--tier); color:var(--tier)">{TIER_INFO[selected.tier].name} · {TIER_INFO[selected.tier].points} pts</span>
            <button class="ghost" onclick={() => (selected = null)} aria-label="Close">×</button>
          </div>
          <div class="big"><MedalIcon medal={selected} unlocked={got} hidden={!!selected.hidden} size={160} shine={got} /></div>
          <h2 style="margin:0; text-align:center">{got || !selected.hidden ? selected.name : '???'}</h2>
          <p style="text-align:center">{got ? selected.description : selected.hidden ? 'A hush-hush medal. No hints.' : selected.hint}</p>
          {#if selected.progress && !got && !selected.hidden}
            <div class="col" style="gap:4px">
              <span class="label">Progress · {progressText(selected)}</span>
              <div class="pbar"><i style:width="{pct(selected)}%"></i></div>
            </div>
          {/if}
          {#if got}<p class="small" style="text-align:center">Unlocked {fmt(achievements.unlockedAt(selected.id)!)}</p>{/if}
          <span class="small" style="text-align:center">{CATEGORY_INFO[selected.category].icon} {CATEGORY_INFO[selected.category].name}</span>
        </aside>
      {/if}
    </div>

    <div class="row" style="justify-content:flex-end">
      <button class="ghost small" onclick={reset}>Reset medals and statistics</button>
    </div>
  </div>
</div>

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    align-items: center;
    justify-content: space-between;
  }
  .pbar {
    width: 260px;
    height: 6px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 3px;
    overflow: hidden;
  }
  .pbar i {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--accent), #fff);
    border-radius: 3px;
    transition: width 400ms var(--ease);
  }
  .tiers {
    display: flex;
    gap: 14px;
  }
  .tier {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .tier .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--c);
    box-shadow: 0 0 10px var(--c);
  }
  .tier .num {
    color: #fff;
    font-weight: 500;
  }
  .stats {
    display: flex;
    gap: 14px;
    font-size: 12px;
    color: var(--text-faint);
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    overflow: hidden;
    flex-wrap: wrap;
  }
  .seg button {
    border: none;
    border-radius: 0;
    font-size: 12px;
  }
  .wrap {
    flex-wrap: wrap;
    justify-content: space-between;
  }
  .small {
    font-size: 12px;
    color: var(--text-faint);
  }
  .layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: 14px;
  }
  .layout.withdetail {
    grid-template-columns: 1fr 300px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: 10px;
    align-content: start;
  }
  .cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px 8px 10px;
    border-radius: 14px;
    transition: box-shadow var(--dur) var(--ease), border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
  }
  .cell.got {
    border-color: color-mix(in srgb, var(--tier) 55%, transparent);
  }
  .cell.got:hover,
  .cell.sel {
    box-shadow: 0 0 22px var(--tierglow);
    border-color: var(--tier);
  }
  .cell.hidden {
    opacity: 0.6;
  }
  .mname {
    font-size: 12px;
    font-weight: 500;
    text-align: center;
    color: var(--text);
    min-height: 2.6em;
    display: flex;
    align-items: center;
  }
  .cell:not(.got) .mname {
    color: var(--text-dim);
  }
  .mprog {
    width: 80%;
    height: 3px;
    background: rgba(255, 255, 255, 0.12);
    border-radius: 2px;
    overflow: hidden;
  }
  .mprog i {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .mdate {
    font-size: 10px;
    color: var(--text-faint);
  }
  .detail {
    position: sticky;
    top: 0;
    align-self: start;
    gap: 12px;
    box-shadow: 0 0 40px var(--tierglow);
    border-color: color-mix(in srgb, var(--tier) 50%, transparent);
  }
  .big {
    display: grid;
    place-items: center;
  }
</style>
