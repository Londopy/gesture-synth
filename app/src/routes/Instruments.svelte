<script lang="ts">
  // Instruments page (spec 9): browse/edit presets (oscillators, envelope,
  // filter, fx). Live preview with your hand (edits apply to the live slot).
  import { rt } from '../lib/state/engine.svelte';
  import { ui } from '../lib/state/ui.svelte';
  import { settings } from '../lib/state/settings.svelte';
  import { router } from '../lib/router/router.svelte';
  import { store, downloadFile, pickFile, sanitize } from '../lib/storage/store';
  import { communityApi } from '../lib/community/client';
  import { achievements } from '../lib/achievements/store.svelte';

  interface Osc {
    wave: 'saw' | 'sine' | 'triangle' | 'square';
    detune: number;
    level: number;
    octave: number;
  }
  interface Instrument {
    name: string;
    osc: Osc[];
    env: { a: number; d: number; s: number; r: number };
    filter: { type: 'lowpass'; res: number; cutoff_range: [number, number] };
    fx: { reverb: number; delay: number };
    gain: number;
    glide: number;
  }

  let builtin = $state<Instrument[]>([]);
  let custom = $state<{ name: string }[]>([]);
  let cur = $state<Instrument | null>(null);
  let applyTo = $state<'live' | 'theremin' | 0 | 1 | 2 | 3>('live');
  let timer = 0;

  $effect(() => {
    rt.builtinInstruments().then((b) => {
      builtin = b;
      if (!cur) cur = structuredClone(b.find((i) => i.name === settings.s.liveInstrument) ?? b[0]);
    });
    store.list('instrument').then((l) => (custom = l));
  });

  $effect(() => {
    router.openSeq;
    if (router.route.kind === 'preset' && router.route.id) void openCommunity(router.route.id);
  });

  function pick(i: Instrument) {
    cur = structuredClone(i);
    push();
  }
  async function openCustom(name: string) {
    cur = JSON.parse(await store.read(name, 'instrument'));
    push();
  }
  async function openCommunity(id: string) {
    try {
      const item = await communityApi().get(id);
      if (!item.payload?.osc) throw new Error('not a preset');
      cur = item.payload;
      push();
      ui.toast(`Opened preset "${item.title}"`, 'ok');
    } catch (e: any) {
      ui.toast(`Could not open preset: ${e.message}`, 'error');
    }
  }
  /** Debounced push of the edited preset to the chosen slot. */
  function push() {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!cur) return;
      const inst = $state.snapshot(cur);
      if (applyTo === 'live') {
        void rt.setLiveInstrument(inst);
        achievements.track({ kind: 'instrument', name: inst.name });
      }
      else if (applyTo === 'theremin') void rt.setThereminInstrument(inst);
      else void rt.setTrackInstrument(applyTo, inst);
    }, 60);
  }
  function addOsc() {
    if (!cur || cur.osc.length >= 2) return;
    cur.osc.push({ wave: 'sine', detune: 0, level: 0.3, octave: 0 });
    push();
  }
  function removeOsc(i: number) {
    if (!cur || cur.osc.length <= 1) return;
    cur.osc.splice(i, 1);
    push();
  }
  async function save() {
    if (!cur) return;
    await store.write(cur.name, 'instrument', JSON.stringify($state.snapshot(cur), null, 2));
    custom = await store.list('instrument');
    ui.toast('Preset saved', 'ok');
  }
  async function exportFile() {
    if (!cur) return;
    await downloadFile(sanitize(cur.name) + '.instrument.gsyn.json', JSON.stringify($state.snapshot(cur), null, 2) + '\n', 'application/json');
  }
  async function importFile() {
    const f = await pickFile();
    if (!f) return;
    try {
      const i = JSON.parse(f.text);
      if (!i.osc || !i.env) throw new Error();
      cur = i;
      push();
    } catch {
      ui.toast('Not a valid instrument file', 'error');
    }
  }
  let publishing = $state(false);
  async function publish() {
    if (!cur || publishing) return;
    publishing = true;
    try {
      const api = communityApi();
      if (!api.token) throw new Error('Sign in on the Community page first');
      // Wake the server with the idempotent probe so the create runs once,
      // against an awake instance, instead of being retried and duplicated.
      await api.health();
      const item = await api.create({ kind: 'preset', title: cur.name, description: '', tags: ['preset'], payload: $state.snapshot(cur) });
      const sh = await api.share(item.id);
      // After a long wake the click's user activation has expired and the
      // clipboard write is refused; the link still exists, so show it.
      const copied = await Promise.resolve()
        .then(() => navigator.clipboard.writeText(sh.url))
        .then(() => true, () => false);
      ui.toast(copied ? `Published. Link copied: ${sh.url}` : `Published. Share link: ${sh.url}`, 'ok', copied ? 6000 : 10000);
      achievements.track({ kind: 'publish' });
    } catch (e: any) {
      ui.toast(e.message, 'error');
    } finally {
      publishing = false;
    }
  }
  const envPath = $derived.by(() => {
    if (!cur) return '';
    const { a, d, s, r } = cur.env;
    const tot = a + d + 0.6 + r;
    const x = (t: number) => (t / tot) * 200;
    return `M0,60 L${x(a)},4 L${x(a + d)},${60 - s * 56} L${x(a + d + 0.6)},${60 - s * 56} L${x(tot)},60`;
  });
</script>

<div class="page">
  <div class="page-inner">
    <div class="row" style="justify-content:space-between; align-items:flex-end">
      <div><h2>Instruments</h2><p>Edit a preset and play it live. Changes apply immediately to the selected slot.</p></div>
      <button onclick={importFile}>Import .instrument.gsyn.json</button>
    </div>
    <div class="layout">
      <aside class="glass card col">
        <span class="label">Built in</span>
        {#each builtin as i}<button class="pl" class:active={cur?.name === i.name} onclick={() => pick(i)}>{i.name}</button>{/each}
        {#if custom.length}
          <span class="label" style="margin-top:8px">Yours</span>
          {#each custom as c}<button class="pl" class:active={cur?.name === c.name} onclick={() => openCustom(c.name)}>{c.name}</button>{/each}
        {/if}
      </aside>
      {#if cur}
        <section class="glass card col edit">
          <div class="row" style="justify-content:space-between">
            <input class="name" type="text" bind:value={cur.name} />
            <label class="row small">Apply to
              <select bind:value={applyTo} onchange={push}>
                <option value="live">Live</option>
                <option value="theremin">Theremin</option>
                {#each [0, 1, 2, 3] as t}<option value={t}>Track {t + 1}</option>{/each}
              </select></label>
          </div>
          <div class="grid2">
            <div class="block">
              <div class="row" style="justify-content:space-between"><h3>Oscillators</h3><button class="tiny" onclick={addOsc} disabled={cur.osc.length >= 2}>+ osc</button></div>
              {#each cur.osc as o, i}
                <div class="osc">
                  <div class="row">
                    <select bind:value={o.wave} onchange={push}><option value="saw">saw</option><option value="sine">sine</option><option value="triangle">triangle</option><option value="square">square</option></select>
                    <select bind:value={o.octave} onchange={push}>{#each [-2, -1, 0, 1, 2] as oc}<option value={oc}>{oc > 0 ? '+' : ''}{oc} oct</option>{/each}</select>
                    <button class="tiny ghost" onclick={() => removeOsc(i)} disabled={cur.osc.length <= 1} aria-label="Remove">×</button>
                  </div>
                  <label class="row small"><span>level</span><input type="range" min="0" max="1" step="0.01" bind:value={o.level} oninput={push} /><span class="num">{o.level.toFixed(2)}</span></label>
                  <label class="row small"><span>detune</span><input type="range" min="-50" max="50" step="1" bind:value={o.detune} oninput={push} /><span class="num">{o.detune}¢</span></label>
                </div>
              {/each}
            </div>
            <div class="block">
              <h3>Envelope</h3>
              <svg viewBox="0 0 200 64" class="env"><path d={envPath} fill="none" stroke="var(--accent)" stroke-width="2" /></svg>
              <label class="row small"><span>attack</span><input type="range" min="0.001" max="2" step="0.001" bind:value={cur.env.a} oninput={push} /><span class="num">{cur.env.a.toFixed(2)}s</span></label>
              <label class="row small"><span>decay</span><input type="range" min="0.01" max="3" step="0.01" bind:value={cur.env.d} oninput={push} /><span class="num">{cur.env.d.toFixed(2)}s</span></label>
              <label class="row small"><span>sustain</span><input type="range" min="0" max="1" step="0.01" bind:value={cur.env.s} oninput={push} /><span class="num">{cur.env.s.toFixed(2)}</span></label>
              <label class="row small"><span>release</span><input type="range" min="0.01" max="4" step="0.01" bind:value={cur.env.r} oninput={push} /><span class="num">{cur.env.r.toFixed(2)}s</span></label>
            </div>
            <div class="block">
              <h3>Filter (low-pass, swept by right-hand tilt)</h3>
              <label class="row small"><span>resonance</span><input type="range" min="0" max="0.95" step="0.01" bind:value={cur.filter.res} oninput={push} /><span class="num">{cur.filter.res.toFixed(2)}</span></label>
              <label class="row small"><span>min Hz</span><input type="range" min="40" max="2000" step="10" bind:value={cur.filter.cutoff_range[0]} oninput={push} /><span class="num">{cur.filter.cutoff_range[0]}</span></label>
              <label class="row small"><span>max Hz</span><input type="range" min="500" max="16000" step="100" bind:value={cur.filter.cutoff_range[1]} oninput={push} /><span class="num">{cur.filter.cutoff_range[1]}</span></label>
            </div>
            <div class="block">
              <h3>FX &amp; gain</h3>
              <label class="row small"><span>reverb</span><input type="range" min="0" max="1" step="0.01" bind:value={cur.fx.reverb} oninput={push} /><span class="num">{cur.fx.reverb.toFixed(2)}</span></label>
              <label class="row small"><span>delay</span><input type="range" min="0" max="1" step="0.01" bind:value={cur.fx.delay} oninput={push} /><span class="num">{cur.fx.delay.toFixed(2)}</span></label>
              <label class="row small"><span>gain</span><input type="range" min="0" max="1.5" step="0.01" bind:value={cur.gain} oninput={push} /><span class="num">{cur.gain.toFixed(2)}</span></label>
              <label class="row small"><span>glide</span><input type="range" min="0" max="0.5" step="0.005" bind:value={cur.glide} oninput={push} /><span class="num">{Math.round(cur.glide * 1000)}ms</span></label>
            </div>
          </div>
          <div class="row wrap">
            <button class="primary" onclick={save}>Save as custom</button>
            <button onclick={exportFile}>Export</button>
            <button onclick={publish} disabled={publishing}>{publishing ? 'Publishing…' : 'Publish'}</button>
            <span class="small">Play a chord with your hands to hear the edit. Volume: {Math.round(rt.live.volume * 100)}%</span>
          </div>
        </section>
      {/if}
    </div>
  </div>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 14px;
  }
  .pl {
    text-align: left;
  }
  .edit {
    gap: 14px;
  }
  .name {
    font-size: 18px;
    font-weight: 500;
    width: 240px;
  }
  .block {
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .osc {
    border-top: 1px solid var(--line);
    padding-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .small {
    font-size: 12px;
    color: var(--text-dim);
  }
  .small > span:first-child {
    width: 64px;
  }
  .small .num {
    width: 56px;
    text-align: right;
  }
  .small input[type='range'] {
    flex: 1;
  }
  select {
    font-size: 12px;
    padding: 4px 6px;
  }
  .tiny {
    padding: 2px 8px;
    font-size: 11px;
  }
  .env {
    width: 100%;
    height: 64px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 8px;
  }
  .wrap {
    flex-wrap: wrap;
  }
</style>
