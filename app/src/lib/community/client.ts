// Shared construction of the community client. Every page builds its client
// here so the retry policy and the "server is waking" feedback are the same
// whether the user browses, publishes or follows a share link.
import { CommunityApi } from './api';
import { settings } from '../state/settings.svelte';
import { ui } from '../state/ui.svelte';

export const WAKING_TEXT = "Waking up the community server. It sleeps when nobody's around and can take up to a minute to come back.";

export function communityApi(onWaking: CommunityApi['onWaking'] = wakeToaster()): CommunityApi {
  return new CommunityApi(settings.s.communityUrl, settings.s.communityToken, { onWaking });
}

/**
 * onWaking handler for flows without their own waking UI: one toast when a wait
 * starts, another every ~20 s while it continues, never one per attempt (a
 * dozen stacked toasts would read as a dozen failures). Throttled on the clock
 * rather than on the request's own elapsed time because one page-level client
 * serves many requests, and a wake an hour later deserves its own toast.
 */
export function wakeToaster(): (attempt: number, elapsedMs: number) => void {
  let lastAt = -Infinity;
  return (_attempt, elapsedMs) => {
    const now = Date.now();
    if (now - lastAt < 20_000) return;
    lastAt = now;
    ui.toast(elapsedMs < 20_000 ? WAKING_TEXT : 'Still waking up the community server, hang on…', 'info', 12_000);
  };
}

let lastWarm = 0;

/**
 * Fire one cheap GET /health so a sleeping hosted server starts booting before
 * the user reaches the Community page. Not called on app load: the landing
 * page promises nothing leaves the device until the user asks for it, and
 * resting the pointer (or focus) on the Community entry in the rail is that
 * ask; the rail waits out a short dwell so a sweep past the entry on the way to
 * Settings does not count. Once a minute at most; a local dev server never
 * sleeps so it is not pinged.
 */
export function prewarmCommunity() {
  const url = settings.s.communityUrl;
  if (!url || CommunityApi.isLocalUrl(url)) return;
  const now = Date.now();
  if (now - lastWarm < 60_000) return;
  lastWarm = now;
  fetch(url.replace(/\/$/, '') + '/health', { mode: 'cors', headers: { Accept: 'application/json' } }).catch(() => {});
}
