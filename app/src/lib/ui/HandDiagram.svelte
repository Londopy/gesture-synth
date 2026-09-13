<script lang="ts">
  // Animated SVG hand diagram built from the Rust synthetic-hand generator, so
  // tour/tutorial/cheat-sheet pictures use exactly the landmark geometry the
  // parser expects.
  import { onMount } from 'svelte';
  import { HAND_BONES, FINGERTIPS, LANDMARK_FINGER } from '../tracking/landmarks';
  import { ensureWasm } from '../tracking/parser';

  interface Props {
    fingers: readonly boolean[];
    tilt?: number;
    right?: boolean;
    y?: number;
    to?: { fingers?: readonly boolean[]; tilt?: number; y?: number } | null;
    size?: number;
    color?: string;
    label?: string;
    animate?: boolean;
  }
  let { fingers, tilt = 0, right = true, y = 0.5, to = null, size = 140, color = 'var(--accent)', label = '', animate = true }: Props = $props();

  let pts = $state<number[]>([]);
  let synth: ((cx: number, cy: number, palm: number, mask: number, tilt: number, right: boolean) => Float32Array) | null = null;
  let phase = 0;

  const mask = (f: readonly boolean[]) => f.reduce((m, b, i) => m | (b ? 1 << i : 0), 0);

  function compute(t: number) {
    if (!synth) return;
    const k = to && animate ? 0.5 - 0.5 * Math.cos(t * Math.PI * 2) : 0; // 0..1..0
    const f = k > 0.5 && to?.fingers ? to.fingers : fingers;
    const tl = tilt + ((to?.tilt ?? tilt) - tilt) * k;
    const yy = y + ((to?.y ?? y) - y) * k;
    const lm = synth(0.5, 0.6, 0.22, mask(f), tl, right);
    // hand drawn as seen in a mirror (so it reads like looking at your own hand)
    const out: number[] = [];
    for (let i = 0; i < 21; i++) {
      out.push((1 - lm[i * 3]) * 100, (lm[i * 3 + 1] + (yy - 0.6) * 0.6) * 100);
    }
    pts = out;
  }

  onMount(() => {
    let raf = 0;
    let stopped = false;
    ensureWasm().then(async () => {
      const m = await import('../wasm/pkg/gsyn.js');
      synth = m.synth_hand_landmarks;
      compute(0);
      const loop = (now: number) => {
        if (stopped) return;
        raf = requestAnimationFrame(loop);
        if (to && animate) {
          phase = (now / 2600) % 1;
          compute(phase);
        }
      };
      raf = requestAnimationFrame(loop);
    });
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  });

  $effect(() => {
    fingers;
    tilt;
    right;
    y;
    to;
    compute(phase);
  });

  const ext = (i: number) => {
    const f = LANDMARK_FINGER[i];
    return f < 0 ? true : fingers[f];
  };
</script>

<figure class="hand" style:width="{size}px" style:height="{size * 1.1}px">
  <svg viewBox="-10 -5 120 120" width={size} height={size * 1.1} aria-label={label || (right ? 'right hand' : 'left hand')}>
    {#if pts.length === 42}
      <g stroke={color} stroke-linecap="round" fill="none">
        {#each HAND_BONES as [a, b]}
          <line x1={pts[a * 2]} y1={pts[a * 2 + 1]} x2={pts[b * 2]} y2={pts[b * 2 + 1]} stroke-width={ext(b) ? 3.2 : 2} opacity={ext(b) ? 1 : 0.45} />
        {/each}
      </g>
      {#each Array(21) as _, i}
        <circle cx={pts[i * 2]} cy={pts[i * 2 + 1]} r={FINGERTIPS.includes(i) ? 3.4 : i === 0 ? 3 : 2} fill={color} opacity={ext(i) ? 1 : 0.5} />
      {/each}
    {/if}
  </svg>
  {#if label}<figcaption>{label}</figcaption>{/if}
</figure>

<style>
  .hand {
    margin: 0;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    filter: drop-shadow(0 0 8px var(--accent-glow));
  }
  figcaption {
    font-size: 11px;
    color: var(--text-dim);
    text-align: center;
  }
</style>
