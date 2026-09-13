<script lang="ts">
  // Full-window Three.js scene (spec 8). Reads the runtime each frame, never
  // produces musical state.
  import { onMount } from 'svelte';
  import { GestureScene } from '../scene/scene';
  import type { SceneFrame, SceneGhost, LearnTarget } from '../scene/types';
  import { rt } from '../state/engine.svelte';
  import { settings } from '../state/settings.svelte';
  import { ui } from '../state/ui.svelte';
  import { getTheme } from '../themes';
  import { hueOf } from '../music';

  let { learn = null, onready }: { learn?: (() => LearnTarget | null) | null; onready?: (s: GestureScene) => void } = $props();

  let canvas: HTMLCanvasElement;
  let scene: GestureScene | null = null;
  let fps = $state(0);
  let quality = $state(0);

  onMount(() => {
    scene = new GestureScene(canvas);
    onready?.(scene);
    let last = performance.now();
    let raf = 0;
    let hudTick = 0;
    const ghosts: SceneGhost[] = [0, 1, 2, 3].map((i) => ({ active: false, left: null, right: null, color: '#fff', state: rt.tracks[i] }));
    const frame: SceneFrame = {
      time: 0,
      dt: 0,
      live: rt.live,
      left: { present: false, landmarks: null, fingers: [false, false, false, false, false], tilt: 0 },
      right: { present: false, landmarks: null, fingers: [false, false, false, false, false], tilt: 0 },
      ghosts,
      position: rt.position,
      bass: 0,
      treble: 0,
      level: 0,
      theme: getTheme(settings.s.theme),
      keyHue: 0,
      bursts: [],
      bassHits: 0,
      learn: null,
      beatPulse: 0,
      mirror: true,
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!scene) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      frame.time = now / 1000;
      frame.dt = dt;
      frame.live = rt.live;
      frame.position = rt.position;
      frame.left.present = rt.left.present && !!rt.leftLandmarks;
      frame.left.landmarks = rt.leftLandmarks;
      frame.left.fingers = rt.left.fingers;
      frame.left.tilt = rt.left.tilt;
      frame.right.present = rt.right.present && !!rt.rightLandmarks;
      frame.right.landmarks = rt.rightLandmarks;
      frame.right.fingers = rt.right.fingers;
      frame.right.tilt = rt.right.tilt;
      const theme = getTheme(settings.s.theme);
      frame.theme = { ...theme, particle_density: theme.particle_density * settings.s.particleDensity, ghost_opacity: settings.s.ghostOpacity, bloom: theme.bloom && settings.s.bloom };
      frame.keyHue = hueOf(rt.live.key);
      const sp = rt.spectrum();
      frame.bass = sp.bass;
      frame.treble = sp.treble;
      frame.level = sp.level;
      frame.bursts = rt.bursts;
      frame.bassHits = rt.bassHits;
      rt.bursts = [];
      rt.bassHits = 0;
      frame.mirror = !settings.s.parser.calibration.mirror_frame;
      rt.sampleGhosts();
      for (let i = 0; i < 4; i++) {
        const g = rt.ghosts[i];
        const gh = ghosts[i];
        gh.active = !g.empty && rt.position.state === 2;
        const [l, r] = gh.active ? g.sample(rt.position.position) : [null, null];
        gh.left = l;
        gh.right = r;
        gh.color = frame.theme.palette.ghost[i];
        gh.state = rt.tracks[i];
      }
      frame.learn = learn ? learn() : null;
      scene.setView(ui.performance && settings.s.viewMode !== 'clear' ? 'performance' : settings.s.viewMode, settings.s.clearShowHands, frame.mirror);
      scene.render(frame);
      if (++hudTick % 30 === 0) {
        fps = Math.round(scene.fps);
        quality = scene.quality;
      }
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(() => scene?.resize());
    ro.observe(canvas);
    // attach the camera video once it exists
    const vidCheck = setInterval(() => {
      if (rt.video && scene) {
        scene.setVideo(rt.video);
        clearInterval(vidCheck);
      }
    }, 500);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      clearInterval(vidCheck);
      scene?.dispose();
      scene = null;
    };
  });

  export function getScene() {
    return scene;
  }
  export function getCanvas() {
    return canvas;
  }
</script>

<canvas bind:this={canvas} class="scene" aria-label="Gesture Synth visual scene"></canvas>
{#if settings.s.showHud && !ui.performance}
  <div class="perf num" title="renderer fps / quality level">{fps} fps{quality ? ` · q${quality}` : ''}</div>
{/if}

<style>
  .scene {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    background: var(--bg);
  }
  .perf {
    position: absolute;
    right: 12px;
    bottom: 6px;
    font-size: 10px;
    color: var(--text-faint);
    pointer-events: none;
  }
</style>
