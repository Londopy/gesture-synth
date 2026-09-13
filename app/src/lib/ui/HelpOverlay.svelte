<script lang="ts">
  // Help (spec 9): shortcut sheet, gesture cheat sheet with animated hands,
  // troubleshooting, re-run tour.
  import { ui } from '../state/ui.svelte';
  import { settings } from '../state/settings.svelte';
  import { ACTION_LABELS, comboLabel, type Action } from '../keys';
  import HandDiagram from './HandDiagram.svelte';
  import { leftFingersFor, rightFingersFor } from '../learn/songs';
  import { ROMAN } from '../music';
  import { rt } from '../state/engine.svelte';
  import { EGG_IDS, EGG_INFO } from '../eggs/detect';
  import MadeBy from './MadeBy.svelte';

  let tab = $state<'gestures' | 'shortcuts' | 'trouble' | 'secrets'>('gestures');
  const found = $derived(settings.s.eggsFound);
  const shapeLabels = ['Triad', '1st inversion', 'Seventh', 'Dom7 / m7b5'];
</script>

<div class="backdrop" role="presentation" onclick={() => (ui.help = false)}>
  <div class="sheet glass strong fade-in" role="dialog" aria-modal="true" aria-label="Help" onclick={(e) => e.stopPropagation()}>
    <div class="row head">
      <div class="seg">
        <button class:active={tab === 'gestures'} onclick={() => (tab = 'gestures')}>Gestures</button>
        <button class:active={tab === 'shortcuts'} onclick={() => (tab = 'shortcuts')}>Shortcuts</button>
        <button class:active={tab === 'trouble'} onclick={() => (tab = 'trouble')}>Troubleshooting</button>
        <button class:active={tab === 'secrets'} onclick={() => (tab = 'secrets')}>Secrets {found.length ? `${found.length}/${EGG_IDS.length}` : ''}</button>
      </div>
      <div class="row">
        <MadeBy />
        <button onclick={() => ui.startTour()}>Re-run tour</button>
        <button class="ghost" onclick={() => (ui.help = false)} aria-label="Close">×</button>
      </div>
    </div>

    {#if tab === 'gestures'}
      <div class="content">
        <h3>Left hand: chord degree (tilt inward = major, outward = minor, fist = mute)</h3>
        <div class="hands">
          {#each ROMAN as r, i}
            <HandDiagram fingers={leftFingersFor(i + 1)} right={false} tilt={20} size={84} label={r} />
          {/each}
          <HandDiagram fingers={[false, false, false, false, false]} right={false} size={84} label="mute" />
        </div>
        <h3>Right hand: shape (thumb in = -1 octave, out = +1), tilt = filter, height = volume</h3>
        <div class="hands">
          {#each shapeLabels as l, i}
            <HandDiagram fingers={rightFingersFor(i as any)} tilt={0} size={84} label={l} />
          {/each}
          <HandDiagram fingers={[true, true, false, false, false]} size={84} label="+1 octave" />
          <HandDiagram fingers={[false, true, false, false, false]} tilt={-35} to={{ tilt: 35 }} size={84} label="filter" />
        </div>
        <h3>Extras</h3>
        <ul>
          <li><b>Flick</b> the left hand toward the camera: bass note of the chord.</li>
          <li><b>Pinch</b> thumb to index on the right hand: toggle arpeggiator (height then sets the rate).</li>
          <li><b>Both fists</b> touching, then rotate: change key around the circle of fifths (one step per 30°).</li>
          <li><b>Hold still</b> for 2 s: latch, the chord keeps ringing when your hands leave. Any new shape unlatches.</li>
          <li><b>Theremin</b> (Tab): right height = pitch, left height = volume, right tilt = filter, left tilt = vibrato.</li>
        </ul>
      </div>
    {:else if tab === 'shortcuts'}
      <div class="content shortcuts">
        {#each Object.entries(ACTION_LABELS) as [a, label]}
          <div class="sc"><kbd>{comboLabel(settings.s.shortcuts[a as Action] ?? '')}</kbd><span>{label}</span></div>
        {/each}
        <div class="sc"><kbd>?</kbd><span>This help</span></div>
        <p class="hint">Edit shortcuts in Settings.</p>
      </div>
    {:else if tab === 'secrets'}
      <div class="content">
        <p>There are {EGG_IDS.length} hidden gestures. Found ones show their name; the rest only give a hint. They never change the music.</p>
        <div class="secrets">
          {#each EGG_IDS as id}
            {@const got = found.includes(id)}
            <div class="secret" class:got>
              <span class="semoji">{got ? EGG_INFO[id].emoji : '?'}</span>
              <div class="col" style="gap:2px">
                <b>{got ? EGG_INFO[id].name : 'Not found yet'}</b>
                <span class="shint">{EGG_INFO[id].hint}</span>
              </div>
            </div>
          {/each}
        </div>
        <label class="row" style="margin-top:10px"><input type="checkbox" bind:checked={settings.s.eggsEnabled} /> Secrets enabled (turn off for a strict performance)</label>
      </div>
    {:else}
      <div class="content">
        <h3>Camera</h3>
        <ul>
          <li>No camera prompt: check the site permission (lock icon in the address bar) or the app's camera permission in the OS.</li>
          <li>Hands flicker or swap: face the camera, keep hands side by side, add light from the front. Current confidence: {Math.round(rt.live.confidence * 100)}%.</li>
          <li>Left and right reversed: Settings → Calibration → "Swap left/right" (or "Camera image is mirrored").</li>
          <li>Tilt feels backwards: Settings → Calibration → "Invert tilt".</li>
        </ul>
        <h3>Latency</h3>
        <ul>
          <li>Measured output latency: {rt.latencyMs} ms. Inference: {rt.inferenceMs} ms. Camera: {rt.trackingFps} fps.</li>
          <li>Bluetooth headphones add 100+ ms. Use wired output or speakers.</li>
          <li>Lower "Stable time" in Settings for faster chord changes (at the cost of occasional flicker). Quantize-to-beat hides lag while the transport runs.</li>
          <li>The desktop app uses a native audio thread for the lowest latency and adds MIDI out.</li>
        </ul>
        <h3>Audio</h3>
        <ul>
          <li>No sound: the page needs one click to start audio; check the volume bar in the HUD moves with your right hand.</li>
          <li>Crackles: close other tabs using audio, or raise the buffer size (desktop Settings).</li>
          <li>Stuck notes: press Esc (panic).</li>
        </ul>
      </div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: grid;
    place-items: center;
    z-index: 60;
  }
  .sheet {
    width: min(860px, 94vw);
    max-height: 86vh;
    padding: 16px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .head {
    justify-content: space-between;
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
  .content {
    overflow: auto;
    padding-right: 6px;
  }
  .hands {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    margin-bottom: 14px;
  }
  ul {
    margin: 0 0 10px;
    padding-left: 18px;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.6;
  }
  .shortcuts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 18px;
  }
  .sc {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--text-dim);
  }
  .sc kbd {
    min-width: 54px;
  }
  .secrets {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .secret {
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 8px 12px;
    opacity: 0.7;
  }
  .secret.got {
    opacity: 1;
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .semoji {
    font-size: 28px;
    width: 40px;
    text-align: center;
  }
  .shint {
    font-size: 12px;
    color: var(--text-dim);
  }
  .hint {
    grid-column: 1 / -1;
    font-size: 12px;
    color: var(--text-faint);
  }
</style>
