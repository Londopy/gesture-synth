<script lang="ts">
  // Demo picker: the built-in songs the app can play by itself while showing
  // the hands that play them. Anchored like RecordSheet so it sits over the
  // scene instead of replacing it; the scene is the point of a demo.
  import { demo } from '../demo/demo.svelte';
  import { DEMO_PASSES, DEMO_SONGS, type DemoSong } from '../demo/songs';
  import { settings } from '../state/settings.svelte';
  import { ui } from '../state/ui.svelte';

  function meta(s: DemoSong): string {
    const bpb = Number(s.time_sig.split('/')[0]) || 4;
    const secs = Math.round((s.bars * bpb * 60) / s.bpm) * DEMO_PASSES;
    return `${s.key} ${s.mode} · ${s.time_sig} · ${s.bpm} BPM · ${s.bars} bars · ${s.instrument ?? 'Pad'} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }

  function play(id?: string) {
    ui.demoPicker = false;
    void demo.start(id, { mode: settings.s.demoMode });
  }
</script>

<div class="sheet glass strong fade-in" role="dialog" aria-label="Watch a demo">
  <div class="row" style="justify-content:space-between">
    <h2 style="margin:0">Demos</h2>
    <button class="ghost" onclick={() => (ui.demoPicker = false)} aria-label="Close">×</button>
  </div>
  <p class="hint">The app plays a song by itself and shows the hands that play it.</p>

  <div class="list">
    {#each DEMO_SONGS as s (s.id)}
      <div class="song" class:playing={demo.active && demo.songId === s.id}>
        <div class="col" style="gap:4px; min-width:0">
          <div class="row" style="gap:8px">
            <b class="display">{s.name}</b>
            {#if demo.active && demo.songId === s.id}<span class="chip on">playing</span>{/if}
          </div>
          <span class="sm num dim">{meta(s)}</span>
          <span class="blurb">{s.blurb}</span>
          <div class="row wrap" style="gap:4px">
            {#each s.features as f}<span class="chip">{f}</span>{/each}
          </div>
        </div>
        <button class="primary" onclick={() => play(s.id)}>Play</button>
      </div>
    {/each}
  </div>

  <div class="row" style="justify-content:space-between">
    <div class="row">
      <button onclick={() => play(DEMO_SONGS[0].id)}>Play all</button>
      <label class="row small">when a demo ends
        <select bind:value={settings.s.demoMode}>
          <option value="cycle">play the next demo</option>
          <option value="loop">repeat the same demo</option>
          <option value="once">stop</option>
        </select>
      </label>
    </div>
    <button class="ghost" disabled={!demo.active} onclick={() => demo.stop('button')}>Stop</button>
  </div>
  <p class="hint">Esc or any transport key stops the demo. Show your hands to the camera to take over.</p>
</div>

<style>
  .sheet {
    position: absolute;
    right: 14px;
    top: 90px;
    width: min(560px, 92vw);
    max-height: calc(100vh - 120px);
    overflow: auto;
    padding: 16px 18px;
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .song {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
  }
  .song:hover {
    border-color: var(--accent);
  }
  .song.playing {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .blurb {
    font-size: 12px;
    color: var(--text-dim);
    line-height: 1.4;
  }
  .dim {
    color: var(--text-dim);
  }
  select {
    font-size: 12px;
    padding: 5px 8px;
  }
</style>
