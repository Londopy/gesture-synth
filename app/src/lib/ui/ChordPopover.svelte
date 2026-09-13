<script lang="ts">
  // Right-click a grid cell: shows the chord and lets you replace it (spec 7).
  import { rt } from '../state/engine.svelte';
  import { ui } from '../state/ui.svelte';
  import { chordName, QUALITY_NAMES, ROMAN, SHAPE_NAMES, type Quality, type Shape } from '../music';

  const p = $derived(ui.chordPopover!);
  const cell = $derived(rt.grid?.cells[p.track]?.[p.step] ?? null);
  let degree = $state(1);
  let quality = $state<Quality>(0);
  let shape = $state<Shape>(0);
  let octave = $state(0);

  $effect(() => {
    if (cell) {
      degree = cell.degree;
      quality = cell.quality as Quality;
      shape = cell.shape as Shape;
      octave = cell.octave;
    }
  });

  async function apply() {
    await rt.replaceChord(p.track, p.step, degree, quality, shape, octave);
    ui.chordPopover = null;
  }
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') ui.chordPopover = null;
  }
  const left = $derived(Math.min(p.x, window.innerWidth - 300));
  const top = $derived(Math.max(10, p.y - 220));
</script>

<svelte:window onkeydown={key} onpointerdown={(e) => !(e.target as HTMLElement).closest('.popover') && (ui.chordPopover = null)} />

<div class="popover glass strong fade-in" style:left="{left}px" style:top="{top}px" role="dialog" aria-label="Chord at step">
  <div class="row" style="justify-content:space-between">
    <span class="label">Track {p.track + 1} · step {p.step + 1}</span>
    <span class="cur">{cell ? chordName(cell.degree, cell.quality as Quality, cell.shape as Shape) : 'empty'}</span>
  </div>
  <div class="degrees">
    {#each ROMAN as r, i}<button class:active={degree === i + 1} onclick={() => (degree = i + 1)}>{r}</button>{/each}
  </div>
  <div class="row">
    <select bind:value={quality}>{#each QUALITY_NAMES as q, i}<option value={i}>{q}</option>{/each}</select>
    <select bind:value={shape}>{#each SHAPE_NAMES as s, i}<option value={i}>{s}</option>{/each}</select>
    <select bind:value={octave}><option value={-1}>-1 oct</option><option value={0}>0</option><option value={1}>+1 oct</option></select>
  </div>
  <div class="row" style="justify-content:space-between">
    <span class="preview">{chordName(degree, quality, shape)}</span>
    <div class="row">
      <button onclick={() => (ui.chordPopover = null)}>Cancel</button>
      <button class="primary" onclick={apply}>{cell ? 'Replace' : 'Insert'}</button>
    </div>
  </div>
</div>

<style>
  .popover {
    position: fixed;
    width: 290px;
    padding: 12px;
    z-index: 70;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .cur {
    font-size: 12px;
    color: var(--text-dim);
  }
  .degrees {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 3px;
  }
  .degrees button {
    padding: 6px 0;
    font-size: 12px;
  }
  select {
    font-size: 12px;
    padding: 4px 6px;
    flex: 1;
  }
  .preview {
    font-family: var(--font-display);
    font-size: 22px;
  }
</style>
