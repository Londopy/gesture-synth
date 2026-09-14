// Community board glue for Stage: post a finished set when signed in, fetch a
// song's board. Failures are quiet (a toast at most): the local board is the
// source of truth on this device and the community one is a bonus.
import type { BoardEntry } from '../community/api';
import { communityApi } from '../community/client';
import { settings } from '../state/settings.svelte';
import { ui } from '../state/ui.svelte';
import type { SetRecord } from './records.svelte';

const cache = new Map<string, { at: number; entries: BoardEntry[] }>();

export const signedIn = () => !!settings.s.communityToken;

export async function fetchBoard(songId: string, force = false): Promise<BoardEntry[]> {
  const hit = cache.get(songId);
  if (!force && hit && Date.now() - hit.at < 60_000) return hit.entries;
  const api = communityApi(() => {});
  const r = await api.scores(songId, 10);
  cache.set(songId, { at: Date.now(), entries: r.scores });
  return r.scores;
}

/** Post a set; returns the saved entry or null when not signed in / rehearsal / offline. */
export async function postSet(r: SetRecord): Promise<BoardEntry | null> {
  if (!signedIn() || r.variations.includes('rehearsal')) return null;
  try {
    const api = communityApi();
    const saved = await api.postScore({ song_id: r.songId, score: r.score, accuracy: r.accuracy, run: r.bestRun, rating: r.rating, variations: r.variations });
    cache.delete(r.songId);
    return saved;
  } catch (e: any) {
    ui.toast(`Board: ${e?.message ?? 'could not post the set'}`, 'warn', 4000);
    return null;
  }
}
