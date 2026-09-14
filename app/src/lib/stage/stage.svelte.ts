// Stage: the game shell. A handful of full-screen screens layered over the
// scene (boot, menu, sets) plus a 'page' state in which the normal Studio
// chrome shows with a Menu button. Nothing here touches the engine; screens
// call the runtime themselves.
import { router, type Page } from '../router/router.svelte';
import { settings } from '../state/settings.svelte';
import type { SetScore, VariationId } from './score';

export type StageScreen = 'boot' | 'menu' | 'sets' | 'set' | 'results' | 'profile' | 'page';

export interface SetResult {
  songId: string;
  songName: string;
  score: SetScore;
  variations: VariationId[];
  bpm: number;
  newBest: boolean;
  xpGained: number;
}

class StageStore {
  /** The intro plays until it has been seen three times; after that Stage opens on the menu. */
  screen = $state<StageScreen>(settings.s.introSeen >= 3 ? 'menu' : 'boot');
  /** song id highlighted on the Sets wheel; survives leaving and coming back */
  selectedSet = $state<string | null>(null);
  /** true while a screen transition is playing (blocks double clicks) */
  busy = $state(false);
  /** Variations chosen on the Sets screen; applied when a set starts */
  variations = $state<VariationId[]>([]);
  /** The set that just finished, for the Results screen */
  lastResult = $state<SetResult | null>(null);

  get active(): boolean {
    return settings.s.shell === 'stage';
  }

  toMenu() {
    this.screen = 'menu';
  }

  toSets() {
    this.screen = 'sets';
  }

  /** Play `songId` for a rating. */
  playSet(songId: string) {
    this.selectedSet = songId;
    this.screen = 'set';
  }

  toProfile() {
    this.screen = 'profile';
  }

  toggleVariation(v: VariationId) {
    this.variations = this.variations.includes(v) ? this.variations.filter((x) => x !== v) : [...this.variations, v];
    // the two tempo variations exclude each other
    if (v === 'halftime') this.variations = this.variations.filter((x) => x !== 'doubletime');
    if (v === 'doubletime') this.variations = this.variations.filter((x) => x !== 'halftime');
  }

  /** Leave the Stage screens for one of the normal pages. */
  openPage(page: Page) {
    this.screen = 'page';
    router.go(page);
  }

  /** Called when the intro finishes or is skipped. */
  introDone() {
    if (this.screen !== 'boot') return;
    settings.s.introSeen = Math.min(3, settings.s.introSeen + 1);
    this.screen = 'menu';
  }
}

export const stage = new StageStore();
