<script lang="ts">
  // Community page (spec 9): browse/download songs, tutorials, presets, themes,
  // loops. Accounts, likes, comments, remix chains, search + tags. Backed by
  // the Gleam service.
  import { settings } from '../lib/state/settings.svelte';
  import { ui } from '../lib/state/ui.svelte';
  import { rt } from '../lib/state/engine.svelte';
  import { router } from '../lib/router/router.svelte';
  import { CommunityApi, type Item, type ItemKind, type Comment, type User } from '../lib/community/api';
  import { THEMES, themeFromFile } from '../lib/themes';
  import { learnState } from './learn-state.svelte';

  const api = $derived(new CommunityApi(settings.s.communityUrl, settings.s.communityToken));
  let me = $state<User | null>(null);
  let online = $state<boolean | null>(null);
  let kind = $state<ItemKind | ''>('');
  let q = $state('');
  let tag = $state('');
  let sort = $state<'new' | 'top'>('new');
  let page = $state(1);
  let items = $state<Item[]>([]);
  let total = $state(0);
  let busy = $state(false);
  let detail = $state<Item | null>(null);
  let comments = $state<Comment[]>([]);
  let chain = $state<Item[]>([]);
  let remixes = $state<Item[]>([]);
  let newComment = $state('');
  let auth = $state<{ mode: 'login' | 'register'; handle: string; name: string; password: string; error: string }>({ mode: 'login', handle: '', name: '', password: '', error: '' });
  let showAuth = $state(false);

  $effect(() => {
    void refresh();
    api
      .health()
      .then(() => (online = true))
      .catch(() => (online = false));
    if (settings.s.communityToken) api.me().then((u) => (me = u)).catch(() => (me = null));
  });

  $effect(() => {
    router.openSeq;
    const r = router.route;
    if (r.page === 'community' || r.kind === 'loop') {
      if (r.kind === 'loop' && r.id) void openLoop(r.id);
    }
  });

  async function refresh() {
    busy = true;
    try {
      const r = await api.list({ kind: kind || undefined, q, tag, sort, page, per_page: 24 });
      items = r.items;
      total = r.total;
    } catch (e: any) {
      online = false;
    } finally {
      busy = false;
    }
  }
  async function open(it: Item) {
    try {
      detail = await api.get(it.id);
      const [c, ch, rm] = await Promise.all([api.comments(it.id), api.chain(it.id), api.remixes(it.id)]);
      comments = c.comments;
      chain = ch.chain;
      remixes = rm.items;
    } catch (e: any) {
      ui.toast(e.message, 'error');
    }
  }
  async function like(it: Item) {
    if (!me) return (showAuth = true);
    try {
      const r = await api.like(it.id, !it.liked);
      it.liked = r.liked;
      it.like_count = r.like_count;
      if (detail?.id === it.id) detail = { ...detail, liked: r.liked, like_count: r.like_count };
    } catch (e: any) {
      ui.toast(e.message, 'error');
    }
  }
  async function comment() {
    if (!detail || !newComment.trim()) return;
    if (!me) return (showAuth = true);
    try {
      const c = await api.comment(detail.id, newComment.trim());
      comments = [...comments, c];
      newComment = '';
    } catch (e: any) {
      ui.toast(e.message, 'error');
    }
  }
  async function use(it: Item) {
    const p = it.payload;
    try {
      switch (it.kind) {
        case 'loop':
          await rt.loadSessionJson(JSON.stringify(p));
          rt.sessionName = it.title;
          ui.toast(`Loaded loop "${it.title}"`, 'ok');
          router.go('play');
          break;
        case 'song':
          await rt.loadSongIntoTrack(JSON.stringify(p), 3);
          ui.toast('Song dropped into track 4', 'ok');
          router.go('play');
          break;
        case 'tutorial': {
          learnState.pending = { ...p, id: it.id };
          router.navigate({ page: 'learn', kind: 'learn', id: it.id });
          break;
        }
        case 'preset':
          await rt.setLiveInstrument(p);
          ui.toast(`Live instrument: ${it.title}`, 'ok');
          break;
        case 'theme': {
          const t = themeFromFile(p);
          if (t) {
            THEMES[t.name] = t;
            settings.s.theme = t.name;
            ui.toast(`Theme: ${t.name}`, 'ok');
          }
          break;
        }
      }
    } catch (e: any) {
      ui.toast(`Could not use item: ${e.message}`, 'error');
    }
  }
  async function openLoop(id: string) {
    try {
      const it = await api.get(id);
      await use(it);
    } catch (e: any) {
      ui.toast(`Could not open loop: ${e.message}`, 'error');
    }
  }
  async function remix(it: Item) {
    if (!me) return (showAuth = true);
    if (it.kind !== 'loop') return;
    await use(it);
    ui.toast('Loaded. Record over it, then publish from the export sheet to keep the remix link.', 'info', 6000);
    remixParent = it.id;
  }
  let remixParent: string | null = null;
  export function currentRemixParent() {
    return remixParent;
  }
  async function share(it: Item) {
    try {
      const s = await api.share(it.id);
      await navigator.clipboard?.writeText(s.url);
      ui.toast(`Link copied: ${s.url}`, 'ok');
    } catch (e: any) {
      ui.toast(e.message, 'error');
    }
  }
  async function submitAuth() {
    auth.error = '';
    try {
      const r = auth.mode === 'login' ? await api.login(auth.handle, auth.password) : await api.register(auth.handle, auth.name || auth.handle, auth.password);
      settings.s.communityToken = r.token;
      settings.s.communityHandle = r.user.handle;
      me = r.user;
      showAuth = false;
      auth.password = '';
    } catch (e: any) {
      auth.error = e.message;
    }
  }
  async function logout() {
    await api.logout().catch(() => {});
    settings.s.communityToken = '';
    me = null;
  }
  async function remove(it: Item) {
    if (await ui.ask('Delete', `Delete "${it.title}"?`, 'Delete', true)) {
      await api.remove(it.id);
      detail = null;
      await refresh();
    }
  }
  const KINDS: { v: ItemKind | ''; l: string }[] = [
    { v: '', l: 'All' },
    { v: 'loop', l: 'Loops' },
    { v: 'song', l: 'Songs' },
    { v: 'tutorial', l: 'Tutorials' },
    { v: 'preset', l: 'Presets' },
    { v: 'theme', l: 'Themes' },
  ];
</script>

<div class="page">
  <div class="page-inner">
    <div class="row" style="justify-content:space-between; align-items:flex-end">
      <div><h2>Community</h2><p>Loops, songs, tutorials, presets and themes shared by others. Remixes keep a link to what they were built from.</p></div>
      <div class="row">
        {#if me}
          <span class="small">@{me.handle}</span>
          <button onclick={logout}>Sign out</button>
        {:else}
          <button class="primary" onclick={() => (showAuth = true)} disabled={online === false}>Sign in</button>
        {/if}
      </div>
    </div>
    {#if online === false}
      <div class="glass card offline">
        Community service not reachable at <code>{settings.s.communityUrl}</code>. Start it with <code>cd services/community &amp;&amp; gleam run</code> or set the URL in Settings.
        <button onclick={refresh} style="margin-left:10px">Retry</button>
      </div>
    {/if}
    <div class="row wrap filters">
      <div class="seg">
        {#each KINDS as k}<button class:active={kind === k.v} onclick={() => ((kind = k.v), (page = 1), refresh())}>{k.l}</button>{/each}
      </div>
      <input type="search" placeholder="Search" bind:value={q} onkeydown={(e) => e.key === 'Enter' && ((page = 1), refresh())} />
      <input type="text" placeholder="tag" bind:value={tag} onkeydown={(e) => e.key === 'Enter' && ((page = 1), refresh())} style="width:90px" />
      <select bind:value={sort} onchange={() => ((page = 1), refresh())}><option value="new">Newest</option><option value="top">Most liked</option></select>
      <span class="small">{total} items</span>
    </div>
    <div class="layout" class:withdetail={!!detail}>
      <div class="items">
        {#each items as it (it.id)}
          <button class="item glass" class:active={detail?.id === it.id} onclick={() => open(it)}>
            <span class="kind chip">{it.kind}</span>
            <span class="title">{it.title}</span>
            <span class="by">{it.author?.handle ? '@' + it.author.handle : ''}</span>
            <span class="meta num">♥ {it.like_count} · 💬 {it.comment_count}{it.parent_id ? ' · remix' : ''}</span>
          </button>
        {/each}
        {#if !items.length && !busy && online}<p>Nothing here yet. Publish a loop from the export sheet (Ctrl/Cmd+E).</p>{/if}
      </div>
      {#if detail}
        <aside class="detail glass card col">
          <div class="row" style="justify-content:space-between">
            <span class="chip">{detail.kind}</span>
            <button class="ghost" onclick={() => (detail = null)} aria-label="Close">×</button>
          </div>
          <h2 style="margin:0">{detail.title}</h2>
          <span class="small">by @{detail.author?.handle ?? '?'} · {new Date(detail.created_at).toLocaleDateString()}</span>
          {#if detail.description}<p>{detail.description}</p>{/if}
          <div class="tags">{#each detail.tags as t}<button class="chip" onclick={() => ((tag = t), refresh())}>{t}</button>{/each}</div>
          <div class="row wrap">
            <button class="primary" onclick={() => use(detail!)}>{detail.kind === 'loop' ? 'Load loop' : detail.kind === 'song' ? 'Drop into track 4' : detail.kind === 'tutorial' ? 'Open tutorial' : 'Use'}</button>
            {#if detail.kind === 'loop'}<button onclick={() => remix(detail!)}>Remix</button>{/if}
            <button onclick={() => like(detail!)} aria-pressed={detail.liked}>{detail.liked ? '♥' : '♡'} {detail.like_count}</button>
            <button onclick={() => share(detail!)}>Share link</button>
            {#if me && me.id === detail.author_id}<button onclick={() => remove(detail!)}>Delete</button>{/if}
          </div>
          {#if chain.length > 1}
            <div class="col"><span class="label">Remix chain</span>
              <div class="chain">{#each chain as c, i}<button class="ghost small" onclick={() => open(c)}>{c.title}</button>{#if i < chain.length - 1}<span>→</span>{/if}{/each}</div>
            </div>
          {/if}
          {#if remixes.length}
            <div class="col"><span class="label">Remixes</span>
              <div class="chain">{#each remixes as r}<button class="ghost small" onclick={() => open(r)}>{r.title}</button>{/each}</div>
            </div>
          {/if}
          <div class="col">
            <span class="label">Comments</span>
            {#each comments as c}<div class="comment"><b>@{c.author?.handle ?? '?'}</b> {c.body}</div>{/each}
            <div class="row"><input type="text" placeholder={me ? 'Add a comment' : 'Sign in to comment'} bind:value={newComment} onkeydown={(e) => e.key === 'Enter' && comment()} disabled={!me} /><button onclick={comment} disabled={!me}>Post</button></div>
          </div>
        </aside>
      {/if}
    </div>
    {#if total > 24}
      <div class="row" style="justify-content:center">
        <button disabled={page <= 1} onclick={() => (page--, refresh())}>Prev</button><span class="small">page {page}</span><button disabled={page * 24 >= total} onclick={() => (page++, refresh())}>Next</button>
      </div>
    {/if}
  </div>
</div>

{#if showAuth}
  <div class="backdrop" role="presentation" onclick={() => (showAuth = false)}>
    <form class="glass strong auth fade-in" onsubmit={(e) => (e.preventDefault(), submitAuth())} onclick={(e) => e.stopPropagation()}>
      <div class="seg"><button type="button" class:active={auth.mode === 'login'} onclick={() => (auth.mode = 'login')}>Sign in</button><button type="button" class:active={auth.mode === 'register'} onclick={() => (auth.mode = 'register')}>Create account</button></div>
      <label class="col"><span class="label">Handle</span><input type="text" bind:value={auth.handle} autocomplete="username" required minlength="3" pattern="[a-z0-9_]+" /></label>
      {#if auth.mode === 'register'}<label class="col"><span class="label">Display name</span><input type="text" bind:value={auth.name} /></label>{/if}
      <label class="col"><span class="label">Password</span><input type="password" bind:value={auth.password} autocomplete={auth.mode === 'login' ? 'current-password' : 'new-password'} required minlength="8" /></label>
      {#if auth.error}<p class="err">{auth.error}</p>{/if}
      <div class="row" style="justify-content:flex-end"><button type="button" onclick={() => (showAuth = false)}>Cancel</button><button class="primary" type="submit">{auth.mode === 'login' ? 'Sign in' : 'Create'}</button></div>
    </form>
  </div>
{/if}

<style>
  .offline {
    font-size: 13px;
    color: var(--warn);
  }
  code {
    background: rgba(255, 255, 255, 0.06);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .filters {
    flex-wrap: wrap;
    gap: 10px;
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
    font-size: 12px;
  }
  .layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: 14px;
  }
  .layout.withdetail {
    grid-template-columns: 1fr 360px;
  }
  .items {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px;
    align-content: start;
  }
  .item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 12px;
    text-align: left;
  }
  .title {
    font-weight: 500;
  }
  .by,
  .meta,
  .small {
    font-size: 12px;
    color: var(--text-faint);
  }
  .detail {
    position: sticky;
    top: 0;
    align-self: start;
    gap: 10px;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chain {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  .comment {
    font-size: 13px;
    color: var(--text-dim);
    padding: 4px 0;
    border-bottom: 1px solid var(--line);
  }
  .wrap {
    flex-wrap: wrap;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: grid;
    place-items: center;
    z-index: 70;
  }
  .auth {
    width: min(380px, 90vw);
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .err {
    color: var(--danger);
    font-size: 12px;
  }
</style>
