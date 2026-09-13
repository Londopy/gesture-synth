<script lang="ts">
  // Top-right chrome: live instrument, visual theme, help.
  import { rt } from '../state/engine.svelte';
  import { settings } from '../state/settings.svelte';
  import { ui } from '../state/ui.svelte';
  import { THEME_NAMES } from '../themes';

  const INSTRUMENTS = ['Pad', 'Keys', 'Organ', 'Pluck', 'Bass', 'Lead', 'Choir'];
  const isTheremin = $derived(settings.s.parser.mode === 'theremin');
</script>

<div class="tr glass panel row" data-tour="instrument">
  <label class="col">
    <span class="label">{isTheremin ? 'Theremin voice' : 'Instrument'}</span>
    {#if isTheremin}
      <select value={settings.s.thereminInstrument} onchange={(e) => rt.setThereminInstrument((e.target as HTMLSelectElement).value)}>
        {#each INSTRUMENTS as n}<option value={n}>{n}</option>{/each}
      </select>
    {:else}
      <select value={settings.s.liveInstrument} onchange={(e) => rt.setLiveInstrument((e.target as HTMLSelectElement).value)}>
        {#each INSTRUMENTS as n}<option value={n}>{n}</option>{/each}
      </select>
    {/if}
  </label>
  <label class="col">
    <span class="label">Theme</span>
    <select bind:value={settings.s.theme}>
      {#each THEME_NAMES as n}<option value={n}>{n}</option>{/each}
    </select>
  </label>
  <label class="col">
    <span class="label">View</span>
    <select bind:value={settings.s.viewMode} title="View mode (C cycles)">
      <option value="performance">Performance</option>
      <option value="practice">Practice</option>
      <option value="clear">Clear camera</option>
    </select>
  </label>
  <button class="icon rec" class:active={ui.recordSheet} title="Record video (Ctrl/Cmd+Shift+R)" aria-label="Record video" onclick={() => (ui.recordSheet = !ui.recordSheet)}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="4" width="9" height="8" rx="1.5" /><path d="M10.5 7l4-2v6l-4-2z" /></svg>
  </button>
  <button class="icon" title="Help (H)" aria-label="Help" onclick={() => ui.toggleHelp()}>?</button>
  <button class="icon" title="Performance view (F)" aria-label="Performance view" onclick={() => ui.toggleFullscreen()}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>
  </button>
</div>

<style>
  .tr {
    position: absolute;
    right: 14px;
    top: 14px;
    z-index: 20;
    gap: 12px;
    align-items: flex-end;
  }
  select {
    font-size: 12px;
    padding: 5px 8px;
    min-width: 110px;
  }
  .icon {
    font-weight: 600;
  }
  .rec.active {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
