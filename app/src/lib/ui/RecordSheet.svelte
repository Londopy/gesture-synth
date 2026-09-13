<script lang="ts">
  // Video recorder panel: source (scene / clear camera), engine audio, optional
  // mic with device + gain + meter, format, start/stop with timer, preview, save.
  import { onDestroy } from 'svelte';
  import { rt } from '../state/engine.svelte';
  import { ui } from '../state/ui.svelte';
  import { settings } from '../state/settings.svelte';
  import { VideoRecorder, saveRecording } from '../export/recorder';
  import { canExportMp4 } from '../platform';

  let { canvas }: { canvas: () => HTMLCanvasElement | null } = $props();

  const rec = new VideoRecorder();
  let phase = $state<'idle' | 'starting' | 'recording' | 'stopping' | 'saving'>('idle');
  let elapsed = $state(0);
  let level = $state(0);
  let mics = $state<MediaDeviceInfo[]>([]);
  let result = $state<{ blob: Blob; url: string } | null>(null);
  let error = $state('');
  let name = $state(rt.sessionName);
  let timer = 0;
  let meterRaf = 0;

  $effect(() => {
    VideoRecorder.listMics().then((m) => (mics = m));
  });

  function fmt(ms: number) {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  async function start() {
    error = '';
    if (result) {
      URL.revokeObjectURL(result.url);
      result = null;
    }
    phase = 'starting';
    try {
      if (settings.s.recSource === 'camera' && settings.s.viewMode !== 'clear') {
        // recording the raw camera; show it on screen too so what you see is what you get
        settings.s.viewMode = 'clear';
      }
      await rec.start({ source: settings.s.recSource, canvas: canvas(), fps: settings.s.recFps, mic: settings.s.recMic, micDeviceId: settings.s.recMicDeviceId, micGain: settings.s.recMicGain });
      phase = 'recording';
      timer = window.setInterval(() => (elapsed = rec.elapsedMs), 250);
      const meter = () => {
        meterRaf = requestAnimationFrame(meter);
        level = rec.level();
      };
      meter();
    } catch (e: any) {
      phase = 'idle';
      error = e?.name === 'NotAllowedError' ? 'Microphone permission was denied.' : (e?.message ?? String(e));
    }
  }

  async function stop() {
    phase = 'stopping';
    clearInterval(timer);
    cancelAnimationFrame(meterRaf);
    try {
      const blob = await rec.stop();
      result = { blob, url: URL.createObjectURL(blob) };
    } catch (e: any) {
      error = e.message;
    }
    phase = 'idle';
    level = 0;
  }

  async function save() {
    if (!result) return;
    phase = 'saving';
    try {
      await saveRecording(result.blob, settings.s.recFormat, name);
      ui.toast('Recording saved', 'ok');
    } catch (e: any) {
      ui.toast(`Save failed: ${e.message}`, 'error', 6000);
    }
    phase = 'idle';
  }

  onDestroy(() => {
    clearInterval(timer);
    cancelAnimationFrame(meterRaf);
    if (rec.state === 'recording') void rec.stop();
    if (result) URL.revokeObjectURL(result.url);
  });

  const nativeAudio = $derived(rt.usingNative);
</script>

<div class="sheet glass strong fade-in" role="dialog" aria-label="Record video">
  <div class="row" style="justify-content:space-between">
    <h2 style="margin:0">Record</h2>
    <button class="ghost" onclick={() => (ui.recordSheet = false)} aria-label="Close" disabled={phase === 'recording'}>×</button>
  </div>

  <div class="grid">
    <label class="col">
      <span class="label">Picture</span>
      <select bind:value={settings.s.recSource} disabled={phase !== 'idle'}>
        <option value="scene">Scene (what is on screen, incl. clear camera view)</option>
        <option value="camera">Camera only (raw feed, no overlays)</option>
      </select>
    </label>
    <label class="col">
      <span class="label">Frame rate</span>
      <select bind:value={settings.s.recFps} disabled={phase !== 'idle'}><option value={24}>24</option><option value={30}>30</option><option value={60}>60</option></select>
    </label>
    <label class="col">
      <span class="label">Format</span>
      <select bind:value={settings.s.recFormat}>
        <option value="webm">webm (instant)</option>
        {#if canExportMp4}<option value="mp4">mp4 (converted on save)</option>{/if}
      </select>
    </label>
  </div>

  <div class="audio col">
    <span class="label">Sound</span>
    <div class="row wrap">
      <span class="chip on">instrument + loops</span>
      <span class="chip">metronome excluded</span>
      <label class="row"><input type="checkbox" bind:checked={settings.s.recMic} disabled={phase !== 'idle'} /> microphone (sing or talk over it)</label>
    </div>
    {#if settings.s.recMic}
      <div class="row wrap">
        <select bind:value={settings.s.recMicDeviceId} disabled={phase !== 'idle'} style="flex:1">
          <option value="">Default microphone</option>
          {#each mics as m}<option value={m.deviceId}>{m.label || m.deviceId.slice(0, 8)}</option>{/each}
        </select>
        <label class="row small">gain <input type="range" min="0" max="2" step="0.05" bind:value={settings.s.recMicGain} oninput={() => rec.setMicGain(settings.s.recMicGain)} style="width:110px" /> {settings.s.recMicGain.toFixed(2)}</label>
      </div>
      <p class="hint">Use headphones: with speakers the microphone picks the instrument up a second time.</p>
    {/if}
    {#if nativeAudio}
      <p class="hint warn">Desktop native audio is on, so the instrument cannot be captured from this window. Turn off "Native audio thread" in Settings &gt; Audio (then reload) to record the instrument, or record the mic only.</p>
    {/if}
    <div class="meter"><i style:width="{Math.min(100, level * 100)}%" class:hot={level > 0.9}></i></div>
  </div>

  <div class="row" style="justify-content:space-between">
    <div class="row">
      {#if phase === 'recording'}
        <button class="stop" onclick={stop}><span class="sq"></span> Stop</button>
        <span class="time num">{fmt(elapsed)}</span>
        <span class="live">REC</span>
      {:else}
        <button class="primary go" onclick={start} disabled={phase !== 'idle' || rt.phase !== 'ready'}><span class="dot"></span> {phase === 'starting' ? 'Starting…' : 'Start recording'}</button>
      {/if}
    </div>
    <label class="row small">name <input type="text" bind:value={name} style="width:160px" /></label>
  </div>
  {#if error}<p class="err">{error}</p>{/if}

  {#if result}
    <div class="col">
      <video class="preview" src={result.url} controls playsinline></video>
      <div class="row" style="justify-content:space-between">
        <span class="small">{(result.blob.size / 1e6).toFixed(1)} MB · {result.blob.type || 'video/webm'} · sound: {rec.audioSources.join(' + ') || 'none'}</span>
        <div class="row">
          <button onclick={() => { URL.revokeObjectURL(result!.url); result = null; }}>Discard</button>
          <button class="primary" onclick={save} disabled={phase === 'saving'}>{phase === 'saving' ? 'Saving…' : `Save .${settings.s.recFormat}`}</button>
        </div>
      </div>
    </div>
  {/if}
  <p class="hint">Tip: press <kbd>C</kbd> for the clear camera view and <kbd>F</kbd> to hide the chrome before you press start. The recording follows the window size.</p>
</div>

<style>
  .sheet {
    position: absolute;
    right: 14px;
    top: 90px;
    width: min(560px, 92vw);
    padding: 16px 18px;
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .grid {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: 10px;
  }
  select {
    font-size: 12px;
    padding: 5px 8px;
  }
  .audio {
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    gap: 8px;
  }
  .wrap {
    flex-wrap: wrap;
  }
  .small {
    font-size: 12px;
    color: var(--text-dim);
  }
  .hint {
    font-size: 12px;
    color: var(--text-faint);
    margin: 0;
  }
  .hint.warn {
    color: var(--warn);
  }
  .meter {
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }
  .meter i {
    display: block;
    height: 100%;
    background: var(--ok);
    transition: width 60ms linear;
  }
  .meter i.hot {
    background: var(--danger);
  }
  .go .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--danger);
    display: inline-block;
    margin-right: 6px;
  }
  .stop {
    border-color: var(--danger);
  }
  .stop .sq {
    width: 10px;
    height: 10px;
    background: var(--danger);
    display: inline-block;
    margin-right: 6px;
    border-radius: 2px;
  }
  .time {
    font-family: var(--font-display);
    font-size: 24px;
  }
  .live {
    font-size: 11px;
    letter-spacing: 0.15em;
    color: var(--danger);
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    to {
      opacity: 0.3;
    }
  }
  .err {
    color: var(--danger);
    font-size: 12px;
    margin: 0;
  }
  .preview {
    width: 100%;
    border-radius: 10px;
    background: #000;
    max-height: 280px;
  }
</style>
