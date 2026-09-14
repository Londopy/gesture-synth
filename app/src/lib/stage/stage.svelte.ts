// Stage: the game shell. A handful of full-screen screens layered over the
// scene (boot, menu, sets) plus a 'page' state in which the normal Studio
// chrome shows with a Menu button. Nothing here touches the engine; screens
// call the runtime themselves.
import { router, type Page } from '../router/router.svelte';
import { settings } from '../state/settings.svelte';

export type StageScreen = 'boot' | 'menu' | 'sets' | 'page';

class StageStore {
  /** The intro plays until it has been seen three times; after that Stage opens on the menu. */
  screen = $state<StageScreen>(settings.s.introSeen >= 3 ? 'menu' : 'boot');
  /** song id highlighted on the Sets wheel; survives leaving and coming back */
  selectedSet = $state<string | null>(null);
  /** true while a screen transition is playing (blocks double clicks) */
  busy = $state(false);

  get active(): boolean {
    return settings.s.shell === 'stage';
  }

  toMenu() {
    this.screen = 'menu';
  }

  toSets() {
    this.screen = 'sets';
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
