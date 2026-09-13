<script lang="ts">
  // Left rail (spec 9 "Pages"): Play, Learn, Song Builder, Instruments, Visuals,
  // Community, Settings. Collapsible: icons only, labels on hover/expand.
  import { router, PAGES } from '../router/router.svelte';
  import { ui } from '../state/ui.svelte';
  import MadeBy from './MadeBy.svelte';

  const icons: Record<string, string> = {
    play: 'M5 3v10l8-5z',
    learn: 'M2 4l6-2 6 2v8l-6 2-6-2z M8 2v12',
    builder: 'M2 12h12M2 8h8M2 4h5 M11 3l2 2-5 5H6V8z',
    instruments: 'M3 13V8a5 5 0 0 1 10 0v5 M3 10h2v3H3zm8 0h2v3h-2z',
    visuals: 'M8 2l1.8 4.2L14 7l-3.5 2.8L11.5 14 8 11.7 4.5 14l1-4.2L2 7l4.2-.8z',
    community: 'M5 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM1 13c0-2 2-3.5 4-3.5s4 1.5 4 3.5M7 13c0-2 2-3.5 4-3.5s4 1.5 4 3.5',
    medals: 'M8 1.5l2 4 4.4.6-3.2 3.1.8 4.4L8 11.5l-4 2.1.8-4.4L1.6 6.1 6 5.5z',
    settings: 'M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3',
  };
</script>

<nav class="rail glass" class:open={ui.railOpen} aria-label="Pages" onmouseenter={() => (ui.railOpen = true)} onmouseleave={() => (ui.railOpen = false)}>
  <a class="brand" href="/" onclick={(e) => (e.preventDefault(), router.go('play'))} title="Gesture Synth">
    <img src="/icons/icon.svg" alt="" width="28" height="28" />
  </a>
  {#each PAGES as p}
    <a
      class="item"
      class:active={router.route.page === p.id}
      href={p.path}
      aria-current={router.route.page === p.id ? 'page' : undefined}
      onclick={(e) => {
        e.preventDefault();
        router.go(p.id);
      }}>
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d={icons[p.icon]} /></svg>
      <span class="lbl">{p.label}</span>
    </a>
  {/each}
  <div class="foot">
    <MadeBy compact={!ui.railOpen} />
  </div>
</nav>

<style>
  .rail {
    position: absolute;
    left: 10px;
    top: 10px;
    bottom: 10px;
    width: 48px;
    padding: 8px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 30;
    transition: width var(--dur) var(--ease);
    overflow: hidden;
  }
  .rail.open {
    width: 170px;
  }
  .brand {
    display: grid;
    place-items: center;
    height: 36px;
    margin-bottom: 8px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 9px;
    border-radius: 10px;
    color: var(--text-dim);
    text-decoration: none;
    white-space: nowrap;
    transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
  }
  .item:hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--text);
  }
  .item.active {
    background: var(--accent-soft);
    color: #fff;
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .foot {
    margin-top: auto;
    display: flex;
    justify-content: center;
    padding-bottom: 4px;
  }
  .lbl {
    font-size: 13px;
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }
  .rail.open .lbl {
    opacity: 1;
  }
</style>
