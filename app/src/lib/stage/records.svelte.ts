// Local Stage records: best take per song, recent sets, lifetime XP. Kept
// apart from the achievements stats so a reset of one does not touch the
// other, and so the community board later has a clean shape to post.
import type { Rating, VariationId } from './score';
import { RATING_ORDER } from './score';

export interface SetRecord {
  songId: string;
  songName: string;
  score: number;
  accuracy: number;
  bestRun: number;
  rating: Rating;
  variations: VariationId[];
  at: number;
}

interface Saved {
  bests: Record<string, SetRecord>;
  recent: SetRecord[];
  xp: number;
  sets: number;
}

const KEY = 'gsyn.stage.v1';

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Saved>;
      return { bests: s.bests ?? {}, recent: s.recent ?? [], xp: s.xp ?? 0, sets: s.sets ?? 0 };
    }
  } catch {
    /* fresh */
  }
  return { bests: {}, recent: [], xp: 0, sets: 0 };
}

class Records {
  bests = $state<Record<string, SetRecord>>(load().bests);
  recent = $state<SetRecord[]>(load().recent);
  xp = $state(load().xp);
  sets = $state(load().sets);

  /** Record a finished set. Returns whether it beat the previous best (by score). */
  record(r: SetRecord): { newBest: boolean; xpGained: number } {
    const prev = this.bests[r.songId];
    const newBest = !prev || r.score > prev.score;
    if (newBest) this.bests = { ...this.bests, [r.songId]: r };
    this.recent = [r, ...this.recent].slice(0, 50);
    const xpGained = Math.round(r.score / 100) + 50 * RATING_ORDER.indexOf(r.rating);
    this.xp += xpGained;
    this.sets++;
    this.save();
    return { newBest, xpGained };
  }

  best(songId: string): SetRecord | undefined {
    return this.bests[songId];
  }

  reset() {
    this.bests = {};
    this.recent = [];
    this.xp = 0;
    this.sets = 0;
    this.save();
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ bests: this.bests, recent: this.recent, xp: this.xp, sets: this.sets }));
    } catch {
      /* storage may be unavailable */
    }
  }
}

export const records = new Records();
