<script lang="ts">
  // Song Builder (spec 9): type or click a progression (roman or absolute),
  // set BPM/bars/time sig, pick instrument, generate a tutorial or drop it
  // into a loop track. Export as .song.gsyn.json.
  import { rt } from '../lib/state/engine.svelte';
  import { ui } from '../lib/state/ui.svelte';
  import { router } from '../lib/router/router.svelte';
  import { settings } from '../lib/state/settings.svelte';
  import { ensureWasm } from '../lib/tracking/parser';
  import { PITCH_NAMES, ROMAN, TIME_SIGS, chordName, diatonicQuality, type Quality, type Shape, SHAPE_NAMES } from '../lib/music';
  import { QUALITY_KEYS, SHAPE_KEYS, type Song, type SongChord } from '../lib/learn/songs';
  import { store, downloadFile, sanitize } from '../lib/storage/store';
  import { learnState } from './learn-state.svelte';
  import { CommunityApi } from '../lib/community/api';

  let name = $state('My progression');
  let text = $state('I V vi IV');
  let key = $state(0);
  let minor = $state(false);
  let bpm = $state(96);
  let sig = $state('4/4');
  let chordsPerBar = $state(1);
  let instrument = $state('Pad');
  let chords = $state<SongChord[]>([]);
  let error = $state('');
  let clickShape = $state<Shape>(0);

  const beats = $derived(Number(sig.split('/')[0]) || 4);
  const bars = $derived(Math.max(1, Math.min(16, Math.ceil(chords.length / chordsPerBar) || 1)));

  async function parse() {
    error = '';
    try {
      await ensureWasm();
      const m = await import('../lib/wasm/pkg/gsyn.js');
      const json = m.parse_progression(text, key, minor, beats, chordsPerBar);
      chords = JSON.parse(json);
    } catch (e: any) {
      error = String(e?.message ?? e).replace(/^Error:\s*/, '');
    }
  }

  function addChord(degree: number) {
    const q = diatonicQuality(degree, minor);
    const tok = (q === 1 ? ROMAN[degree - 1].toLowerCase() : q === 2 ? ROMAN[degree - 1].toLowerCase() + 'dim' : ROMAN[degree - 1]) + (clickShape === 2 ? '7' : clickShape === 3 ? (q === 0 ? '7' : 'm7b5') : clickShape === 1 ? '/1' : '');
    text = (text.trim() ? text.trim() + ' ' : '') + (clickShape === 2 && q === 0 ? ROMAN[degree - 1] + 'maj7' : tok);
    void parse();
  }
  function clear() {
    text = '';
    chords = [];
  }
  function song(): Song {
    return {
      version: 1,
      name,
      author: settings.s.communityHandle || 'me',
      bpm,
      time_sig: sig,
      key: PITCH_NAMES[key],
      mode: minor ? 'minor' : 'major',
      bars,
      chords: chords.map((c) => ({ ...c, quality: typeof c.quality === 'number' ? QUALITY_KEYS[c.quality as any] : c.quality, shape: typeof c.shape === 'number' ? SHAPE_KEYS[c.shape as any] : c.shape })),
      hints: { left_scheme: { kind: 'full' }, right_scheme: { kind: 'full' } },
      tags: ['custom'],
      instrument,
      id: sanitize(name).toLowerCase().replace(/\s+/g, '-'),
    };
  }
  async function toTrack(track: number) {
    if (!chords.length) return;
    await rt.loadSongIntoTrack(JSON.stringify(song()), track);
    ui.toast(`Dropped into track ${track + 1}`, 'ok');
    router.go('play');
  }
  function tutorial() {
    if (!chords.length) return;
    const s = song();
    learnState.pending = s;
    router.navigate({ page: 'learn', kind: 'learn', id: s.id! });
  }
  async function save() {
    await store.write(name, 'song', JSON.stringify(song(), null, 2));
    ui.toast('Saved to your songs', 'ok');
  }
  async function exportFile() {
    await downloadFile(sanitize(name) + '.song.gsyn.json', JSON.stringify(song(), null, 2) + '\n', 'application/json');
  }
  async function publish() {
    try {
      const api = new CommunityApi(settings.s.communityUrl, settings.s.communityToken);
      if (!api.token) throw new Error('Sign in on the Community page first');
      const s = song();
      const item = await api.create({ kind: 'song', title: s.name, description: text, tags: s.tags, payload: s });
      const sh = await api.share(item.id);
      await navigator.clipboard?.writeText(sh.url).catch(() => {});
      ui.toast(`Published. Link copied: ${sh.url}`, 'ok', 6000);
    } catch (e: any) {
      ui.toast(e.message, 'error');
    }
  }

  // open from /song/<id> (community)
  $effect(() => {
    router.openSeq;
    if (router.route.kind === 'song' && router.route.id) void openCommunitySong(router.route.id);
  });
  async function openCommunitySong(id: string) {
    try {
      const api = new CommunityApi(settings.s.communityUrl, settings.s.communityToken);
      const item = await api.get(id);
      const s = item.payload as Song;
      if (!s?.chords) throw new Error('not a song');
      name = s.name;
      bpm = s.bpm;
      sig = s.time_sig;
      key = Math.max(0, PITCH_NAMES.indexOf(s.key as any));
      minor = s.mode === 'minor';
      instrument = s.instrument ?? 'Pad';
      chords = s.chords;
      text = s.chords.map((c) => chordName(c.degree, (QUALITY_KEYS.indexOf(c.quality as any) as Quality) ?? 0, (SHAPE_KEYS.indexOf(c.shape as any) as Shape) ?? 0).replace(/ \/ 1st inv/, '/1').replace(/ /g, '')).join(' ');
      ui.toast(`Opened "${s.name}" from Community`, 'ok');
    } catch (e: any) {
      ui.toast(`Could not open song: ${e.message}`, 'error');
    }
  }

  $effect(() => {
    void parse();
  });
</script>

<div class="page">
  <div class="page-inner">
    <h2>Song Builder</h2>
    <p>Type roman numerals (I, ii7, V7, IVmaj7, vii°) or absolute chords (C, Am, G7, Fmaj7), or click degrees below.</p>
    <div class="layout">
      <section class="glass card col">
        <label class="col"><span class="label">Name</span><input type="text" bind:value={name} /></label>
        <label class="col"><span class="label">Progression</span><textarea rows="3" bind:value={text} oninput={parse} spellcheck="false"></textarea></label>
        {#if error}<p class="err">{error}</p>{/if}
        <div class="row wrap">
          <label class="col"><span class="label">Key</span>
            <select bind:value={key} onchange={parse}>{#each PITCH_NAMES as n, i}<option value={i}>{n}</option>{/each}</select></label>
          <label class="col"><span class="label">Mode</span>
            <select value={minor ? 'minor' : 'major'} onchange={(e) => ((minor = (e.target as HTMLSelectElement).value === 'minor'), parse())}><option value="major">major</option><option value="minor">minor</option></select></label>
          <label class="col"><span class="label">BPM</span><input type="number" min="40" max="240" bind:value={bpm} style="width:70px" /></label>
          <label class="col"><span class="label">Time</span><select bind:value={sig} onchange={parse}>{#each TIME_SIGS as s}<option value={s}>{s}</option>{/each}</select></label>
          <label class="col"><span class="label">Chords / bar</span><select bind:value={chordsPerBar} onchange={parse}><option value={1}>1</option><option value={2}>2</option><option value={4}>4</option></select></label>
          <label class="col"><span class="label">Instrument</span><select bind:value={instrument}>{#each ['Pad', 'Keys', 'Organ', 'Pluck', 'Bass', 'Lead', 'Choir'] as n}<option value={n}>{n}</option>{/each}</select></label>
        </div>
        <div class="col">
          <span class="label">Click to add (diatonic quality)</span>
          <div class="row wrap">
            {#each ROMAN as r, i}
              {@const q = diatonicQuality(i + 1, minor)}
              <button class="deg" onclick={() => addChord(i + 1)}>{q === 1 ? r.toLowerCase() : q === 2 ? r.toLowerCase() + '°' : r}</button>
            {/each}
            <select bind:value={clickShape} aria-label="Shape for clicked chords">{#each SHAPE_NAMES as s, i}<option value={i}>{s}</option>{/each}</select>
            <button class="ghost" onclick={clear}>clear</button>
          </div>
        </div>
      </section>
      <section class="glass card col">
        <span class="label">{chords.length} chords · {bars} bars</span>
        <div class="timeline" style:--beats={beats}>
          {#each Array(bars) as _, b}
            <div class="bar">
              <span class="bn num">{b + 1}</span>
              {#each chords.filter((c) => c.bar === b + 1) as c}
                <div class="chord" style:flex={c.dur_beats}>
                  <span class="cn">{chordName(c.degree, (typeof c.quality === 'number' ? c.quality : QUALITY_KEYS.indexOf(c.quality)) as Quality, (typeof c.shape === 'number' ? c.shape : SHAPE_KEYS.indexOf(c.shape)) as Shape)}</span>
                </div>
              {/each}
            </div>
          {/each}
        </div>
        <div class="row wrap actions">
          <button class="primary" onclick={tutorial} disabled={!chords.length}>Generate tutorial</button>
          <div class="row">
            <span class="small">Drop into track</span>
            {#each [0, 1, 2, 3] as t}<button onclick={() => toTrack(t)} disabled={!chords.length}>{t + 1}</button>{/each}
          </div>
          <button onclick={save} disabled={!chords.length}>Save</button>
          <button onclick={exportFile} disabled={!chords.length}>Export .song.gsyn.json</button>
          <button onclick={publish} disabled={!chords.length}>Publish</button>
        </div>
      </section>
    </div>
  </div>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  textarea {
    resize: vertical;
    font-family: var(--font-ui);
    font-size: 16px;
    letter-spacing: 0.04em;
  }
  .wrap {
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px;
  }
  .err {
    color: var(--danger);
    font-size: 12px;
  }
  .deg {
    min-width: 40px;
    font-family: var(--font-display);
    font-size: 18px;
    padding: 4px 8px;
  }
  .timeline {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .bar {
    flex: 1 1 calc(25% - 6px);
    min-width: 120px;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 6px;
    display: flex;
    gap: 4px;
    position: relative;
    min-height: 56px;
  }
  .bn {
    position: absolute;
    top: 3px;
    left: 6px;
    font-size: 10px;
    color: var(--text-faint);
  }
  .chord {
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: 8px;
    display: grid;
    place-items: center;
    margin-top: 10px;
    min-height: 34px;
  }
  .cn {
    font-family: var(--font-display);
    font-size: 20px;
  }
  .actions {
    gap: 12px;
  }
  .small {
    font-size: 12px;
    color: var(--text-dim);
  }
</style>
