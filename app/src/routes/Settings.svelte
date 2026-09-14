<script lang="ts">
  // Settings page (spec 9): audio device, buffer size, MIDI out, camera device,
  // mirror, calibration, hand scheme defaults, shortcuts editor, reduced motion,
  // telemetry (off by default), data folder / storage usage + clear.
  import { settings, DEFAULT_SHORTCUTS } from '../lib/state/settings.svelte';
  import { rt } from '../lib/state/engine.svelte';
  import { ui } from '../lib/state/ui.svelte';
  import { midiOut } from '../lib/audio/midi';
  import { Tracking } from '../lib/tracking/mediapipe';
  import { store } from '../lib/storage/store';
  import { flags } from '../lib/platform';
  import { ACTION_LABELS, comboLabel, comboOf, type Action } from '../lib/keys';
  import Calibration from '../lib/ui/Calibration.svelte';
  import { achievements } from '../lib/achievements/store.svelte';
  import MadeBy from '../lib/ui/MadeBy.svelte';

  let cameras = $state<MediaDeviceInfo[]>([]);
  let audioOuts = $state<{ id: string; name: string }[]>([]);
  let usage = $state<{ used: number; quota: number }>({ used: 0, quota: 0 });
  let calibrating = $state(false);
  let recording = $state<Action | null>(null);

  $effect(() => {
    Tracking.listCameras().then((c) => (cameras = c));
    store.usage().then((u) => (usage = u));
    if (flags.isTauri) {
      import('@tauri-apps/api/core').then(({ invoke }) => invoke('native_audio_devices').then((d: any) => (audioOuts = d)).catch(() => {}));
    }
    if (settings.s.midiOut && midiOut.available) midiOut.init();
  });

  async function toggleMidi() {
    settings.s.midiOut = !settings.s.midiOut;
    if (settings.s.midiOut) {
      const ok = await midiOut.init();
      if (!ok) ui.toast(midiOut.error || 'Web MIDI not available', 'warn');
      midiOut.enabled = true;
    } else midiOut.enabled = false;
    rt.cmd({ cmd: 'set_midi_enabled', on: settings.s.midiOut });
  }
  function setStable(v: number) {
    rt.setParserConfig({ ...settings.s.parser, stable_ms: v });
  }
  function setLatch(v: number) {
    rt.setParserConfig({ ...settings.s.parser, latch_hold_ms: v });
  }
  function setMinorFour(v: string) {
    rt.setParserConfig({ ...settings.s.parser, voicing: { ...settings.s.parser.voicing, minor_four_finger: v as any } });
  }
  function toggleOpen() {
    rt.setParserConfig({ ...settings.s.parser, voicing: { ...settings.s.parser.voicing, open_voicing: !settings.s.parser.voicing.open_voicing } });
  }
  function setQuantize(k: 'quantize' | 'quantizeInput' | 'recordMode', v: string) {
    (settings.s as any)[k] = v;
    rt.applySettingsToEngine();
  }
  function keyRecord(e: KeyboardEvent) {
    if (!recording) return;
    e.preventDefault();
    if (e.key === 'Escape') return (recording = null);
    settings.s.shortcuts = { ...settings.s.shortcuts, [recording]: comboOf(e) };
    recording = null;
  }
  async function clearStorage() {
    if (await ui.ask('Clear storage', 'Delete all saved sessions, songs, presets and themes on this device?', 'Clear', true)) {
      await store.clear();
      usage = await store.usage();
    }
  }
  async function openDataFolder() {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_data_folder');
  }
  async function restartAudio() {
    settings.s.nativeAudio = !settings.s.nativeAudio;
    ui.toast('Reload the app to switch the audio backend', 'info');
  }
  const fmt = (b: number) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' kB');
</script>

<svelte:window onkeydown={keyRecord} />

<div class="page">
  <div class="page-inner">
    <h2>Settings</h2>
    <div class="grid2">
      <section class="glass card col">
        <h3>Audio</h3>
        <div class="kv"><span>Backend</span><span>{rt.usingNative ? 'native (cpal)' : `AudioWorklet${rt.usingSAB ? ' + SharedArrayBuffer' : ' (postMessage)'}`}</span></div>
        <div class="kv"><span>Device</span><span>{rt.audioDevice || '—'}</span></div>
        <div class="kv"><span>Output latency</span><span class="num">{rt.latencyMs} ms</span></div>
        {#if flags.isTauri}
          <label class="col"><span class="label">Output device</span>
            <select bind:value={settings.s.audioDeviceId}><option value="">Default</option>{#each audioOuts as d}<option value={d.id}>{d.name}</option>{/each}</select></label>
          <label class="col"><span class="label">Buffer size</span>
            <select bind:value={settings.s.bufferSize}>{#each [64, 128, 256, 512] as b}<option value={b}>{b} frames ({((b / 48) | 0)} ms)</option>{/each}</select></label>
          <label class="row"><input type="checkbox" checked={settings.s.nativeAudio} onchange={restartAudio} /> Native audio thread (uncheck to use the webview AudioWorklet)</label>
          <p class="hint">Device and buffer changes apply on the next launch.</p>
        {/if}
        <label class="row"><input type="checkbox" bind:checked={settings.s.metronomeMonitor} onchange={() => rt.worklet?.setMetronomeMonitor(settings.s.metronomeMonitor)} /> Hear the metronome (always excluded from recordings)</label>
      </section>

      <section class="glass card col">
        <h3>MIDI out</h3>
        {#if midiOut.available || flags.isTauri}
          <label class="row"><input type="checkbox" checked={settings.s.midiOut} onchange={toggleMidi} /> Send MIDI (chords → notes, cutoff → CC74, volume → CC7, pan → CC10)</label>
          {#if midiOut.outputs.length}
            <label class="col"><span class="label">Port</span>
              <select bind:value={settings.s.midiPortId} onchange={() => midiOut.select(settings.s.midiPortId)}>{#each midiOut.outputs as o}<option value={o.id}>{o.name}</option>{/each}</select></label>
          {:else if settings.s.midiOut}<p class="hint">No MIDI outputs found.</p>{/if}
          <label class="col"><span class="label">Live channel</span><select bind:value={settings.s.midiLiveChannel}>{#each Array(16) as _, i}<option value={i + 1}>{i + 1}</option>{/each}</select></label>
          <p class="hint">Loop tracks use their own channel (mixer).</p>
        {:else}
          <p class="hint">Web MIDI is not available in this browser (Safari). Use the desktop app or Chrome/Edge.</p>
        {/if}
      </section>

      <section class="glass card col">
        <h3>Camera</h3>
        <label class="col"><span class="label">Device</span>
          <select value={settings.s.cameraDeviceId} onchange={(e) => rt.switchCamera((e.target as HTMLSelectElement).value)}>
            <option value="">Default</option>{#each cameras as c}<option value={c.deviceId}>{c.label || c.deviceId.slice(0, 8)}</option>{/each}
          </select></label>
        {#if rt.cameraFailed || rt.trackingStatus !== 'running'}<button class="primary" onclick={() => rt.startCamera().then(() => (rt.cameraFailed = false)).catch((e) => ui.toast(e.message, 'error'))}>Start camera</button>{/if}
        <div class="kv"><span>Tracking</span><span>{rt.trackingStatus} · {rt.trackingFps} fps · {rt.inferenceMs} ms</span></div>
        <div class="row wrap">
          <button onclick={() => (calibrating = !calibrating)}>{calibrating ? 'Close calibration' : 'Calibrate'}</button>
          <label class="row">View
            <select bind:value={settings.s.viewMode}><option value="performance">performance (no feed)</option><option value="practice">practice (tinted feed)</option><option value="clear">clear camera</option></select></label>
        </div>
        {#if calibrating}<div class="calbox"><Calibration onDone={() => (calibrating = false)} /></div>{/if}
      </section>

      <section class="glass card col">
        <h3>Gestures</h3>
        <label class="col"><span class="label">Stable time before a chord change: {settings.s.parser.stable_ms} ms</span>
          <input type="range" min="30" max="250" step="5" value={settings.s.parser.stable_ms} oninput={(e) => setStable(Number((e.target as HTMLInputElement).value))} /></label>
        <label class="col"><span class="label">Latch after holding still: {(settings.s.parser.latch_hold_ms / 1000).toFixed(1)} s</span>
          <input type="range" min="500" max="5000" step="100" value={settings.s.parser.latch_hold_ms} oninput={(e) => setLatch(Number((e.target as HTMLInputElement).value))} /></label>
        <label class="col"><span class="label">Four fingers on a minor chord</span>
          <select value={settings.s.parser.voicing.minor_four_finger} onchange={(e) => setMinorFour((e.target as HTMLSelectElement).value)}><option value="half_dim7">m7b5 (half-diminished)</option><option value="dim7">dim7</option></select></label>
        <label class="row"><input type="checkbox" checked={settings.s.parser.voicing.open_voicing} onchange={toggleOpen} /> Open voicing (3rd and 7th up an octave)</label>
      </section>

      <section class="glass card col">
        <h3>Loop pedal</h3>
        <label class="col"><span class="label">Quantize chord onsets</span>
          <select value={settings.s.quantize} onchange={(e) => setQuantize('quantize', (e.target as HTMLSelectElement).value)}><option value="off">off</option><option value="sixteenth">16th</option><option value="eighth">8th</option><option value="triplet">triplet</option></select></label>
        <label class="col"><span class="label">Quantize live input</span>
          <select value={settings.s.quantizeInput} onchange={(e) => setQuantize('quantizeInput', (e.target as HTMLSelectElement).value)}><option value="recording">while recording</option><option value="always">always</option><option value="off">off</option></select></label>
        <label class="col"><span class="label">Record mode</span>
          <select value={settings.s.recordMode} onchange={(e) => setQuantize('recordMode', (e.target as HTMLSelectElement).value)}><option value="overdub">overdub (merge)</option><option value="replace">replace</option></select></label>
        <label class="row"><input type="checkbox" bind:checked={settings.s.loopRecord} onchange={() => rt.applySettingsToEngine()} /> Loop record (keep overdubbing after the loop ends)</label>
        <label class="row"><input type="checkbox" bind:checked={settings.s.wrapAtLoopEnd} onchange={() => rt.applySettingsToEngine()} /> Chord sounding at loop end continues from bar 1</label>
        <label class="col"><span class="label">Count-in bars</span><select bind:value={settings.s.countInBars} onchange={() => rt.applySettingsToEngine()}>{#each [0, 1, 2] as b}<option value={b}>{b}</option>{/each}</select></label>
      </section>

      <section class="glass card col">
        <h3>Shortcuts</h3>
        <div class="shortcuts">
          {#each Object.entries(ACTION_LABELS) as [a, label]}
            <div class="sc">
              <span>{label}</span>
              <button class:active={recording === a} onclick={() => (recording = a as Action)}>{recording === a ? 'press a key…' : comboLabel(settings.s.shortcuts[a as Action] ?? '')}</button>
            </div>
          {/each}
        </div>
        <button onclick={() => (settings.s.shortcuts = { ...DEFAULT_SHORTCUTS })}>Reset shortcuts</button>
      </section>

      <section class="glass card col">
        <h3>Demo &amp; onboarding</h3>
        <div class="row wrap">
          <button onclick={() => ui.openDemoPicker()} disabled={rt.phase !== 'ready'}>Watch demo</button>
          <button onclick={() => ui.startTour()} disabled={rt.phase !== 'ready'}>Re-run tour</button>
        </div>
        <label class="row">When a demo ends
          <select bind:value={settings.s.demoMode}>
            <option value="cycle">Play the next demo</option>
            <option value="loop">Repeat the same demo</option>
            <option value="once">Stop</option>
          </select>
        </label>
        <label class="row"><input type="checkbox" bind:checked={settings.s.demoShowNext} /> Show the next chord as an outline during demos</label>
        <p class="hint">Press <kbd>D</kbd> anywhere to open the demos. Esc, any transport key, or your own hands on camera stop one.</p>
      </section>

      <section class="glass card col">
        <h3>Accessibility &amp; privacy</h3>
        <label class="row"><input type="checkbox" bind:checked={settings.s.reducedMotion} /> Reduced motion</label>
        <label class="row"><input type="checkbox" bind:checked={settings.s.highContrast} /> High contrast</label>
        <label class="row"><input type="checkbox" bind:checked={settings.s.telemetry} /> Anonymous usage telemetry (off by default; nothing is sent in this build)</label>
      </section>

      <section class="glass card col">
        <h3>About</h3>
        <p>Gesture Synth. Play chords with your hands, loop them, watch the harmony. Open source under the MIT license.</p>
        <div class="row wrap">
          <MadeBy />
          <MadeBy href="https://github.com/Londopy/gesture-synth/issues/new/choose" label="Report a problem" />
        </div>
      </section>

      <section class="glass card col">
        <h3>Storage &amp; community</h3>
        <div class="kv"><span>Location</span><span>{store.location()}</span></div>
        <div class="kv"><span>Used</span><span class="num">{fmt(usage.used)}{usage.quota ? ` of ${fmt(usage.quota)}` : ''}</span></div>
        <div class="row wrap">
          {#if flags.isTauri}<button onclick={openDataFolder}>Open data folder</button>{/if}
          <button onclick={clearStorage}>Clear saved files</button>
        </div>
        <label class="col"><span class="label">Community service URL</span><input type="text" bind:value={settings.s.communityUrl} /></label>
        <div class="row wrap">
          <button onclick={() => navigator.clipboard?.writeText(settings.export()).then(() => ui.toast('Settings copied', 'ok'))}>Copy settings JSON</button>
          <button onclick={async () => (await ui.ask('Reset settings', 'Restore all defaults?', 'Reset', true)) && settings.reset()}>Reset all</button>
          <button onclick={async () => (await ui.ask('Reset medals', 'Clear every medal and all play statistics?', 'Reset', true)) && achievements.reset()}>Reset medals</button>
        </div>
      </section>
    </div>
  </div>
</div>

<style>
  .kv {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    color: var(--text-dim);
    gap: 12px;
  }
  .kv span:last-child {
    color: var(--text);
    text-align: right;
  }
  select {
    font-size: 13px;
  }
  .hint {
    font-size: 12px;
    color: var(--text-faint);
  }
  .wrap {
    flex-wrap: wrap;
  }
  .calbox {
    border-top: 1px solid var(--line);
    padding-top: 10px;
  }
  .shortcuts {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .sc {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
    color: var(--text-dim);
    gap: 10px;
  }
  .sc button {
    min-width: 90px;
    font-size: 12px;
    padding: 3px 8px;
  }
</style>
