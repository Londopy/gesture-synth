<script lang="ts">
  // Bottom-left: transport (play/stop/record) + track selector (spec 9).
  import { rt } from '../state/engine.svelte';
  import { ui } from '../state/ui.svelte';
  import { getTheme } from '../themes';
  import { settings } from '../state/settings.svelte';

  const playing = $derived(rt.position.state !== 0);
  const countIn = $derived(rt.position.state === 1);
  const rec = $derived(rt.position.recording);
  const colors = $derived(getTheme(settings.s.theme).palette.ghost);

  async function clear(i: number, e: MouseEvent) {
    if (e.shiftKey || (await ui.ask('Clear track', `Clear track ${i + 1}?`, 'Clear', true))) rt.clearTrack(i);
  }
</script>

<div class="transport glass panel row" data-tour="transport">
  <button class="icon big" class:active={playing} title="Play / stop (Space)" aria-label={playing ? 'Stop' : 'Play'} onclick={() => rt.togglePlay()}>
    {#if playing}
      <svg width="16" height="16" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" /></svg>
    {:else}
      <svg width="16" height="16" viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" fill="currentColor" /></svg>
    {/if}
  </button>
  <button
    class="icon big rec"
    class:armed={rec === 1}
    class:recording={rec === 2}
    class:countin={countIn}
    title="Record on selected track (R)"
    aria-label="Record"
    aria-pressed={rec !== 0}
    onclick={() => rt.toggleRecord()}>
    <span class="dot"></span>
  </button>
  <div class="tracks" data-tour="tracks" role="group" aria-label="Tracks">
    {#each [0, 1, 2, 3] as i}
      {@const s = rt.trackSummary[i]}
      {@const t = rt.tracks[i]}
      <button
        class="track"
        class:selected={rt.position.selected === i}
        class:has={s && !s.empty}
        class:muted={s?.mute}
        class:solo={s?.solo}
        class:sounding={t?.degree > 0 && playing}
        class:rectrack={rec !== 0 && rt.position.recTrack === i}
        style:--c={colors[i]}
        title="Track {i + 1} ({s?.instrument ?? ''}) — key {i + 1}"
        onclick={() => rt.selectTrack(i)}
        oncontextmenu={(e) => {
          e.preventDefault();
          void clear(i, e);
        }}>
        <span class="n num">{i + 1}</span>
        <span class="bar"><i style:width="{(t?.volume ?? 0) * 100}%"></i></span>
      </button>
    {/each}
  </div>
  <div class="mini row">
    <button class="tiny" class:active={rt.trackSummary[rt.position.selected]?.mute} title="Mute selected (M)" onclick={() => rt.toggleMute()}>M</button>
    <button class="tiny" class:active={rt.trackSummary[rt.position.selected]?.solo} title="Solo selected (S)" onclick={() => rt.toggleSolo()}>S</button>
    <button class="tiny" class:active={ui.grid} title="Beat grid + mixer (G)" onclick={() => ui.toggleGrid()}>▦</button>
  </div>
</div>

<style>
  .transport {
    position: absolute;
    left: 72px;
    bottom: 14px;
    z-index: 20;
    gap: 10px;
    padding: 10px 12px;
  }
  .big {
    width: 44px;
    height: 44px;
    border-radius: 50%;
  }
  .rec .dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--danger);
    display: block;
    opacity: 0.6;
    transition: all var(--dur) var(--ease);
  }
  .rec.armed .dot {
    opacity: 1;
    box-shadow: 0 0 12px var(--danger);
  }
  .rec.recording {
    border-color: var(--danger);
  }
  .rec.recording .dot {
    opacity: 1;
    box-shadow: 0 0 18px var(--danger);
    animation: breathe 0.6s ease-in-out infinite;
  }
  .rec.countin {
    animation: breathe 0.5s ease-in-out infinite;
    border-color: var(--danger);
  }
  .tracks {
    display: flex;
    gap: 6px;
  }
  .track {
    width: 44px;
    height: 44px;
    padding: 4px 0 6px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    border-color: color-mix(in srgb, var(--c) 35%, transparent);
    position: relative;
  }
  .track.selected {
    border-color: var(--c);
    box-shadow: 0 0 14px color-mix(in srgb, var(--c) 55%, transparent);
    background: color-mix(in srgb, var(--c) 14%, transparent);
  }
  .track .n {
    font-size: 14px;
    font-weight: 500;
  }
  .track .bar {
    width: 26px;
    height: 3px;
    background: rgba(255, 255, 255, 0.12);
    border-radius: 2px;
    overflow: hidden;
  }
  .track .bar i {
    display: block;
    height: 100%;
    background: var(--c);
    transition: width 100ms linear;
  }
  .track.has::after {
    content: '';
    position: absolute;
    top: 5px;
    right: 6px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--c);
  }
  .track.muted {
    opacity: 0.5;
  }
  .track.solo {
    border-style: dashed;
  }
  .track.rectrack {
    border-color: var(--danger);
  }
  .track.sounding {
    box-shadow: 0 0 calc(10px + 12px * var(--beat)) color-mix(in srgb, var(--c) 70%, transparent);
  }
  .mini {
    gap: 4px;
    flex-direction: column;
  }
  .tiny {
    padding: 2px 6px;
    font-size: 11px;
    min-width: 26px;
  }
</style>
