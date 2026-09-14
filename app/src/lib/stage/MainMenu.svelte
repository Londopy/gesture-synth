<script lang="ts">
  // Stage main menu: seven glass keys, one per scale degree, one per entry.
  // Resting on a key sounds its degree in the live key, so the menu is in tune
  // with whatever was played last. The scene keeps running underneath; menu
  // music borrows loop track 4 when it is empty.
  import { onMount } from 'svelte';
  import { achievements } from '../achievements/store.svelte';
  import { MEDALS } from '../achievements/defs';
  import { demo } from '../demo/demo.svelte';
  import { ROMAN } from '../music';
  import { flags } from '../platform';
  import { rt } from '../state/engine.svelte';
  import { settings } from '../state/settings.svelte';
  import { ui } from '../state/ui.svelte';
  import MadeBy from '../ui/MadeBy.svelte';
  import { startMenuMusic, stopMenuMusic } from './menuLoop';
  import { sfx } from './sfx';
  import { stage } from './stage.svelte';

  type Entry = { label: string; sub: string; go: () => void };
  const entries: Entry[] = [
    { label: 'Play', sub: 'free play with the camera', go: () => stage.openPage('play') },
    { label: 'Sets', sub: 'songs to learn and rate', go: () => stage.toSets() },
    { label: 'Loop', sub: 'the four-track pedal and beat grid', go: () => { stage.openPage('play'); ui.grid = true; } },
    { label: 'Demo', sub: 'watch the app play', go: () => { stage.openPage('play'); if (rt.phase === 'ready') ui.openDemoPicker(); else ui.pendingDemoId = ''; } },
    { label: 'Community', sub: 'loops, songs and presets from others', go: () => stage.openPage('community') },
    { label: 'Medals', sub: 'what you have earned', go: () => stage.openPage('achievements') },
    { label: 'Settings', sub: 'audio, camera, gestures, shell', go: () => stage.openPage('settings') },
  ];

  let focus = $state(0);
  let started = $state(rt.phase === 'ready');

  // The first gesture on the menu starts audio (autoplay policy) without the
  // camera; the camera is asked for when Play is chosen, as in Studio.
  async function wake() {
    sfx.warm();
    if (rt.phase === 'idle' || rt.phase === 'error') {
      await rt.start({ camera: false });
    }
    started = rt.phase === 'ready';
    if (started) void startMenuMusic();
  }

  function choose(i: number) {
    sfx.confirm(i + 1);
    stopMenuMusic();
    entries[i].go();
  }

  function onKey(e: KeyboardEvent) {
    if (!started && rt.phase !== 'audio') void wake();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focus = (focus + (e.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length;
      sfx.hover(focus + 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void wake().then(() => choose(focus));
    } else if (e.key >= '1' && e.key <= '7') {
      focus = Number(e.key) - 1;
      void wake().then(() => choose(focus));
    }
  }

  async function quit() {
    sfx.back();
    if (!flags.isTauri) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  }

  onMount(() => {
    if (rt.phase === 'ready') void startMenuMusic();
    return () => stopMenuMusic();
  });

  const medals = $derived(achievements.unlocked.length);
</script>

<svelte:window onkeydown={onKey} onpointerdown={() => { if (!started) void wake(); }} />

<div class="menu">
  <div class="brand">
    <div class="display title">GESTURE SYNTH</div>
    <div class="sm num dim">{medals}/{MEDALS.length} medals · {achievements.points} pts</div>
  </div>

  <div class="keys" role="menu" aria-label="Main menu">
    {#each entries as e, i}
      <button
        class="key glass"
        class:focus={focus === i}
        role="menuitem"
        onpointerenter={() => { focus = i; sfx.hover(i + 1); }}
        onfocus={() => { focus = i; sfx.hover(i + 1); }}
        onclick={() => void wake().then(() => choose(i))}
      >
        <span class="roman display">{ROMAN[i]}</span>
        <span class="col" style="gap:2px; text-align:left">
          <span class="label">{e.label}</span>
          <span class="sub">{e.sub}</span>
        </span>
      </button>
    {/each}
    {#if flags.isTauri}
      <button class="key glass quit" onpointerenter={() => sfx.hover(7)} onclick={quit}>
        <span class="roman display">×</span>
        <span class="label">Quit</span>
      </button>
    {/if}
  </div>

  <div class="foot">
    {#if !started}<span class="hint">Click or press a key to start the sound</span>{:else if demo.active}<span class="hint">Demo playing</span>{/if}
    <div class="row" style="gap:10px">
      <button class="ghost small" onclick={() => { settings.s.shell = 'studio'; }}>Studio layout</button>
      <MadeBy />
    </div>
  </div>
</div>

<style>
  .menu {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: grid;
    grid-template-columns: minmax(280px, 380px) 1fr;
    grid-template-rows: auto 1fr auto;
    padding: 28px 32px;
    gap: 18px;
    pointer-events: none;
  }
  .menu > * {
    pointer-events: auto;
  }
  .brand {
    grid-column: 1 / -1;
    display: flex;
    align-items: baseline;
    gap: 16px;
  }
  .title {
    font-size: 22px;
    letter-spacing: 0.2em;
    text-shadow: 0 0 18px var(--accent-glow);
  }
  .dim {
    color: var(--text-dim);
  }
  .keys {
    display: flex;
    flex-direction: column;
    gap: 8px;
    justify-content: center;
  }
  .key {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 16px;
    border-radius: 14px;
    border: 1px solid var(--line);
    text-align: left;
    color: var(--text);
    transition: transform var(--dur) var(--ease), border-color var(--dur) var(--ease), background var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  }
  .key.focus,
  .key:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
    transform: translateX(6px);
    box-shadow: 0 0 calc(10px + 14px * var(--beat)) var(--accent-glow);
  }
  .roman {
    width: 44px;
    font-size: 24px;
    color: var(--accent);
    text-align: center;
  }
  .label {
    font-size: 16px;
    font-weight: 600;
  }
  .sub {
    font-size: 12px;
    color: var(--text-dim);
  }
  .quit {
    margin-top: 10px;
    opacity: 0.8;
  }
  .foot {
    grid-column: 1 / -1;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .hint {
    font-size: 12px;
    color: var(--text-dim);
  }
  @media (max-width: 720px) {
    .menu {
      grid-template-columns: 1fr;
    }
  }
</style>
