<script lang="ts">
  // Visuals page (spec 9): themes, particle density, ghost opacity, camera
  // feed on/off, bloom. Custom themes import/export as theme.gsyn.json.
  import { settings } from '../lib/state/settings.svelte';
  import { ui } from '../lib/state/ui.svelte';
  import { THEMES, visibleThemeNames, getTheme, themeFromFile, themeToFile, type Theme } from '../lib/themes';
  import { downloadFile, pickFile, sanitize, store } from '../lib/storage/store';
  import { communityApi } from '../lib/community/client';
  import { achievements } from '../lib/achievements/store.svelte';

  let custom = $state<{ name: string }[]>([]);
  $effect(() => {
    store.list('theme').then((l) => (custom = l));
  });

  async function exportTheme() {
    const t = getTheme(settings.s.theme);
    await downloadFile(sanitize(t.name) + '.theme.gsyn.json', JSON.stringify(themeToFile(t), null, 2) + '\n', 'application/json');
  }
  async function importTheme() {
    const f = await pickFile();
    if (!f) return;
    const t = themeFromFile(JSON.parse(f.text));
    if (!t) return ui.toast('Not a valid theme file', 'error');
    THEMES[t.name] = t;
    await store.write(t.name, 'theme', JSON.stringify(themeToFile(t), null, 2));
    custom = await store.list('theme');
    settings.s.theme = t.name;
  }
  async function loadCustom(name: string) {
    const t = themeFromFile(JSON.parse(await store.read(name, 'theme')));
    if (t) {
      THEMES[t.name] = t;
      settings.s.theme = t.name;
    }
  }
  let publishing = $state(false);
  async function publish() {
    if (publishing) return;
    publishing = true;
    try {
      const api = communityApi();
      if (!api.token) throw new Error('Sign in on the Community page first');
      // Wake the server with the idempotent probe so the create runs once,
      // against an awake instance, instead of being retried and duplicated.
      await api.health();
      const t = getTheme(settings.s.theme);
      const item = await api.create({ kind: 'theme', title: t.name, description: '', tags: ['theme'], payload: themeToFile(t) });
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
  const t = $derived(getTheme(settings.s.theme));
</script>

<div class="page">
  <div class="page-inner">
    <h2>Visuals</h2>
    <p>The scene follows the music. Pick a palette and how much of the GPU budget to spend.</p>
    <div class="grid2">
      <section class="glass card col">
        <span class="label">Theme</span>
        <div class="themes">
          {#each visibleThemeNames() as n}
            {@const th = THEMES[n]}
            <button class="theme" class:active={settings.s.theme === n} onclick={() => (settings.s.theme = n)} style:--a={th.palette.major} style:--b={th.palette.minor} style:--r={th.palette.ring}>
              <span class="sw"></span>
              <span>{n}</span>
            </button>
          {/each}
          {#each custom.filter((c) => !visibleThemeNames().includes(c.name)) as c}
            <button class="theme" class:active={settings.s.theme === c.name} onclick={() => loadCustom(c.name)}><span class="sw" style="--a:#888;--b:#444;--r:#aaa"></span><span>{c.name}</span></button>
          {/each}
        </div>
        <div class="row wrap">
          <button onclick={exportTheme}>Export theme</button>
          <button onclick={importTheme}>Import theme</button>
          <button onclick={publish} disabled={publishing}>{publishing ? 'Publishing…' : 'Publish'}</button>
        </div>
        <div class="swatches">
          <span style:background={t.palette.major} title="major"></span>
          <span style:background={t.palette.minor} title="minor"></span>
          <span style:background={t.palette.ring} title="ring"></span>
          {#each t.palette.ghost as g}<span style:background={g} title="ghost"></span>{/each}
        </div>
      </section>
      <section class="glass card col">
        <label class="col"><span class="label">Particle density ({Math.round(settings.s.particleDensity * 100)}% of 20k)</span><input type="range" min="0" max="1" step="0.05" bind:value={settings.s.particleDensity} /></label>
        <label class="col"><span class="label">Ghost opacity ({Math.round(settings.s.ghostOpacity * 100)}%)</span><input type="range" min="0" max="1" step="0.05" bind:value={settings.s.ghostOpacity} /></label>
        <div class="col">
          <span class="label">View</span>
          <div class="seg" role="group" aria-label="View mode">
            <button class:active={settings.s.viewMode === 'performance'} onclick={() => (settings.s.viewMode = 'performance')}>Performance</button>
            <button class:active={settings.s.viewMode === 'practice'} onclick={() => (settings.s.viewMode = 'practice')}>Practice</button>
            <button class:active={settings.s.viewMode === 'clear'} onclick={() => (settings.s.viewMode = 'clear')}>Clear camera</button>
          </div>
          <p class="hint">Performance: wireframe only. Practice: your real hands under a dark tint. Clear camera: the plain picture with no effects, for checking your framing or recording yourself. Press <kbd>C</kbd> to cycle.</p>
          {#if settings.s.viewMode === 'clear'}
            <label class="row"><input type="checkbox" bind:checked={settings.s.clearShowHands} /> Draw the hand wireframe over the clear picture</label>
          {/if}
        </div>
        <label class="row"><input type="checkbox" bind:checked={settings.s.bloom} /> Bloom</label>
        <label class="row"><input type="checkbox" bind:checked={settings.s.showHud} /> HUD</label>
        <p class="hint">Performance view (F) hides all chrome. The renderer steps down particles, bloom and ghost rate automatically when the frame rate drops below 48 fps and back up when it recovers.</p>
      </section>
    </div>
  </div>
</div>

<style>
  .themes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 8px;
  }
  .theme {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 8px;
  }
  .sw {
    width: 100%;
    height: 34px;
    border-radius: 8px;
    background: linear-gradient(120deg, var(--a), var(--b) 60%, var(--r));
  }
  .swatches {
    display: flex;
    gap: 6px;
  }
  .swatches span {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 1px solid var(--line);
  }
  .wrap {
    flex-wrap: wrap;
  }
  .hint {
    font-size: 12px;
    color: var(--text-faint);
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    overflow: hidden;
    align-self: flex-start;
  }
  .seg button {
    border: none;
    border-radius: 0;
    font-size: 12px;
  }
</style>
