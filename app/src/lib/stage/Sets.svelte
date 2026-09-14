<script lang="ts">
  // Sets: song select as a circle-of-fifths wheel. Songs sit on the ring at
  // their key; scroll or arrow keys rotate the wheel; the song at the top is
  // selected and previews through the engine (loop track 4, when it is free).
  // A flat, searchable list is one toggle away.
  import { onDestroy, onMount } from 'svelte';
  import { demo } from '../demo/demo.svelte';
  import { DEMO_SONGS } from '../demo/songs';
  import { BUILTIN_SONGS, KEY_INDEX, type Song } from '../learn/songs';
  import { FIFTHS, hueOf } from '../music';
  import { router } from '../router/router.svelte';
  import { rt } from '../state/engine.svelte';
  import { store } from '../storage/store';
  import { difficultyOf, DIFFICULTY_LABELS } from './difficulty';
  import { records } from './records.svelte';
  import { RATING_INFO, VARIATIONS, type VariationId } from './score';
  import { borrow, release } from './menuLoop';
  import { sfx } from './sfx';
  import { stage } from './stage.svelte';

  let custom = $state<Song[]>([]);
  let view = $state<'wheel' | 'list'>('wheel');
  let q = $state('');
  let previewing = $state(false);

  const songs = $derived<Song[]>([...BUILTIN_SONGS, ...DEMO_SONGS, ...custom]);
  const filtered = $derived(songs.filter((s) => !q || `${s.name} ${s.tags.join(' ')} ${s.key} ${s.mode}`.toLowerCase().includes(q.toLowerCase())));

  // Wheel geometry: 12 fixed slots in fifths order, C at the top, matching the
  // scene's own circle-of-fifths ring behind this screen (same order, same
  // angles), so its note names label the wheel. The selection moves, not the
  // wheel. Songs sharing a key fan out sideways.
  let sel = $state(0); // selected slot
  // Ring geometry in pixels: CSS percentage translates are relative to the
  // element's own box, so radii must be computed from the measured wheel.
  let wheelW = $state(600);
  const rSlot = $derived(wheelW * 0.46);
  const rCard = $derived(wheelW * 0.3);
  const slotOf = (s: Song) => FIFTHS.indexOf(KEY_INDEX[s.key] ?? 0);
  const placed = $derived(
    songs.map((s, i) => {
      const slot = slotOf(s);
      const siblings = songs.filter((o) => slotOf(o) === slot);
      const k = siblings.indexOf(s);
      return { song: s, slot, spread: k - (siblings.length - 1) / 2, i };
    }),
  );
  const topSlot = $derived(((sel % 12) + 12) % 12);
  const atTop = $derived(placed.filter((p) => p.slot === topSlot));
  let pick = $state(0);
  const selected = $derived<Song | undefined>(atTop.length ? atTop[Math.min(pick, atTop.length - 1)].song : undefined);

  // Step to the next slot that has a song, in either direction.
  function rotate(by: number) {
    const occupied = new Set(placed.map((p) => p.slot));
    if (!occupied.size) return;
    let next = topSlot;
    for (let i = 0; i < 12; i++) {
      next = ((next + by) % 12 + 12) % 12;
      if (occupied.has(next)) break;
    }
    sel = next;
    pick = 0;
    sfx.tick();
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    rotate(e.deltaY > 0 ? 1 : -1);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); rotate(-1); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); rotate(1); }
    else if (e.key === 'Tab' && atTop.length > 1) { e.preventDefault(); pick = (pick + 1) % atTop.length; sfx.tick(); }
    else if (e.key === 'Enter' && selected) { e.preventDefault(); play(selected); }
    else if (e.key === 'Escape') { e.preventDefault(); back(); }
  }

  function select(s: Song) {
    sel = slotOf(s);
    pick = atTop.findIndex((p) => p.song.id === s.id);
    if (pick < 0) pick = 0;
    sfx.tick();
  }

  // Preview: the selected song's chords, quietly, on the free track 4.
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const s = selected;
    clearTimeout(previewTimer);
    if (!s || rt.phase !== 'ready') return;
    previewTimer = setTimeout(async () => {
      previewing = await borrow('preview', s, 0.3);
    }, 350);
  });

  function play(s: Song) {
    sfx.confirm();
    release('preview');
    stage.playSet(s.id ?? s.name);
  }
  function practise(s: Song) {
    sfx.click();
    release('preview');
    stage.selectedSet = s.id ?? null;
    stage.screen = 'page';
    router.navigate({ page: 'learn', kind: 'learn', id: s.id });
  }
  const VAR_IDS = Object.keys(VARIATIONS) as VariationId[];
  function watch(s: Song) {
    sfx.click();
    release('preview');
    stage.screen = 'page';
    router.go('play');
    void demo.start(s, { mode: 'once' });
  }
  function back() {
    sfx.back();
    release('preview');
    stage.toMenu();
  }

  onMount(async () => {
    const list = await store.list('song');
    const loaded: Song[] = [];
    for (const f of list) {
      try {
        const s = JSON.parse(await store.read(f.name, 'song')) as Song;
        s.id = s.id ?? f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        loaded.push(s);
      } catch {
        /* skip unreadable files */
      }
    }
    custom = loaded;
    const remembered = songs.find((s) => s.id === stage.selectedSet);
    if (remembered) select(remembered);
  });
  onDestroy(() => {
    clearTimeout(previewTimer);
    release('preview');
  });

  const hands = (s: Song) => difficultyOf(s).hands;
</script>

<svelte:window onkeydown={onKey} />

<div class="sets" onwheel={onWheel}>
  <div class="head">
    <button class="ghost" onclick={back}>‹ Menu</button>
    <h2 class="display" style="margin:0">Sets</h2>
    <div class="row" style="gap:8px">
      <div class="seg">
        <button class:active={view === 'wheel'} onclick={() => { view = 'wheel'; sfx.click(); }}>Wheel</button>
        <button class:active={view === 'list'} onclick={() => { view = 'list'; sfx.click(); }}>List</button>
      </div>
      {#if view === 'list'}<input type="search" placeholder="Search" bind:value={q} style="width:160px" />{/if}
    </div>
  </div>

  {#if view === 'wheel'}
    <div class="wheelwrap">
      <div class="wheel" bind:clientWidth={wheelW}>
        <div class="marker" style="transform: rotate({topSlot * 30}deg) translateY(-{rSlot + 4}px)"></div>
        {#each placed as p (p.song.id)}
          <button
            class="card glass"
            class:sel={selected?.id === p.song.id}
            style="transform: rotate({p.slot * 30 + p.spread * 11}deg) translateY(-{rCard}px) rotate({-(p.slot * 30 + p.spread * 11)}deg); --h:{hueOf(KEY_INDEX[p.song.key] ?? 0)}"
            onclick={() => (selected?.id === p.song.id ? play(p.song) : select(p.song))}
            title={p.song.name}
          >
            <span class="sn">{p.song.name}</span>
            <span class="handsrow" aria-label="difficulty {hands(p.song)} of 5">{'✋'.repeat(hands(p.song))}</span>
          </button>
        {/each}
      </div>
    </div>
  {:else}
    <div class="list glass">
      {#each filtered as s (s.id)}
        <button class="rowitem" class:sel={selected?.id === s.id} onclick={() => select(s)} ondblclick={() => play(s)}>
          <span class="sn">{s.name}</span>
          <span class="sm num dim">{s.key} {s.mode} · {s.bpm} BPM · {s.bars} bars</span>
          <span class="handsrow">{'✋'.repeat(hands(s))}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if selected}
    {@const d = difficultyOf(selected)}
    {@const best = records.best(selected.id ?? selected.name)}
    <aside class="detail glass strong fade-in">
      <div class="display name">{selected.name}</div>
      <div class="sm num dim">{selected.key} {selected.mode} · {selected.time_sig} · {selected.bpm} BPM · {selected.bars} bars · {selected.instrument ?? 'Pad'}</div>
      <div class="row" style="gap:8px">
        <span class="handsrow big">{'✋'.repeat(d.hands)}<span class="ghosted">{'✋'.repeat(5 - d.hands)}</span></span>
        <span class="sm">{DIFFICULTY_LABELS[d.hands]}</span>
      </div>
      {#if selected.description}<p class="desc">{selected.description}</p>{/if}
      <div class="row wrap" style="gap:4px">{#each selected.tags.filter((t) => t !== 'builtin') as t}<span class="chip">{t}</span>{/each}</div>
      <div class="kv"><span>Best take</span>{#if best}<span><b class="acc">{RATING_INFO[best.rating].label}</b> · {(best.accuracy * 100).toFixed(1)}% · run {best.bestRun}</span>{:else}<span class="dim">not rated yet</span>{/if}</div>
      <div class="col" style="gap:4px">
        <span class="sm dim">Variations</span>
        <div class="row wrap" style="gap:4px">
          {#each VAR_IDS as v}<button class="chip vchip" class:on={stage.variations.includes(v)} title={VARIATIONS[v].blurb} onclick={() => { stage.toggleVariation(v); sfx.tick(); }}>{VARIATIONS[v].label} <span class="dim">×{VARIATIONS[v].mult}</span></button>{/each}
        </div>
      </div>
      <div class="row wrap" style="gap:8px; margin-top:6px">
        <button class="primary" onclick={() => play(selected!)}>Play set</button>
        <button onclick={() => practise(selected!)}>Practise</button>
        <button onclick={() => watch(selected!)} disabled={rt.phase !== 'ready'}>Watch</button>
      </div>
      <p class="hint">{previewing ? 'Previewing on track 4.' : rt.phase !== 'ready' ? 'Start the sound from the menu to hear a preview.' : 'Preview needs an empty track 4 and a stopped transport.'} Scroll or use the arrow keys to turn the wheel; Enter plays.</p>
    </aside>
  {/if}
</div>

<style>
  /* The wheel is centred on the viewport so it lands on the scene's own
     circle-of-fifths ring; head and detail float over it. */
  .sets {
    position: absolute;
    inset: 0;
    z-index: 30;
    pointer-events: none;
  }
  .sets > * {
    pointer-events: auto;
  }
  .head {
    position: absolute;
    left: 28px;
    right: 28px;
    top: 22px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .wheelwrap {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }
  .wheel {
    position: relative;
    width: min(79vh, 92vw);
    aspect-ratio: 1;
    border-radius: 50%;
    border: 1px solid transparent;
    transition: transform 320ms var(--ease);
  }
  .list {
    position: absolute;
    left: 50%;
    top: 80px;
    bottom: 40px;
    width: min(560px, 92vw);
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px;
    overflow: auto;
    border-radius: 14px;
  }
  .detail {
    position: absolute;
    right: 28px;
    top: 80px;
    width: min(340px, 40vw);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px 18px;
    border-radius: 16px;
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
  }
  .head {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .marker,
  .card {
    position: absolute;
    left: 50%;
    top: 50%;
    transform-origin: 0 0;
    transition: transform 320ms var(--ease), opacity var(--dur) var(--ease);
  }
  .card {
    margin: -22px 0 0 -62px;
    width: 124px;
    padding: 6px 8px;
    border-radius: 10px;
    border: 1px solid var(--line);
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--text);
  }
  .card.sel {
    border-color: hsl(var(--h) 90% 65%);
    box-shadow: 0 0 calc(12px + 10px * var(--beat)) hsl(var(--h) 90% 60% / 0.5);
    background: hsl(var(--h) 80% 60% / 0.18);
  }
  .sn {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .handsrow {
    font-size: 10px;
    letter-spacing: -1px;
    opacity: 0.85;
  }
  .handsrow.big {
    font-size: 16px;
  }
  .ghosted {
    opacity: 0.2;
  }
  .marker {
    width: 0;
    height: 0;
    margin-left: -7px;
    border-left: 7px solid transparent;
    border-right: 7px solid transparent;
    border-top: 10px solid var(--accent);
    filter: drop-shadow(0 0 6px var(--accent-glow));
  }
  .rowitem {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 12px;
    align-items: center;
    padding: 8px 10px;
    border-radius: 10px;
    border: 1px solid transparent;
    text-align: left;
    color: var(--text);
  }
  .rowitem.sel,
  .rowitem:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .name {
    font-size: 22px;
  }
  .desc {
    margin: 0;
    font-size: 13px;
    color: var(--text-dim);
    line-height: 1.45;
  }
  .dim {
    color: var(--text-dim);
  }
  .kv {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
  }
  .acc {
    color: var(--accent);
  }
  .vchip {
    cursor: pointer;
  }
</style>
