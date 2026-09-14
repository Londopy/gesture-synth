// Tiny history router for the entry points in spec 9.5:
//   /  /learn  /learn/<id>  /song/<id>  /loop/<id>  /preset/<id>  /builder
//   /instruments  /visuals  /community  /settings  /open?u=gsyn://...
// Desktop registers gsyn:// for the same paths.

export type Page = 'play' | 'learn' | 'builder' | 'instruments' | 'visuals' | 'community' | 'achievements' | 'settings';

export interface Route {
  page: Page;
  /** content to open: song/loop/tutorial/preset id */
  kind?: 'song' | 'loop' | 'learn' | 'preset' | 'demo';
  id?: string;
}

export const PAGES: { id: Page; label: string; path: string; icon: string }[] = [
  { id: 'play', label: 'Play', path: '/', icon: 'play' },
  { id: 'learn', label: 'Learn', path: '/learn', icon: 'learn' },
  { id: 'builder', label: 'Song Builder', path: '/builder', icon: 'builder' },
  { id: 'instruments', label: 'Instruments', path: '/instruments', icon: 'instruments' },
  { id: 'visuals', label: 'Visuals', path: '/visuals', icon: 'visuals' },
  { id: 'community', label: 'Community', path: '/community', icon: 'community' },
  { id: 'achievements', label: 'Medals', path: '/medals', icon: 'medals' },
  { id: 'settings', label: 'Settings', path: '/settings', icon: 'settings' },
];

export function parsePath(pathname: string, search = ''): Route {
  let path = pathname.replace(/\/+$/, '') || '/';
  // gsyn:// deep links and web+gsyn protocol handler land on /open?u=...
  if (path === '/open') {
    const u = new URLSearchParams(search).get('u') ?? '';
    const m = u.match(/^(?:web\+)?gsyn:\/\/(.*)$/);
    if (m) return parsePath('/' + m[1].replace(/^\/+/, ''));
    return { page: 'play' };
  }
  const seg = path.split('/').filter(Boolean);
  if (seg.length === 0) return { page: 'play' };
  switch (seg[0]) {
    case 'song':
      return { page: 'builder', kind: 'song', id: seg[1] };
    case 'loop':
      return { page: 'play', kind: 'loop', id: seg[1] };
    case 'learn':
      return { page: 'learn', kind: seg[1] ? 'learn' : undefined, id: seg[1] };
    case 'preset':
      return { page: 'instruments', kind: 'preset', id: seg[1] };
    case 'demo':
      // /demo opens the picker, /demo/<id> starts that demo on the Play page
      return { page: 'play', kind: 'demo', id: seg[1] };
    case 'builder':
      return { page: 'builder' };
    case 'instruments':
      return { page: 'instruments' };
    case 'visuals':
      return { page: 'visuals' };
    case 'community':
      return { page: 'community' };
    case 'medals':
    case 'achievements':
      return { page: 'achievements' };
    case 'settings':
      return { page: 'settings' };
    case 's':
      // short link handled server-side; if it reaches us, go home
      return { page: 'play' };
    default:
      return { page: 'play' };
  }
}

export function pathFor(r: Route): string {
  if (r.kind === 'demo' && !r.id) return '/demo';
  if (r.kind && r.id) {
    const base = r.kind === 'learn' ? '/learn' : `/${r.kind}`;
    return `${base}/${encodeURIComponent(r.id)}`;
  }
  return PAGES.find((p) => p.id === r.page)?.path ?? '/';
}

class Router {
  route = $state<Route>(typeof location !== 'undefined' ? parsePath(location.pathname, location.search) : { page: 'play' });
  /** Bumps whenever a content link is opened so pages can react even if same id. */
  openSeq = $state(0);

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('popstate', () => {
      this.route = parsePath(location.pathname, location.search);
      this.openSeq++;
    });
  }

  go(page: Page) {
    this.navigate({ page });
  }

  navigate(r: Route, replace = false) {
    const path = pathFor(r);
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
    this.route = r;
    this.openSeq++;
  }

  /** Open any gsyn:// or https URL pointing at app content. */
  openUrl(url: string) {
    try {
      const m = url.match(/^(?:web\+)?gsyn:\/\/(.*)$/);
      if (m) return this.navigate(parsePath('/' + m[1].replace(/^\/+/, '')));
      const u = new URL(url, location.origin);
      this.navigate(parsePath(u.pathname, u.search));
    } catch {
      /* ignore */
    }
  }
}

export const router = new Router();
