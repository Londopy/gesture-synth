// Menu music and set previews for Stage. Both play through the real engine by
// borrowing loop track 4 and the transport, so the sound is the instrument
// itself, in the user's key. The borrow is conservative: it only happens when
// track 4 is empty and nothing is playing, and everything it changes (tempo,
// bars, time signature, track volume, metronome, dirty flag) is put back.
import { PITCH_NAMES } from '../music';
import type { Song } from '../learn/songs';
import { rt } from '../state/engine.svelte';
import { settings } from '../state/settings.svelte';

const TRACK = 3; // loop track 4 (0-based)

interface Snapshot {
  bpm: number;
  beats: number;
  unit: number;
  bars: number;
  key: number;
  minor: boolean;
  volume: number;
  metronomeVolume: number;
  dirty: boolean;
}

let snapshot: Snapshot | null = null;
let owner: 'menu' | 'preview' | null = null;

/** Eight bars of I - vi - IV - V with sevenths in the live key; the menu's backing. */
export function menuSong(): Song {
  const key = PITCH_NAMES[rt.live.key] ?? 'C';
  const chords: Song['chords'] = [];
  const prog: [number, 'major' | 'minor', Song['chords'][0]['shape']][] = [
    [1, 'major', 'seventh'],
    [6, 'minor', 'seventh'],
    [4, 'major', 'seventh'],
    [5, 'major', 'root'],
  ];
  for (let bar = 1; bar <= 8; bar++) {
    const [degree, quality, shape] = prog[(bar - 1) % 4];
    chords.push({ bar, beat: 1, degree, quality, shape, octave: 0, dur_beats: 4 });
  }
  return {
    version: 1,
    name: 'Stage menu',
    author: 'Gesture Synth',
    bpm: 72,
    time_sig: '4/4',
    key,
    mode: 'major',
    bars: 8,
    chords,
    hints: { left_scheme: { kind: 'full' }, right_scheme: { kind: 'full' } },
    tags: ['stage'],
    instrument: 'Pad',
  };
}

function canBorrow(): boolean {
  if (rt.phase !== 'ready') return false;
  if (rt.position.state !== 0) return false; // something is playing or recording
  const t = rt.trackSummary[TRACK];
  return !t || t.empty;
}

/**
 * Load `song` into track 4 at `volume` and play it. Returns false when the
 * transport is in use or track 4 holds the user's loop, in which case nothing
 * changes. A second call while borrowed swaps the song in place.
 */
export async function borrow(who: 'menu' | 'preview', song: Song, volume: number): Promise<boolean> {
  if (!owner) {
    if (!canBorrow()) return false;
    const p = rt.position;
    snapshot = { bpm: p.bpm, beats: p.beats, unit: p.unit, bars: p.bars, key: rt.live.key, minor: rt.live.minor, volume: rt.tracks[TRACK]?.volume ?? 0.8, metronomeVolume: settings.s.metronomeVolume, dirty: rt.dirty };
    owner = who;
  } else {
    rt.stop();
    rt.clearTrack(TRACK);
    owner = who;
  }
  const [b, u] = song.time_sig.split('/').map(Number);
  rt.setTimeSig(b || 4, u || 4);
  rt.setBars(song.bars);
  rt.setBpm(song.bpm);
  await rt.loadSongIntoTrack(JSON.stringify(song), TRACK);
  rt.setTrackVolume(TRACK, volume);
  rt.cmd({ cmd: 'set_metronome_volume', volume: 0 });
  rt.play();
  return true;
}

/** Stop and give everything back. Safe to call when nothing was borrowed. */
export function release(who?: 'menu' | 'preview') {
  if (!owner || (who && owner !== who)) return;
  rt.stop();
  rt.clearTrack(TRACK);
  const s = snapshot!;
  rt.setTimeSig(s.beats, s.unit);
  rt.setBars(s.bars);
  rt.setBpm(s.bpm);
  rt.setKey(s.key, s.minor);
  rt.setTrackVolume(TRACK, s.volume);
  rt.cmd({ cmd: 'set_metronome_volume', volume: s.metronomeVolume });
  rt.dirty = s.dirty;
  snapshot = null;
  owner = null;
}

export function borrowedBy(): 'menu' | 'preview' | null {
  return owner;
}

/** Menu music if the settings allow it and the transport is free. */
export async function startMenuMusic(): Promise<boolean> {
  if (!settings.s.gameAudio || !settings.s.menuMusic) return false;
  if (owner === 'menu') return true;
  return borrow('menu', menuSong(), 0.25);
}

export function stopMenuMusic() {
  release('menu');
}
