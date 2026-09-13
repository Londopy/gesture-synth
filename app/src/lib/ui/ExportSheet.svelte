<script lang="ts">
  // Export / save / share sheet (Cmd/Ctrl+E, Cmd/Ctrl+S).
  import { rt } from '../state/engine.svelte';
  import { ui } from '../state/ui.svelte';
  import { settings } from '../state/settings.svelte';
  import { exportMidi, exportSession, exportVideo, exportWav, recordShareClip } from '../export/video';
  import { store, downloadFile, pickFile } from '../storage/store';
  import { canExportMp4, isTauri } from '../platform';
  import { CommunityApi } from '../community/api';
  import { achievements } from '../achievements/store.svelte';

  let { canvas }: { canvas: () => HTMLCanvasElement | null } = $props();

  let busy = $state('');
  let progress = $state(0);
  let seconds = $state(15);
  let format = $state<'webm' | 'mp4'>(canExportMp4 ? 'mp4' : 'webm');
  let name = $state(rt.sessionName);
  let shareUrl = $state('');
  let sessions = $state<{ name: string; modified: number }[]>([]);
  let clipUrl = $state('');

  $effect(() => {
    void store.list('session').then((l) => (sessions = l));
  });

  async function save() {
    rt.sessionName = name;
    const json = await rt.sessionJson();
    await store.write(name, 'session', json);
    rt.dirty = false;
    ui.toast(`Saved "${name}"`, 'ok');
    achievements.track({ kind: 'session_saved' });
    sessions = await store.list('session');
  }
  async function load(n: string) {
    const json = await store.read(n, 'session');
    await rt.loadSessionJson(json);
    name = n;
    ui.toast(`Loaded "${n}"`, 'ok');
    ui.exportSheet = false;
  }
  async function remove(n: string) {
    if (await ui.ask('Delete session', `Delete "${n}"?`, 'Delete', true)) {
      await store.remove(n, 'session');
      sessions = await store.list('session');
    }
  }
  async function importFile() {
    const f = await pickFile();
    if (!f) return;
    try {
      await rt.loadSessionJson(f.text);
      ui.toast(`Imported ${f.name}`, 'ok');
    } catch (e: any) {
      ui.toast(`Import failed: ${e.message}`, 'error');
    }
  }
  async function run(label: string, fn: () => Promise<void>) {
    busy = label;
    progress = 0;
    try {
      await fn();
      ui.toast(`${label} done`, 'ok');
      if (/export|bounce/i.test(label)) achievements.track({ kind: 'export' });
      if (/publish/i.test(label)) achievements.track({ kind: 'publish' });
      if (/video/i.test(label)) achievements.track({ kind: 'video' });
    } catch (e: any) {
      ui.toast(`${label} failed: ${e.message ?? e}`, 'error', 6000);
    } finally {
      busy = '';
    }
  }
  async function video() {
    const c = canvas();
    if (!c) return;
    rt.sessionName = name;
    await run('Video export', () => exportVideo(c, seconds, format, name, (p, l) => ((progress = p), (busy = l))));
  }
  async function shareClip() {
    const c = canvas();
    if (!c) return;
    await run('Share clip', async () => {
      const blob = await recordShareClip(c, 15, (p) => (progress = p));
      if (clipUrl) URL.revokeObjectURL(clipUrl);
      clipUrl = URL.createObjectURL(blob);
      if (navigator.canShare?.({ files: [new File([blob], 'gesture-synth.webm', { type: blob.type })] })) {
        await navigator.share({ files: [new File([blob], 'gesture-synth.webm', { type: blob.type })], title: name });
      } else {
        await downloadFile(`${name}-clip.webm`, blob, blob.type);
      }
    });
  }
  async function publish() {
    await run('Publish loop', async () => {
      const api = new CommunityApi(settings.s.communityUrl, settings.s.communityToken);
      if (!api.token) throw new Error('Sign in on the Community page first');
      const json = await rt.sessionJson();
      const item = await api.create({ kind: 'loop', title: name, description: '', tags: ['loop'], payload: JSON.parse(json) });
      const s = await api.share(item.id);
      shareUrl = s.url;
      await navigator.clipboard?.writeText(s.url).catch(() => {});
    });
  }
</script>

<div class="backdrop" role="presentation" onclick={() => (ui.exportSheet = false)}>
  <div class="sheet glass strong fade-in" role="dialog" aria-modal="true" aria-label="Save and export" onclick={(e) => e.stopPropagation()}>
    <div class="row" style="justify-content:space-between">
      <h2>Save &amp; export</h2>
      <button class="ghost" onclick={() => (ui.exportSheet = false)} aria-label="Close">×</button>
    </div>
    <label class="col"><span class="label">Session name</span><input type="text" bind:value={name} /></label>

    <div class="grid">
      <section>
        <h3>Session</h3>
        <div class="row wrap">
          <button class="primary" onclick={save}>Save ({isTauri ? 'data folder' : 'browser'})</button>
          <button onclick={() => exportSession(name).then(() => achievements.track({ kind: 'export' }))}>Download .gsyn.json</button>
          <button onclick={importFile}>Import…</button>
        </div>
        {#if sessions.length}
          <ul class="list">
            {#each sessions as s}
              <li><button class="ghost" onclick={() => load(s.name)}>{s.name}</button><span class="when">{s.modified ? new Date(s.modified).toLocaleString() : ''}</span><button class="ghost" onclick={() => remove(s.name)} aria-label="Delete">×</button></li>
            {/each}
          </ul>
        {/if}
      </section>
      <section>
        <h3>Audio &amp; MIDI</h3>
        <div class="row wrap">
          <button onclick={() => run('MIDI export', () => exportMidi(name))}>.mid (one track per loop)</button>
          <button onclick={() => run('WAV bounce', () => exportWav(name, 2))}>.wav (2 passes, 48 kHz)</button>
        </div>
        <p class="hint">Bounces re-synthesize the loop offline: no metronome, no camera needed.</p>
      </section>
      <section>
        <h3>Video</h3>
        <div class="row wrap">
          <label class="row small">Length <select bind:value={seconds}><option value={10}>10 s</option><option value={15}>15 s</option><option value={30}>30 s</option><option value={60}>60 s</option></select></label>
          <label class="row small">Format
            <select bind:value={format}>
              <option value="webm">webm</option>
              {#if canExportMp4}<option value="mp4">mp4 (H.264/AAC)</option>{/if}
            </select></label>
          <button class="primary" onclick={video} disabled={!!busy}>Record scene + audio</button>
        </div>
        {#if !canExportMp4}<p class="hint">mp4 needs the desktop app or a host with cross-origin isolation headers; webm always works.</p>{/if}
      </section>
      <section>
        <h3>Share</h3>
        <div class="row wrap">
          <button onclick={shareClip} disabled={!!busy}>15 s clip</button>
          <button onclick={publish} disabled={!!busy}>Publish loop to Community</button>
        </div>
        {#if shareUrl}<p class="hint">Link copied: <a href={shareUrl} target="_blank" rel="noopener">{shareUrl}</a></p>{/if}
        {#if clipUrl}<video class="clip" src={clipUrl} controls muted></video>{/if}
      </section>
    </div>
    {#if busy}
      <div class="busy"><span>{busy}…</span><div class="pbar"><i style:width="{progress * 100}%"></i></div></div>
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
    width: min(760px, 94vw);
    max-height: 88vh;
    overflow: auto;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  section {
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 12px;
  }
  .wrap {
    flex-wrap: wrap;
  }
  .small {
    font-size: 12px;
    color: var(--text-dim);
  }
  .small select {
    font-size: 12px;
    padding: 4px 6px;
  }
  .hint {
    font-size: 12px;
    color: var(--text-faint);
    margin: 8px 0 0;
  }
  .list {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 140px;
    overflow: auto;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .list li > button:first-child {
    flex: 1;
    text-align: left;
  }
  .when {
    font-size: 11px;
    color: var(--text-faint);
  }
  .busy {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 13px;
  }
  .pbar {
    flex: 1;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }
  .pbar i {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 150ms linear;
  }
  .clip {
    width: 100%;
    margin-top: 8px;
    border-radius: 8px;
  }
</style>
