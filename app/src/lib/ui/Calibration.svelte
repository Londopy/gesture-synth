<script lang="ts">
  // Camera calibration (spec 4.5): the user sets their own top/bottom for the
  // height -> volume mapping; also mirror / swap-hands / invert-tilt toggles.
  import { rt } from '../state/engine.svelte';
  import { settings } from '../state/settings.svelte';

  let { quick = false, onDone }: { quick?: boolean; onDone?: () => void } = $props();

  let phase = $state<'top' | 'bottom' | 'check'>('top');
  let top = $state(settings.s.parser.calibration.top_y);
  let bottom = $state(settings.s.parser.calibration.bottom_y);
  let samples: number[] = [];
  let progress = $state(0);
  let timer = 0;

  function hand() {
    return rt.right.present ? rt.right : rt.left.present ? rt.left : null;
  }

  function startPhase(p: 'top' | 'bottom') {
    phase = p;
    samples = [];
    progress = 0;
    clearInterval(timer);
    timer = window.setInterval(() => {
      const h = hand();
      if (!h) return;
      samples.push(h.wrist[1]);
      progress = Math.min(1, samples.length / 45); // ~2.5 s at 18 Hz
      if (progress >= 1) {
        clearInterval(timer);
        const sorted = samples.slice().sort((a, b) => a - b);
        const med = sorted[sorted.length >> 1];
        if (p === 'top') {
          top = Math.max(0.02, med);
          startPhase('bottom');
        } else {
          bottom = Math.min(0.98, Math.max(top + 0.2, med));
          phase = 'check';
          apply();
        }
      }
    }, 55);
  }

  function apply() {
    const cfg = settings.s.parser;
    cfg.calibration = { ...cfg.calibration, top_y: top, bottom_y: bottom };
    rt.setParserConfig(cfg);
  }

  function toggle(k: 'mirror_frame' | 'swap_hands' | 'invert_tilt') {
    const cfg = settings.s.parser;
    cfg.calibration = { ...cfg.calibration, [k]: !cfg.calibration[k] };
    rt.setParserConfig(cfg);
  }

  function reset() {
    top = 0.15;
    bottom = 0.85;
    apply();
    startPhase('top');
  }

  $effect(() => {
    startPhase('top');
    return () => clearInterval(timer);
  });
</script>

<div class="cal col">
  <h2>Calibrate</h2>
  {#if phase === 'top'}
    <p>Raise your <b>right hand</b> as high as you comfortably play and hold it there.</p>
  {:else if phase === 'bottom'}
    <p>Now lower it to where silence should be and hold.</p>
  {:else}
    <p>Done. Raise and lower the right hand: the volume bar should follow the full range.</p>
  {/if}
  <div class="meter">
    <div class="range" style:top="{top * 100}%" style:height="{(bottom - top) * 100}%"></div>
    {#if hand()}
      <div class="wrist" style:top="{hand()!.wrist[1] * 100}%"></div>
    {/if}
    {#if phase !== 'check'}
      <div class="prog" style:width="{progress * 100}%"></div>
    {/if}
  </div>
  <div class="vol"><i style:width="{rt.live.volume * 100}%"></i></div>
  <div class="row wrap">
    <label class="row"><input type="checkbox" checked={settings.s.parser.calibration.mirror_frame} onchange={() => toggle('mirror_frame')} /> Camera image is mirrored</label>
    <label class="row"><input type="checkbox" checked={settings.s.parser.calibration.swap_hands} onchange={() => toggle('swap_hands')} /> Swap left/right</label>
    <label class="row"><input type="checkbox" checked={settings.s.parser.calibration.invert_tilt} onchange={() => toggle('invert_tilt')} /> Invert tilt</label>
  </div>
  <p class="hint">Hands detected: {rt.left.present ? 'left' : ''} {rt.right.present ? 'right' : ''} {!rt.left.present && !rt.right.present ? 'none yet' : ''}</p>
  <div class="row" style="justify-content:flex-end">
    <button onclick={reset}>Redo</button>
    {#if quick}
      <button class="primary" onclick={onDone} disabled={phase !== 'check'}>Play</button>
    {:else}
      <button class="primary" onclick={onDone}>Done</button>
    {/if}
  </div>
</div>

<style>
  .cal {
    text-align: left;
    gap: 10px;
  }
  .meter {
    position: relative;
    height: 160px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
    overflow: hidden;
  }
  .range {
    position: absolute;
    left: 0;
    right: 0;
    background: var(--accent-soft);
    border-top: 1px solid var(--accent);
    border-bottom: 1px solid var(--accent);
  }
  .wrist {
    position: absolute;
    left: 0;
    right: 0;
    height: 2px;
    background: #fff;
    box-shadow: 0 0 10px #fff;
  }
  .prog {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 3px;
    background: var(--ok);
  }
  .vol {
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
  }
  .vol i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 80ms linear;
  }
  .wrap {
    flex-wrap: wrap;
    gap: 12px;
    font-size: 12px;
  }
  .hint {
    font-size: 12px;
    color: var(--text-faint);
  }
</style>
