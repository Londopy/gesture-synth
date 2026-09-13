<script lang="ts">
  // Start screen: the first click starts the AudioContext (autoplay policy),
  // then asks for the camera. Short first-run flow (spec 9.5): permission,
  // 5 second calibration, play. Full tour offered, not forced.
  import { rt } from '../state/engine.svelte';
  import { settings } from '../state/settings.svelte';
  import { ui } from '../state/ui.svelte';
  import { flags, describePlatform } from '../platform';
  import Calibration from './Calibration.svelte';

  let step = $state<'start' | 'calibrate' | 'done'>('start');
  let openDesktop = $state(false);

  async function start() {
    await rt.start();
    if (rt.phase === 'ready') {
      if (rt.cameraFailed) {
        ui.toast(rt.trackingStatus === 'denied' ? 'Camera blocked. You can still play with the keyboard and loops; allow the camera and use Settings > Camera to retry.' : 'Camera unavailable: ' + rt.error, 'warn', 8000);
        settings.s.firstRunDone = true;
        step = 'done';
        return;
      }
      step = settings.s.firstRunDone ? 'done' : 'calibrate';
    }
  }

  function finishCalibration() {
    settings.s.firstRunDone = true;
    step = 'done';
    if (!settings.s.tourDone) ui.startTour();
  }

  function retryCamera() {
    rt.phase = 'idle';
    void start();
  }

  const desktopLink = $derived(`gsyn://${location.pathname.replace(/^\//, '')}${location.search}`);
</script>

{#if step !== 'done'}
  <div class="landing">
    <div class="panel glass strong fade-in">
      {#if step === 'start'}
        <div class="logo display">GESTURE SYNTH</div>
        <p class="tag">Play chords with your hands. Loop them. Watch the harmony.</p>
        {#if rt.phase === 'idle' || rt.phase === 'error'}
          <button class="primary big" onclick={start}>Start</button>
          <p class="hint">Uses your camera and speakers. Nothing leaves this device.</p>
          {#if rt.phase === 'error'}
            <p class="err">{rt.trackingStatus === 'denied' ? 'Camera permission was denied. Allow the camera in your browser settings, then retry.' : rt.error}</p>
            <button onclick={retryCamera}>Retry</button>
          {/if}
        {:else}
          <div class="progress">
            <span class:on={rt.phase !== 'audio'}>audio engine</span>
            <span class:on={rt.phase === 'ready'}>camera</span>
          </div>
        {/if}
        <div class="platform num">{describePlatform()}</div>
        {#if !flags.isTauri && !flags.isMobile}
          <button class="ghost small" onclick={() => (openDesktop = !openDesktop)}>Open in desktop app</button>
          {#if openDesktop}
            <p class="hint">If Gesture Synth is installed, this link opens it with the same content for lower latency and MIDI: <a href={desktopLink}>{desktopLink}</a></p>
          {/if}
        {/if}
      {:else if step === 'calibrate'}
        <Calibration quick onDone={finishCalibration} />
      {/if}
    </div>
  </div>
{/if}

<style>
  .landing {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    z-index: 40;
    background: radial-gradient(ellipse at center, rgba(20, 24, 36, 0.4), rgba(11, 13, 18, 0.85));
  }
  .panel {
    width: min(520px, 92vw);
    padding: 36px 34px;
    text-align: center;
  }
  .logo {
    font-size: 64px;
    letter-spacing: 0.08em;
    color: #fff;
    text-shadow: 0 0 40px var(--accent-glow);
  }
  .tag {
    font-size: 15px;
    margin-bottom: 26px;
  }
  .big {
    font-size: 18px;
    padding: 14px 40px;
    border-radius: 999px;
  }
  .hint {
    font-size: 12px;
    color: var(--text-faint);
    margin-top: 14px;
  }
  .err {
    color: var(--danger);
    font-size: 13px;
  }
  .progress {
    display: flex;
    justify-content: center;
    gap: 14px;
    margin: 12px 0;
    font-size: 13px;
    color: var(--text-faint);
  }
  .progress .on {
    color: var(--ok);
  }
  .platform {
    margin-top: 22px;
    font-size: 11px;
    color: var(--text-faint);
    letter-spacing: 0.06em;
  }
  .small {
    font-size: 12px;
    margin-top: 10px;
    color: var(--text-dim);
  }
</style>
