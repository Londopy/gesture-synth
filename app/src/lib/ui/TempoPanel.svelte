<script lang="ts">
  // Bottom-right: BPM, time signature, bars, metronome volume (spec 9).
  import { rt } from '../state/engine.svelte';
  import { settings } from '../state/settings.svelte';
  import { TIME_SIGS } from '../music';

  let bpmEdit = $state<string | null>(null);
  const sig = $derived(`${rt.position.beats}/${rt.position.unit}`);

  function commitBpm() {
    if (bpmEdit != null) {
      const v = Number(bpmEdit);
      if (Number.isFinite(v)) rt.setBpm(Math.max(40, Math.min(240, v)));
    }
    bpmEdit = null;
  }
  function setSig(v: string) {
    const [b, u] = v.split('/').map(Number);
    rt.setTimeSig(b, u);
  }
  function setMetro(v: number) {
    settings.s.metronomeVolume = v;
    rt.cmd({ cmd: 'set_metronome_volume', volume: v });
  }
  function toggleMetro() {
    settings.s.metronomeEnabled = !settings.s.metronomeEnabled;
    rt.cmd({ cmd: 'set_metronome_enabled', on: settings.s.metronomeEnabled });
  }
  // tap tempo
  let taps: number[] = [];
  function tap() {
    const now = performance.now();
    taps = taps.filter((t) => now - t < 2500);
    taps.push(now);
    if (taps.length >= 3) {
      const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      rt.setBpm(Math.round(60000 / iv));
    }
  }
</script>

<div class="tempo glass panel row" data-tour="tempo">
  <div class="col">
    <span class="label">BPM</span>
    <div class="row">
      <button class="tiny" onclick={() => rt.nudgeBpm(-1)} title="- (Shift: -10)">−</button>
      {#if bpmEdit != null}
        <input class="bpm num" type="number" min="40" max="240" bind:value={bpmEdit} onblur={commitBpm} onkeydown={(e) => e.key === 'Enter' && commitBpm()} autofocus />
      {:else}
        <button class="bpmv display num" onclick={() => (bpmEdit = String(Math.round(rt.position.bpm)))} title="Click to type">{Math.round(rt.position.bpm)}</button>
      {/if}
      <button class="tiny" onclick={() => rt.nudgeBpm(1)} title="= (Shift: +10)">+</button>
      <button class="tiny" onclick={tap} title="Tap tempo">tap</button>
    </div>
  </div>
  <label class="col">
    <span class="label">Time</span>
    <select value={sig} onchange={(e) => setSig((e.target as HTMLSelectElement).value)}>
      {#each TIME_SIGS as s}<option value={s}>{s}</option>{/each}
    </select>
  </label>
  <label class="col">
    <span class="label">Bars</span>
    <select value={String(rt.position.bars)} onchange={(e) => rt.setBars(Number((e.target as HTMLSelectElement).value))}>
      {#each [1, 2, 4, 8, 16] as b}<option value={String(b)}>{b}</option>{/each}
    </select>
  </label>
  <div class="col metro">
    <span class="label">Click</span>
    <div class="row">
      <button class="tiny" class:active={settings.s.metronomeEnabled} onclick={toggleMetro} aria-pressed={settings.s.metronomeEnabled} title="Metronome on/off">♩</button>
      <input type="range" min="0" max="1" step="0.01" value={settings.s.metronomeVolume} oninput={(e) => setMetro(Number((e.target as HTMLInputElement).value))} aria-label="Metronome volume" style="width:70px" />
    </div>
  </div>
</div>

<style>
  .tempo {
    position: absolute;
    right: 14px;
    bottom: 14px;
    z-index: 20;
    gap: 14px;
    align-items: flex-end;
    padding: 10px 14px;
  }
  .tiny {
    padding: 3px 7px;
    font-size: 12px;
  }
  .bpmv {
    font-size: 28px;
    padding: 0 6px;
    min-width: 64px;
    border: none;
    background: transparent;
    line-height: 1;
  }
  .bpm {
    width: 64px;
    font-size: 18px;
    padding: 2px 6px;
  }
  select {
    font-size: 12px;
    padding: 5px 8px;
  }
</style>
