// Transport keys (spec 7) with a user-editable map (Settings > shortcuts).

import { rt } from './state/engine.svelte';
import { ui } from './state/ui.svelte';
import { settings } from './state/settings.svelte';

export type Action =
  | 'playPause'
  | 'record'
  | 'track1'
  | 'track2'
  | 'track3'
  | 'track4'
  | 'mute'
  | 'solo'
  | 'clear'
  | 'clearAll'
  | 'toggleMode'
  | 'keyDown'
  | 'keyUp'
  | 'bpmDown'
  | 'bpmUp'
  | 'panic'
  | 'fullscreen'
  | 'help'
  | 'save'
  | 'export'
  | 'grid';

export const ACTION_LABELS: Record<Action, string> = {
  playPause: 'Play / stop',
  record: 'Record on selected track',
  track1: 'Select track 1',
  track2: 'Select track 2',
  track3: 'Select track 3',
  track4: 'Select track 4',
  mute: 'Mute selected track',
  solo: 'Solo selected track',
  clear: 'Clear selected track (Shift: no confirm)',
  clearAll: 'Clear all tracks',
  toggleMode: 'Toggle Gesture / Theremin',
  keyDown: 'Key down (circle of fifths)',
  keyUp: 'Key up (circle of fifths)',
  bpmDown: 'BPM -1 (Shift: -10)',
  bpmUp: 'BPM +1 (Shift: +10)',
  panic: 'Panic (all notes off)',
  fullscreen: 'Toggle performance view',
  help: 'Help overlay',
  save: 'Save session',
  export: 'Export',
  grid: 'Toggle beat grid',
};

/** Normalise a KeyboardEvent into the combo string format used in settings. */
export function comboOf(e: KeyboardEvent): string {
  const mod = e.ctrlKey || e.metaKey;
  let k = e.key;
  if (k === ' ') k = ' ';
  const parts: string[] = [];
  if (mod) parts.push('Mod');
  if (e.shiftKey && k.length > 1) parts.push('Shift'); // Shift only matters for non-character keys
  parts.push(k.length === 1 ? k.toLowerCase() : k);
  return parts.join('+');
}

export function comboLabel(c: string): string {
  return c
    .replace('Mod', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
    .replace(' ', 'Space')
    .replace('Escape', 'Esc')
    .replace('Delete', 'Del');
}

export type Hooks = { save: () => void; export: () => void; help: () => void };

let hooks: Hooks = { save: () => {}, export: () => {}, help: () => ui.toggleHelp() };

export function setKeyHooks(h: Partial<Hooks>) {
  hooks = { ...hooks, ...h };
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export function handleKeydown(e: KeyboardEvent): boolean {
  if (isTyping(e) && e.key !== 'Escape') return false;
  if (ui.help && e.key === 'Escape') {
    ui.help = false;
    return true;
  }
  const map = settings.s.shortcuts;
  const combo = comboOf(e);
  const shiftCombo = e.shiftKey ? (combo.startsWith('Shift+') ? combo : `Shift+${combo}`) : combo;
  let action: Action | null = null;
  for (const [a, c] of Object.entries(map)) {
    if (c === shiftCombo) {
      action = a as Action;
      break;
    }
  }
  if (!action) {
    for (const [a, c] of Object.entries(map)) {
      if (c === combo) {
        action = a as Action;
        break;
      }
    }
  }
  if (!action) {
    if (e.key === '?') action = 'help';
    else if (e.key === '_') action = 'bpmDown';
    else if (e.key === '+') action = 'bpmUp';
    else return false;
  }
  e.preventDefault();
  run(action, e);
  return true;
}

export async function run(action: Action, e?: KeyboardEvent) {
  const shift = !!e?.shiftKey;
  switch (action) {
    case 'playPause':
      rt.togglePlay();
      break;
    case 'record':
      rt.toggleRecord();
      break;
    case 'track1':
    case 'track2':
    case 'track3':
    case 'track4':
      rt.selectTrack(Number(action.slice(5)) - 1);
      break;
    case 'mute':
      rt.toggleMute();
      break;
    case 'solo':
      rt.toggleSolo();
      break;
    case 'clear': {
      const t = rt.position.selected;
      if (shift || (await ui.ask('Clear track', `Clear track ${t + 1}? This removes its recorded loop.`, 'Clear', true))) rt.clearTrack(t);
      break;
    }
    case 'clearAll':
      if (await ui.ask('Clear all tracks', 'Remove every recorded loop?', 'Clear all', true)) rt.clearAll();
      break;
    case 'toggleMode':
      rt.toggleMode();
      break;
    case 'keyDown':
      rt.stepKey(-1);
      break;
    case 'keyUp':
      rt.stepKey(1);
      break;
    case 'bpmDown':
      rt.nudgeBpm(shift ? -10 : -1);
      break;
    case 'bpmUp':
      rt.nudgeBpm(shift ? 10 : 1);
      break;
    case 'panic':
      rt.panic();
      ui.toast('Panic: all notes off', 'warn', 1500);
      break;
    case 'fullscreen':
      ui.toggleFullscreen();
      break;
    case 'help':
      hooks.help();
      break;
    case 'save':
      hooks.save();
      break;
    case 'export':
      hooks.export();
      break;
    case 'grid':
      ui.toggleGrid();
      break;
  }
}
