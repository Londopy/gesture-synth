<script lang="ts">
  // Root: the scene is always full-window; chrome is overlays; pages are
  // panels over the scene (spec 9 "Layout"). Routing per spec 9.5.
  import { onMount } from 'svelte';
  import SceneCanvas from './lib/ui/SceneCanvas.svelte';
  import Hud from './lib/ui/Hud.svelte';
  import Landing from './lib/ui/Landing.svelte';
  import Rail from './lib/ui/Rail.svelte';
  import TopLeft from './lib/ui/TopLeft.svelte';
  import TopRight from './lib/ui/TopRight.svelte';
  import Transport from './lib/ui/Transport.svelte';
  import TempoPanel from './lib/ui/TempoPanel.svelte';
  import BottomDock from './lib/ui/BottomDock.svelte';
  import HelpOverlay from './lib/ui/HelpOverlay.svelte';
  import Tour from './lib/ui/Tour.svelte';
  import ExportSheet from './lib/ui/ExportSheet.svelte';
  import RecordSheet from './lib/ui/RecordSheet.svelte';
  import DemoSheet from './lib/ui/DemoSheet.svelte';
  import DemoBadge from './lib/ui/DemoBadge.svelte';
  import { demo } from './lib/demo/demo.svelte';
  import Toasts from './lib/ui/Toasts.svelte';
  import ConfirmDialog from './lib/ui/ConfirmDialog.svelte';
  import Learn from './routes/Learn.svelte';
  import Builder from './routes/Builder.svelte';
  import Instruments from './routes/Instruments.svelte';
  import Visuals from './routes/Visuals.svelte';
  import Community from './routes/Community.svelte';
  import Settings from './routes/Settings.svelte';
  import Achievements from './routes/Achievements.svelte';
  import AchievementPopup from './lib/ui/AchievementPopup.svelte';
  import { achievements } from './lib/achievements/store.svelte';
  import { router } from './lib/router/router.svelte';
  import { rt } from './lib/state/engine.svelte';
  import { ui } from './lib/state/ui.svelte';
  import { settings } from './lib/state/settings.svelte';
  import { handleKeydown, setKeyHooks } from './lib/keys';
  import { hueOf } from './lib/music';
  import { learnState } from './routes/learn-state.svelte';
  import { store } from './lib/storage/store';
  import { flags } from './lib/platform';
  import { Konami } from './lib/eggs/detect';
  import { fireEgg, unlockArcadeTheme } from './lib/eggs/effects';
  if (settings.s.eggsFound.includes('konami')) unlockArcadeTheme();
  const konami = new Konami();

  let sceneCanvas: SceneCanvas;
  const page = $derived(router.route.page);
  const showChrome = $derived(!ui.performance && rt.phase === 'ready');

  // key hue drives the chrome accent (spec 9 "Accent colors come from the SCENE")
  $effect(() => {
    document.documentElement.style.setProperty('--key-hue', String(hueOf(rt.live.key)));
  });
  // beat pulse for button glows
  let pulse = 0;
  let lastSeq = -1;
  $effect(() => {
    if (rt.position.beatSeq !== lastSeq) {
      lastSeq = rt.position.beatSeq;
      pulse = rt.position.lastBeatBar ? 1 : 0.6;
    }
  });
  onMount(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      pulse = Math.max(0, pulse - 0.05);
      document.documentElement.style.setProperty('--beat', pulse.toFixed(2));
    };
    raf = requestAnimationFrame(tick);
    achievements.start();
    setKeyHooks({
      save: async () => {
        if (rt.phase !== 'ready') return;
        const json = await rt.sessionJson();
        await store.write(rt.sessionName, 'session', json);
        rt.dirty = false;
        achievements.track({ kind: 'session_saved' });
        ui.toast(`Saved "${rt.sessionName}"`, 'ok');
      },
      export: () => (ui.exportSheet = !ui.exportSheet),
    });
    // deep links (desktop gsyn://)
    if (flags.isTauri) {
      import('@tauri-apps/plugin-deep-link').then(({ onOpenUrl, getCurrent }) => {
        onOpenUrl((urls) => urls.forEach((u) => router.openUrl(u)));
        getCurrent().then((urls) => urls?.forEach((u) => router.openUrl(u)));
      }).catch(() => {});
    }
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (rt.dirty && rt.position.state !== 0) e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  });

  // /demo opens the picker, /demo/<id> starts that song. Before the runtime is
  // ready the Landing screen picks the link up (its "Watch a demo" button).
  $effect(() => {
    router.openSeq;
    const r = router.route;
    if (r.kind !== 'demo') return;
    if (rt.phase !== 'ready') {
      ui.pendingDemoId = r.id ?? '';
      return;
    }
    if (r.id) void demo.start(r.id, { mode: settings.s.demoMode });
    else ui.openDemoPicker();
  });

  function keydown(e: KeyboardEvent) {
    if (ui.tour && e.key === 'Escape') {
      ui.tour = false;
      return;
    }
    // Escape is otherwise "panic"; while a demo plays it means "stop the demo".
    if (demo.active && e.key === 'Escape') {
      ui.demoPicker = false;
      demo.stop('esc');
      return;
    }
    if (rt.phase !== 'ready') return;
    if (settings.s.eggsEnabled && konami.key(e.key)) {
      const sc = sceneCanvas?.getScene();
      if (sc) fireEgg({ id: 'konami', x: 0.5, y: 0.5, sustain: false }, sc, true);
      return;
    }
    handleKeydown(e);
  }

  // The scene asks for a target outline each frame: the demo's next chord while
  // a demo plays, otherwise Learn's current target.
  const learnProvider = () => (demo.active ? (settings.s.demoShowNext ? demo.target() : null) : page === 'learn' ? learnState.provider?.() ?? null : null);
</script>

<svelte:window onkeydown={keydown} />

<div class="app" class:perf={ui.performance}>
  <SceneCanvas bind:this={sceneCanvas} learn={learnProvider} />
  <Hud />
  {#if demo.active}<DemoBadge />{/if}

  {#if (rt.phase !== 'ready' || !settings.s.firstRunDone) && !demo.active}
    <Landing />
  {/if}

  {#if showChrome}
    <Rail />
    {#if page === 'play'}
      <TopLeft />
      <TopRight />
      <Transport />
      <TempoPanel />
      <BottomDock />
    {:else}
      <div class="pagewrap">
        {#if page === 'learn'}<Learn />
        {:else if page === 'builder'}<Builder />
        {:else if page === 'instruments'}<Instruments />
        {:else if page === 'visuals'}<Visuals />
        {:else if page === 'community'}<Community />
        {:else if page === 'achievements'}<Achievements />
        {:else if page === 'settings'}<Settings />{/if}
      </div>
      <Transport />
      <TempoPanel />
    {/if}
  {/if}

  {#if ui.performance}
    <button class="exitperf ghost" onclick={() => ui.toggleFullscreen()} title="Exit performance view (F)">F</button>
  {/if}
  {#if ui.help}<HelpOverlay />{/if}
  {#if ui.tour && rt.phase === 'ready'}<Tour />{/if}
  {#if ui.exportSheet}<ExportSheet canvas={() => sceneCanvas?.getCanvas() ?? null} />{/if}
  {#if ui.recordSheet && rt.phase === 'ready'}<RecordSheet canvas={() => sceneCanvas?.getCanvas() ?? null} />{/if}
  {#if ui.demoPicker && rt.phase === 'ready'}<DemoSheet />{/if}
  {#if rt.phase === 'ready'}<AchievementPopup />{/if}
  <Toasts />
  <ConfirmDialog />
</div>

<style>
  .app {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .pagewrap {
    position: absolute;
    inset: 0;
    background: rgba(11, 13, 18, 0.55);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    z-index: 15;
  }
  .exitperf {
    position: absolute;
    right: 10px;
    top: 10px;
    opacity: 0.15;
    z-index: 20;
  }
  .exitperf:hover {
    opacity: 1;
  }
</style>
