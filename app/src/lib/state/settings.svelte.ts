// Persisted user settings (spec 9 "Settings"). Stored in localStorage on both
// platforms; the desktop build additionally mirrors them into the data folder.

import type { ParserConfig } from '../tracking/parser';
import { isPhone } from '../platform';

export interface Shortcuts {
  [action: string]: string;
}

export const DEFAULT_SHORTCUTS: Shortcuts = {
  playPause: ' ',
  record: 'r',
  track1: '1',
  track2: '2',
  track3: '3',
  track4: '4',
  mute: 'm',
  solo: 's',
  clear: 'Delete',
  clearAll: 'Shift+Delete',
  toggleMode: 'Tab',
  keyDown: '[',
  keyUp: ']',
  bpmDown: '-',
  bpmUp: '=',
  panic: 'Escape',
  fullscreen: 'f',
  help: 'h',
  save: 'Mod+s',
  export: 'Mod+e',
  grid: 'g',
  viewMode: 'c',
  recordVideo: 'Mod+Shift+r',
};

export interface Settings {
  version: number;
  firstRunDone: boolean;
  tourDone: boolean;
  parser: ParserConfig;
  theme: string;
  particleDensity: number;
  ghostOpacity: number;
  /** performance = no feed, practice = tinted feed under effects, clear = raw camera, no effects */
  viewMode: 'performance' | 'practice' | 'clear';
  clearShowHands: boolean;
  recSource: 'scene' | 'camera';
  recMic: boolean;
  recMicDeviceId: string;
  recMicGain: number;
  recFormat: 'webm' | 'mp4';
  recFps: number;
  bloom: boolean;
  reducedMotion: boolean;
  highContrast: boolean;
  telemetry: boolean;
  cameraDeviceId: string;
  audioDeviceId: string;
  bufferSize: number;
  midiOut: boolean;
  midiPortId: string;
  midiLiveChannel: number;
  metronomeVolume: number;
  metronomeEnabled: boolean;
  metronomeMonitor: boolean;
  quantizeInput: 'off' | 'recording' | 'always';
  quantize: 'off' | 'sixteenth' | 'eighth' | 'triplet';
  recordMode: 'overdub' | 'replace';
  loopRecord: boolean;
  wrapAtLoopEnd: boolean;
  countInBars: number;
  liveInstrument: string;
  thereminInstrument: string;
  shortcuts: Shortcuts;
  showHud: boolean;
  showGrid: boolean;
  nativeAudio: boolean;
  communityUrl: string;
  communityToken: string;
  communityHandle: string;
  flatNames: boolean;
}

const KEY = 'gsyn.settings.v1';

function defaultParser(): ParserConfig {
  return {
    stable_ms: 90,
    left: isPhone ? { kind: 'fixed_degree', degree: 1 } : { kind: 'full' },
    right: { kind: 'full' },
    mode: isPhone ? 'theremin' : 'gesture',
    fixed_quality: null,
    voicing: { minor_four_finger: 'half_dim7', open_voicing: false },
    calibration: { top_y: 0.15, bottom_y: 0.85, mirror_frame: false, swap_hands: false, invert_tilt: false },
    theremin_snap: false,
    theremin_base_midi: 48,
    theremin_range: 24,
    flick_threshold: 2.5,
    latch_hold_ms: 2000,
    confidence_floor: 0.6,
    cutoff_tc: 0.08,
    volume_tc: 0.06,
  };
}

export function defaultSettings(): Settings {
  return {
    version: 1,
    firstRunDone: false,
    tourDone: false,
    parser: defaultParser(),
    theme: 'Neon',
    particleDensity: isPhone ? 0.1 : 1,
    ghostOpacity: 0.35,
    viewMode: 'performance',
    clearShowHands: true,
    recSource: 'scene',
    recMic: false,
    recMicDeviceId: '',
    recMicGain: 1,
    recFormat: 'webm',
    recFps: 30,
    bloom: !isPhone,
    reducedMotion: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    highContrast: false,
    telemetry: false,
    cameraDeviceId: '',
    audioDeviceId: '',
    bufferSize: 128,
    midiOut: false,
    midiPortId: '',
    midiLiveChannel: 1,
    metronomeVolume: 0.6,
    metronomeEnabled: true,
    metronomeMonitor: true,
    quantizeInput: 'recording',
    quantize: 'sixteenth',
    recordMode: 'overdub',
    loopRecord: false,
    wrapAtLoopEnd: true,
    countInBars: 1,
    liveInstrument: 'Pad',
    thereminInstrument: 'Lead',
    shortcuts: { ...DEFAULT_SHORTCUTS },
    showHud: true,
    showGrid: false,
    nativeAudio: true,
    communityUrl: import.meta.env.VITE_COMMUNITY_URL ?? 'http://localhost:8787',
    communityToken: '',
    communityHandle: '',
    flatNames: false,
  };
}

function load(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const saved = JSON.parse(raw);
    if (saved.cameraFeed && !saved.viewMode) saved.viewMode = 'practice';
    return {
      ...d,
      ...saved,
      parser: { ...d.parser, ...(saved.parser ?? {}), calibration: { ...d.parser.calibration, ...(saved.parser?.calibration ?? {}) }, voicing: { ...d.parser.voicing, ...(saved.parser?.voicing ?? {}) } },
      shortcuts: { ...d.shortcuts, ...(saved.shortcuts ?? {}) },
    };
  } catch {
    return d;
  }
}

class SettingsStore {
  s = $state<Settings>(load());
  private timer = 0;

  constructor() {
    $effect.root(() => {
      $effect(() => {
        // deep read to subscribe
        const snapshot = JSON.stringify(this.s);
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          try {
            localStorage.setItem(KEY, snapshot);
          } catch {
            /* storage may be unavailable */
          }
        }, 150);
      });
      $effect(() => {
        document.documentElement.dataset.motion = this.s.reducedMotion ? 'reduced' : 'full';
        document.documentElement.dataset.contrast = this.s.highContrast ? 'high' : 'normal';
      });
    });
  }

  reset() {
    this.s = defaultSettings();
  }

  export(): string {
    return JSON.stringify(this.s, null, 2);
  }

  import(json: string) {
    const parsed = JSON.parse(json);
    this.s = { ...defaultSettings(), ...parsed };
  }
}

export const settings = new SettingsStore();
