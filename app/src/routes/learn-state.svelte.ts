// Bridge between the Learn page and the scene canvas (which lives in App).
import type { LearnTarget } from '../lib/scene/types';
import type { Song } from '../lib/learn/songs';

class LearnState {
  provider: (() => LearnTarget | null) | null = null;
  /** A song opened from a link/community that is not built in. */
  pending = $state<Song | null>(null);
}

export const learnState = new LearnState();
