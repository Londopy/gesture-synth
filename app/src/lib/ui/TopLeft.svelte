<script lang="ts">
  // Top-left chrome (spec 9): key selector + mode + hand scheme menus.
  import { rt } from '../state/engine.svelte';
  import { settings } from '../state/settings.svelte';
  import { FIFTHS, PITCH_NAMES, PITCH_NAMES_FLAT, ROMAN, SHAPE_NAMES, hueOf } from '../music';
  import type { LeftScheme, RightScheme } from '../tracking/parser';

  let keyOpen = $state(false);
  const names = $derived(settings.s.flatNames ? PITCH_NAMES_FLAT : PITCH_NAMES);
  const cfg = $derived(settings.s.parser);

  function setLeft(kind: string) {
    const c = settings.s.parser;
    let left: LeftScheme = { kind: 'full' };
    if (kind === 'scale_only') left = { kind: 'scale_only' };
    if (kind === 'fixed_degree') left = { kind: 'fixed_degree', degree: c.left.kind === 'fixed_degree' ? c.left.degree : 1 };
    rt.setParserConfig({ ...c, left });
  }
  function setRight(kind: string) {
    const c = settings.s.parser;
    let right: RightScheme = { kind: 'full' };
    if (kind === 'fixed_style') right = { kind: 'fixed_style', shape: 'seventh' };
    if (kind === 'dynamics_only') right = { kind: 'dynamics_only' };
    rt.setParserConfig({ ...c, right });
  }
  function setFixedShape(shape: string) {
    const c = settings.s.parser;
    rt.setParserConfig({ ...c, right: { kind: 'fixed_style', shape: shape as any } });
  }
  function setMode(mode: 'gesture' | 'theremin') {
    rt.setParserConfig({ ...settings.s.parser, mode });
  }
  function toggleSnap() {
    rt.setParserConfig({ ...settings.s.parser, theremin_snap: !settings.s.parser.theremin_snap });
  }
</script>

<div class="tl glass panel col" data-tour="key">
  <div class="row">
    <button class="key" aria-haspopup="dialog" aria-expanded={keyOpen} onclick={() => (keyOpen = !keyOpen)} title="Key ([ / ] to step around the circle of fifths)">
      <span class="dot" style:background="hsl({hueOf(rt.live.key)} 85% 62%)"></span>
      <span class="kname">{names[rt.live.key]}</span>
      <span class="mode">{rt.live.minor ? 'minor' : 'major'}</span>
    </button>
    <div class="seg" role="group" aria-label="Mode">
      <button class:active={cfg.mode === 'gesture'} onclick={() => setMode('gesture')} title="Chord instrument (Tab)">Gesture</button>
      <button class:active={cfg.mode === 'theremin'} onclick={() => setMode('theremin')} title="Continuous pitch (Tab)">Theremin</button>
    </div>
  </div>
  {#if keyOpen}
    <div class="keywheel fade-in" role="dialog" aria-label="Choose key">
      <div class="wheel">
        {#each FIFTHS as pc, i}
          {@const a = -Math.PI / 2 + (i / 12) * Math.PI * 2}
          <button
            class="pc"
            class:active={rt.live.key === pc}
            style:left="calc(50% + {Math.cos(a) * 74}px)"
            style:top="calc(50% + {Math.sin(a) * 74}px)"
            style:--h={hueOf(pc)}
            onclick={() => rt.setKey(pc, rt.live.minor)}>{names[pc]}</button>
        {/each}
        <div class="center">
          <button class:active={!rt.live.minor} onclick={() => rt.setKey(rt.live.key, false)}>major</button>
          <button class:active={rt.live.minor} onclick={() => rt.setKey(rt.live.key, true)}>minor</button>
        </div>
      </div>
      <div class="row" style="justify-content:space-between">
        <label class="row small"><input type="checkbox" bind:checked={settings.s.flatNames} /> flats</label>
        <button class="ghost small" onclick={() => (keyOpen = false)}>close</button>
      </div>
    </div>
  {/if}
  {#if cfg.mode === 'gesture'}
    <div class="row schemes">
      <label class="col">
        <span class="label">Left hand</span>
        <select value={cfg.left.kind} onchange={(e) => setLeft((e.target as HTMLSelectElement).value)}>
          <option value="full">Full (degree + tilt)</option>
          <option value="scale_only">Scale-only</option>
          <option value="fixed_degree">Fixed degree</option>
        </select>
      </label>
      {#if cfg.left.kind === 'fixed_degree'}
        <div class="degrees" role="group" aria-label="Fixed degree">
          {#each ROMAN as r, i}
            <button class:active={cfg.left.kind === 'fixed_degree' && cfg.left.degree === i + 1} onclick={() => rt.setFixedDegree(i + 1)}>{r}</button>
          {/each}
        </div>
      {/if}
      <label class="col">
        <span class="label">Right hand</span>
        <select value={cfg.right.kind} onchange={(e) => setRight((e.target as HTMLSelectElement).value)}>
          <option value="full">Full</option>
          <option value="fixed_style">Fixed style</option>
          <option value="dynamics_only">Dynamics only</option>
        </select>
      </label>
      {#if cfg.right.kind === 'fixed_style'}
        <select value={cfg.right.shape} onchange={(e) => setFixedShape((e.target as HTMLSelectElement).value)} aria-label="Fixed shape">
          {#each ['root', 'inv1', 'seventh', 'dom_or_dim7'] as s, i}
            <option value={s}>{SHAPE_NAMES[i]}</option>
          {/each}
        </select>
      {/if}
    </div>
  {:else}
    <div class="row schemes">
      <label class="row small"><input type="checkbox" checked={cfg.theremin_snap} onchange={toggleSnap} /> snap to scale</label>
      <span class="small dim">right height = pitch · left height = volume · right tilt = filter · left tilt = vibrato</span>
    </div>
  {/if}
</div>

<style>
  .tl {
    position: absolute;
    left: 72px;
    top: 14px;
    min-width: 300px;
    max-width: 520px;
    z-index: 20;
  }
  .key {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 6px 8px;
  }
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    box-shadow: 0 0 10px currentColor;
  }
  .kname {
    font-family: var(--font-display);
    font-size: 24px;
    line-height: 1;
    letter-spacing: 0.04em;
  }
  .mode {
    color: var(--text-dim);
    font-size: 12px;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .seg button {
    border: none;
    border-radius: 0;
    padding: 6px 10px;
    font-size: 12px;
  }
  .keywheel {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .wheel {
    position: relative;
    height: 190px;
    width: 190px;
    margin: 4px auto;
  }
  .pc {
    position: absolute;
    transform: translate(-50%, -50%);
    width: 36px;
    height: 36px;
    border-radius: 50%;
    padding: 0;
    font-size: 12px;
    border-color: hsl(var(--h) 70% 60% / 0.5);
  }
  .pc.active {
    background: hsl(var(--h) 80% 60% / 0.35);
    border-color: hsl(var(--h) 85% 65%);
    box-shadow: 0 0 16px hsl(var(--h) 85% 65% / 0.6);
  }
  .center {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .center button {
    font-size: 11px;
    padding: 4px 8px;
  }
  .schemes {
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px;
  }
  .schemes select {
    font-size: 12px;
    padding: 5px 8px;
  }
  .degrees {
    display: inline-flex;
    gap: 2px;
  }
  .degrees button {
    padding: 4px 6px;
    font-size: 11px;
    min-width: 28px;
  }
  .small {
    font-size: 12px;
  }
  .dim {
    color: var(--text-faint);
    max-width: 280px;
  }
</style>
