<script lang="ts">
  // HUD (spec 8 layer 8): chord name, key, BPM, bar:beat, mode, confidence,
  // latency. Big thin type; fades after 2 s of no change in performance view.
  import { rt } from '../state/engine.svelte';
  import { settings } from '../state/settings.svelte';
  import { ui } from '../state/ui.svelte';
  import { PITCH_NAMES, PITCH_NAMES_FLAT, noteName } from '../music';

  const keyName = $derived((settings.s.flatNames ? PITCH_NAMES_FLAT : PITCH_NAMES)[rt.live.key]);
  const modeLabel = $derived(rt.live.theremin ? 'Theremin' : rt.live.minor ? 'minor' : 'major');
  const chord = $derived(rt.live.theremin ? noteName(Math.round(69 + 12 * Math.log2(Math.max(1, rt.live.thereminHz) / 440))) : rt.chordName || (rt.live.degree === 0 ? '' : '·'));
  const lowLight = $derived(rt.phase === 'ready' && rt.trackingStatus === 'running' && rt.live.confidence < 0.6 && (rt.left.present || rt.right.present));
  let lastSig = '';
  $effect(() => {
    const sig = `${rt.chordName}|${rt.live.key}|${rt.position.bar}|${rt.position.beat}|${rt.live.theremin}|${rt.position.bpm}`;
    if (sig !== lastSig) {
      lastSig = sig;
      ui.pokeHud();
    }
  });
  const visible = $derived(!ui.performance || ui.hudVisible);
</script>

{#if settings.s.showHud}
  <div class="hud" class:hidden={!visible} data-tour="hud" aria-live="polite">
    <div class="chord display" class:minor={rt.live.quality === 1} class:latched={rt.live.latched}>
      {chord}
      {#if rt.absChordName && !rt.live.theremin}<span class="abs">{rt.absChordName}</span>{/if}
    </div>
    <div class="meta num">
      <span class="key">{keyName} {modeLabel}</span>
      <span class="sep">·</span>
      <span>{Math.round(rt.position.bpm)} BPM</span>
      <span class="sep">·</span>
      <span class="pos">{rt.position.bar}:{rt.position.beat}</span>
      {#if rt.live.latched}<span class="tag">latched</span>{/if}
      {#if rt.live.arp}<span class="tag">arp</span>{/if}
      {#if rt.live.octave !== 0}<span class="tag">{rt.live.octave > 0 ? '+1 oct' : '-1 oct'}</span>{/if}
    </div>
    <div class="bars">
      <div class="bar" title="tracking confidence">
        <span class="label">track</span>
        <i style:width="{Math.round(rt.live.confidence * 100)}%" class:warn={lowLight}></i>
      </div>
      <div class="bar" title="filter cutoff">
        <span class="label">filter</span>
        <i style:width="{Math.round(rt.live.cutoff * 100)}%"></i>
      </div>
      <div class="bar" title="volume">
        <span class="label">vol</span>
        <i style:width="{Math.round((rt.live.theremin ? rt.live.thereminVol : rt.live.volume) * 100)}%"></i>
      </div>
    </div>
    {#if lowLight}
      <div class="tip">Low tracking confidence: try more light on your hands.</div>
    {/if}
    {#if rt.phase === 'ready'}
      <div class="lat num">{rt.latencyMs} ms out · {rt.inferenceMs} ms inference · {rt.trackingFps} fps cam</div>
    {/if}
  </div>
{/if}

{#if rt.position.countIn != null}
  <div class="countin display">{rt.position.countIn}</div>
{/if}

<style>
  .hud {
    position: absolute;
    left: 50%;
    top: 14%;
    transform: translateX(-50%);
    text-align: center;
    pointer-events: none;
    transition: opacity 600ms var(--ease);
    text-shadow: 0 2px 24px rgba(0, 0, 0, 0.6);
    min-width: 280px;
  }
  .hud.hidden {
    opacity: 0;
  }
  .chord {
    font-size: clamp(48px, 8vw, 120px);
    color: #fff;
    letter-spacing: 0.04em;
    line-height: 1;
    min-height: 0.9em;
    transition: color var(--dur) var(--ease);
    text-shadow: 0 0 40px var(--accent-glow);
  }
  .chord.minor {
    color: #cfd6ff;
  }
  .chord.latched {
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 10px;
    text-decoration-color: var(--accent);
  }
  .abs {
    display: block;
    font-family: var(--font-ui);
    font-size: 14px;
    letter-spacing: 0.12em;
    color: var(--text-dim);
    margin-top: 4px;
    text-transform: uppercase;
  }
  .meta {
    margin-top: 8px;
    font-size: 15px;
    font-weight: 300;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }
  .key {
    color: var(--text);
  }
  .sep {
    margin: 0 8px;
    color: var(--text-faint);
  }
  .tag {
    margin-left: 8px;
    font-size: 11px;
    padding: 1px 7px;
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: #fff;
    background: var(--accent-soft);
  }
  .bars {
    display: flex;
    gap: 14px;
    justify-content: center;
    margin-top: 10px;
  }
  .bar {
    width: 90px;
    height: 3px;
    background: rgba(255, 255, 255, 0.12);
    border-radius: 2px;
    position: relative;
    overflow: visible;
  }
  .bar .label {
    position: absolute;
    top: 6px;
    left: 0;
    font-size: 9px;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 120ms linear;
    box-shadow: 0 0 8px var(--accent-glow);
  }
  .bar i.warn {
    background: var(--warn);
  }
  .tip {
    margin-top: 22px;
    font-size: 12px;
    color: var(--warn);
  }
  .lat {
    margin-top: 22px;
    font-size: 10px;
    color: var(--text-faint);
  }
  .countin {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: clamp(160px, 34vh, 420px);
    color: #fff;
    pointer-events: none;
    text-shadow: 0 0 80px var(--accent-glow);
    animation: pop 600ms var(--ease) both;
  }
  @keyframes pop {
    from {
      transform: scale(1.25);
      opacity: 0.2;
    }
    to {
      transform: scale(1);
      opacity: 0.95;
    }
  }
</style>
