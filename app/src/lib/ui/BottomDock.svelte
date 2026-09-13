<script lang="ts">
  // Bottom collapsible dock: beat grid + mixer (spec 7 "Editing").
  // Grid: rows = tracks, columns = 16th steps. Cell filled if a chord is active,
  // brightness = volume, hue = chord root. Click toggles step mute, drag paints,
  // right-click opens the chord popover.
  import { rt } from '../state/engine.svelte';
  import { settings } from '../state/settings.svelte';
  import { ui } from '../state/ui.svelte';
  import { chordName, degreeRoot, hueOf } from '../music';
  import { getTheme } from '../themes';
  import ChordPopover from './ChordPopover.svelte';

  const INSTRUMENTS = ['Pad', 'Keys', 'Organ', 'Pluck', 'Bass', 'Lead', 'Choir'];
  const colors = $derived(getTheme(settings.s.theme).palette.ghost);
  let painting: { value: boolean } | null = null;
  let painted = new Set<string>();

  $effect(() => {
    if (ui.grid) void rt.refreshGrid();
  });

  function cellStyle(cell: { degree: number; quality: number; volume: number } | null, muted: boolean) {
    if (!cell) return '';
    const hue = hueOf(degreeRoot(rt.live.key, rt.live.minor, cell.degree));
    const l = 28 + 40 * Math.min(1, cell.volume);
    return `--cell: hsl(${hue} 80% ${l}%); ${muted ? 'opacity:0.25' : ''}`;
  }

  function down(track: number, step: number, e: PointerEvent) {
    if (e.button !== 0) return;
    const cur = rt.grid?.mutes[track]?.[step] ?? false;
    painting = { value: !cur };
    painted = new Set([`${track}:${step}`]);
    rt.toggleStepMute(track, step);
  }
  function move(track: number, step: number) {
    if (!painting) return;
    const key = `${track}:${step}`;
    if (painted.has(key)) return;
    painted.add(key);
    const cur = rt.grid?.mutes[track]?.[step] ?? false;
    if (cur !== painting.value) rt.toggleStepMute(track, step);
  }
  function up() {
    painting = null;
  }
  function context(track: number, step: number, e: MouseEvent) {
    e.preventDefault();
    ui.chordPopover = { track, step, x: e.clientX, y: e.clientY };
  }
  async function setInstrument(i: number, name: string) {
    const inst = await rt.builtinInstrument(name);
    if (inst) await rt.setTrackInstrument(i, inst);
  }
  async function clear(i: number) {
    if (await ui.ask('Clear track', `Clear track ${i + 1}?`, 'Clear', true)) rt.clearTrack(i);
  }
</script>

<svelte:window onpointerup={up} />

{#if ui.grid}
  <div class="dock glass strong fade-in" data-tour="grid">
    <div class="head row">
      <span class="label">Beat grid · {rt.position.bars} bars · {rt.grid?.steps_per_bar ?? 16} steps per bar</span>
      <span class="hint">click = mute step · drag = paint · right-click = change chord</span>
      <button class="ghost" onclick={() => (ui.grid = false)} aria-label="Close">×</button>
    </div>
    <div class="body">
      <div class="mixer">
        {#each [0, 1, 2, 3] as i}
          {@const s = rt.trackSummary[i]}
          <div class="strip" class:selected={rt.position.selected === i} style:--c={colors[i]} onclick={() => rt.selectTrack(i)} role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && rt.selectTrack(i)}>
            <div class="row" style="justify-content:space-between">
              <span class="tn num">{i + 1}</span>
              <button class="tiny" class:active={s?.mute} onclick={(e) => (e.stopPropagation(), rt.toggleMute(i))}>M</button>
              <button class="tiny" class:active={s?.solo} onclick={(e) => (e.stopPropagation(), rt.toggleSolo(i))}>S</button>
              <button class="tiny" title="Clear" onclick={(e) => (e.stopPropagation(), clear(i))}>⌫</button>
            </div>
            <select value={s?.instrument ?? 'Pad'} onchange={(e) => setInstrument(i, (e.target as HTMLSelectElement).value)} onclick={(e) => e.stopPropagation()}>
              {#each INSTRUMENTS as n}<option value={n}>{n}</option>{/each}
            </select>
            <label class="row small"><span>vol</span><input type="range" min="0" max="1" step="0.01" value={s?.volume ?? 0.8} oninput={(e) => rt.setTrackVolume(i, Number((e.target as HTMLInputElement).value))} onclick={(e) => e.stopPropagation()} /></label>
            <label class="row small"><span>pan</span><input type="range" min="-1" max="1" step="0.01" value={s?.pan ?? 0} oninput={(e) => rt.setTrackPan(i, Number((e.target as HTMLInputElement).value))} ondblclick={() => rt.setTrackPan(i, 0)} onclick={(e) => e.stopPropagation()} /></label>
            <div class="row small">
              <select title="Track length (bars)" value={String(s?.length_bars ?? 0)} onchange={(e) => rt.setTrackLength(i, Number((e.target as HTMLSelectElement).value))} onclick={(e) => e.stopPropagation()}>
                <option value="0">= loop</option>
                {#each [1, 2, 4, 8].filter((b) => b < rt.position.bars) as b}<option value={String(b)}>{b} bar{b > 1 ? 's' : ''}</option>{/each}
              </select>
              <select title="MIDI channel" value={String(s?.midi_ch ?? i + 1)} onchange={(e) => rt.setTrackMidi(i, Number((e.target as HTMLSelectElement).value))} onclick={(e) => e.stopPropagation()}>
                {#each Array(16) as _, ch}<option value={String(ch + 1)}>ch {ch + 1}</option>{/each}
              </select>
            </div>
          </div>
        {/each}
      </div>
      <div class="grid" style:--steps={rt.grid?.cells[0]?.length ?? 16} style:--spb={rt.grid?.steps_per_bar ?? 16}>
        {#if rt.grid}
          {#each rt.grid.cells as row, t}
            <div class="gridrow" style:--c={colors[t]}>
              {#each row as cell, s}
                <button
                  class="cell"
                  class:on={!!cell}
                  class:muted={rt.grid.mutes[t]?.[s]}
                  class:now={rt.position.state === 2 && rt.position.step % row.length === s}
                  class:barstart={s % rt.grid.steps_per_bar === 0}
                  style={cellStyle(cell, !!rt.grid.mutes[t]?.[s])}
                  title={cell ? chordName(cell.degree, cell.quality as any, cell.shape as any) : 'empty'}
                  onpointerdown={(e) => down(t, s, e)}
                  onpointerenter={() => move(t, s)}
                  oncontextmenu={(e) => context(t, s, e)}></button>
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if ui.chordPopover}
  <ChordPopover />
{/if}

<style>
  .dock {
    position: absolute;
    left: 72px;
    right: 14px;
    bottom: 78px;
    z-index: 25;
    padding: 10px 12px 12px;
    max-height: 46vh;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    justify-content: space-between;
  }
  .hint {
    font-size: 11px;
    color: var(--text-faint);
  }
  .body {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: 12px;
    min-height: 0;
    overflow: hidden;
  }
  .mixer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow: auto;
  }
  .strip {
    border: 1px solid var(--line);
    border-left: 3px solid var(--c);
    border-radius: 10px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    cursor: pointer;
  }
  .strip.selected {
    background: color-mix(in srgb, var(--c) 10%, transparent);
    border-color: color-mix(in srgb, var(--c) 60%, transparent);
    border-left-color: var(--c);
  }
  .tn {
    font-weight: 600;
    color: var(--c);
  }
  .tiny {
    padding: 1px 6px;
    font-size: 11px;
  }
  .strip select {
    font-size: 11px;
    padding: 3px 6px;
  }
  .small {
    font-size: 11px;
    color: var(--text-dim);
  }
  .small span {
    width: 24px;
  }
  .grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow: auto;
    padding: 2px;
  }
  .gridrow {
    display: grid;
    grid-template-columns: repeat(var(--steps), minmax(10px, 1fr));
    gap: 2px;
    height: 44px;
  }
  .cell {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
    padding: 0;
    background: rgba(255, 255, 255, 0.03);
    min-width: 0;
    transition: background 120ms var(--ease), box-shadow 120ms var(--ease);
  }
  .cell.barstart {
    border-left-color: var(--line-strong);
  }
  .cell.on {
    background: var(--cell);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12), 0 0 8px color-mix(in srgb, var(--cell) 50%, transparent);
  }
  .cell.muted.on {
    background: repeating-linear-gradient(45deg, var(--cell) 0 3px, transparent 3px 6px);
  }
  .cell.now {
    outline: 2px solid var(--c);
    outline-offset: -1px;
  }
</style>
