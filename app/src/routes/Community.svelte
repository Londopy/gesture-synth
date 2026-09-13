<script lang="ts">
  // Community page (spec 9): browse/download songs, tutorials, presets, themes,
  // loops. Accounts, likes, comments, remix chains, search + tags. Backed by
  // the Gleam service.
  import { untrack } from 'svelte';
  import { settings, defaultSettings } from '../lib/state/settings.svelte';
  import { ui } from '../lib/state/ui.svelte';
  import { rt } from '../lib/state/engine.svelte';
  import { router } from '../lib/router/router.svelte';
  import { ApiError, CommunityApi, type Item, type ItemKind, type Comment, type User } from '../lib/community/api';
  import { communityApi } from '../lib/community/client';
  import { THEMES, themeFromFile } from '../lib/themes';
  import { learnState } from './learn-state.svelte';

  // Reachability is owned by the latest refresh() alone: it builds its own
  // client whose waking callback checks it is still the newest list request,
  // so a superseded attempt or any other call on the page can never leave the
  // banner up. 'waking' means the list is waiting on a hosted server that is
  // probably spinning up; 'down' and 'local-down' mean it gave up. A 4xx/500
  // never changes it: the server answered, so it is up.
  type Link = 'unknown' | 'ok' | 'waking' | 'down' | 'local-down';
  const local = $derived(CommunityApi.isLocalUrl(settings.s.communityUrl));
  // Shared client for everything but the list; its waits are announced by the
  // default throttled toast because the page banner belongs to refresh().
  const api = $derived(communityApi());
  // The setup hint only helps someone running the app from source; a hosted
  // visitor whose browser kept an old localhost URL needs a way back instead.
  const devApp = import.meta.env.DEV;
  // Switching back re-runs the list through the URL effect below.
  const defaultUrl = defaultSettings().communityUrl;
  let me = $state<User | null>(null);
  let link = $state<Link>('unknown');
  let wakeSecs = $state(0);
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
    // Re-run only when the URL or token changes; the filters are applied by
    // their own handlers, otherwise every keystroke in Search refires the list.
    api;
    untrack(() => {
      // me() runs after the list, and only once the list has proven the
      // server awake; against a server that just failed to answer for 75 s it
      // would only start a second wait of its own.
      void refresh().then(() => {
        if (settings.s.communityToken && link === 'ok') api.me().then((u) => (me = u)).catch(() => (me = null));
      });
    });
  });

  // Elapsed counter for the waking notice; the retry callback re-syncs it.
  $effect(() => {
    if (link !== 'waking') return;
    const id = setInterval(() => wakeSecs++, 1000);
    return () => clearInterval(id);
  });

  $effect(() => {
    router.openSeq;
    const r = router.route;
    if (r.page === 'community' || r.kind === 'loop') {
      if (r.kind === 'loop' && r.id) void openLoop(r.id);
    }
  });

  // During a wake an early slow response can land after a newer one; only the
  // latest request may write.
  let refreshSeq = 0;
  async function refresh() {
    const my = ++refreshSeq;
    const list = communityApi((_attempt, elapsedMs) => {
      if (local || my !== refreshSeq) return;
      link = 'waking';
      wakeSecs = Math.round(elapsedMs / 1000);
    });
    busy = true;
    try {
      const r = await list.list({ kind: kind || undefined, q, tag, sort, page, per_page: 24 });
      if (my !== refreshSeq) return;
      items = r.items;
      total = r.total;
      link = 'ok';
    } catch (e: any) {
      if (my !== refreshSeq) return;
      if (e instanceof ApiError && !e.offline) {
        link = 'ok';
        ui.toast(`Couldn't load the list: ${e.message}`, 'error');
      } else {
        link = local ? 'local-down' : 'down';
      }
    } finally {
      if (my === refreshSeq) busy = false;
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
      // Same warm-up as the publish flows: the server may have gone to sleep
      // while the page sat open, and a retried comment body would post twice.
      await api.health();
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
    let s: { url: string };
    try {
      s = await api.share(it.id);
    } catch (e: any) {
      return ui.toast(e.message, 'error');
    }
    // After a long wait the click's user activation has expired and the
    // clipboard write is refused; the link still exists, so show it.
    try {
      await navigator.clipboard.writeText(s.url);
      ui.toast(`Link copied: ${s.url}`, 'ok', 6000);
    } catch {
      ui.toast(`Share link: ${s.url}`, 'info', 8000);
    }
  }
  let authBusy = $state(false);
  async function submitAuth() {
    if (authBusy) return;
    auth.error = '';
    authBusy = true;
    try {
      const r = auth.mode === 'login' ? await api.login(auth.handle, auth.password) : await api.register(auth.handle, auth.name || auth.handle, auth.password);
      settings.s.communityToken = r.token;
      settings.s.communityHandle = r.user.handle;
      me = r.user;
      showAuth = false;
      auth.password = '';
    } catch (e: any) {
      auth.error = e.message;
    } finally {
      authBusy = false;
    }
  }
  async function logout() {
    // Forget the token locally first so the header does not stay signed in for
    // the whole wake of a sleeping server; revoking it server-side is best effort.
    const stale = api;
    settings.s.communityToken = '';
    me = null;
    await stale.logout().catch(() => {});
  }
  async function remove(it: Item) {
    if (!(await ui.ask('Delete', `Delete "${it.title}"?`, 'Delete', true))) return;
    try {
      await api.remove(it.id);
      detail = null;
      await refresh();
    } catch (e: any) {
      ui.toast(`Could not delete: ${e.message}`, 'error');
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
          <button class="primary" onclick={() => (showAuth = true)} disabled={link === 'down' || link === 'local-down'}>Sign in</button>
        {/if}
      </div>
    </div>
    {#if link === 'waking'}
      <div class="glass card notice waking" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span>Waking up the community server. It sleeps when nobody's around and takes up to a minute to come back — retrying automatically <span class="num">({wakeSecs} s)</span>.</span>
      </div>
    {:else if link === 'down'}
      <div class="glass card notice offline" role="status">
        <span>The community server isn't answering right now. Check your connection or try again in a minute — everything you've made is safe on this device.</span>
        <button onclick={refresh}>Try again</button>
      </div>
    {:else if link === 'local-down' && devApp}
      <div class="glass card notice offline" role="status">
        <span>No community server at <code>{settings.s.communityUrl}</code>. Start one with <code>cd services/community &amp;&amp; gleam run</code>, or point the app at another server in Settings.</span>
        <button onclick={refresh}>Retry</button>
      </div>
    {:else if link === 'local-down'}
      <div class="glass card notice offline" role="status">
        <span>No community server is answering at <code>{settings.s.communityUrl}</code>. Everything you've made is safe on this device.</span>
        {#if settings.s.communityUrl !== defaultUrl}
          <button onclick={() => (settings.s.communityUrl = defaultUrl)}>Use the default server</button>
        {:else}
          <button onclick={refresh}>Try again</button>
        {/if}
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
        {#if !items.length && busy && link !== 'waking'}<p class="small">Loading…</p>{/if}
        {#if !items.length && !busy && link === 'ok'}<p>Nothing here yet. Publish a loop from the export sheet (Ctrl/Cmd+E).</p>{/if}
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
      <div class="row" style="justify-content:flex-end"><button type="button" onclick={() => (showAuth = false)}>Cancel</button><button class="primary" type="submit" disabled={authBusy}>{authBusy ? 'Connecting…' : auth.mode === 'login' ? 'Sign in' : 'Create'}</button></div>
    </form>
  </div>
{/if}

<style>
  .notice {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }
  .notice button {
    margin-left: auto;
    flex-shrink: 0;
  }
  .offline {
    color: var(--warn);
  }
  .waking {
    color: var(--text-dim);
  }
  .spinner {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 2px solid var(--line);
    border-top-color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
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
