// Stage UI sounds, synthesised in the current key so the menu is in tune with
// whatever was played last. Uses its own tiny AudioContext instead of the
// engine: these are interface sounds, not instrument notes, and must not end
// up in recordings or MIDI. Every function is safe to call before the user
// has clicked (it simply does nothing until the context can start).
import { degreeRoot } from '../music';
import { rt } from '../state/engine.svelte';
import { settings } from '../state/settings.svelte';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function graph(): { ctx: AudioContext; out: GainNode } | null {
  if (!settings.s.gameAudio) return null;
  if (typeof AudioContext === 'undefined') return null;
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  if (ctx.state !== 'running') return null;
  master!.gain.value = settings.s.gameVolume * 0.5;
  return { ctx, out: master! };
}

/** MIDI note -> Hz. */
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** Root of a scale degree in the live key, as a MIDI note around C4. */
function degreeMidi(degree: number, octave = 0): number {
  return 60 + degreeRoot(rt.live.key, rt.live.minor, degree) + 12 * octave;
}

interface Note {
  midi: number;
  at: number; // seconds from now
  dur: number;
  gain?: number;
  type?: OscillatorType;
  glideTo?: number;
}

function play(notes: Note[]) {
  const g = graph();
  if (!g) return;
  const now = g.ctx.currentTime;
  for (const n of notes) {
    const osc = g.ctx.createOscillator();
    const env = g.ctx.createGain();
    osc.type = n.type ?? 'triangle';
    osc.frequency.setValueAtTime(hz(n.midi), now + n.at);
    if (n.glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(hz(n.glideTo), now + n.at + n.dur);
    const peak = n.gain ?? 0.5;
    env.gain.setValueAtTime(0.0001, now + n.at);
    env.gain.exponentialRampToValueAtTime(peak, now + n.at + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, now + n.at + n.dur);
    osc.connect(env).connect(g.out);
    osc.start(now + n.at);
    osc.stop(now + n.at + n.dur + 0.02);
  }
}

let lastHover = 0;

export const sfx = {
  /** Resting on a menu key: a short tick on that degree's root. Rate-limited so a sweep down the menu is a strum, not a rattle. */
  hover(degree: number) {
    const t = performance.now();
    if (t - lastHover < 45) return;
    lastHover = t;
    play([{ midi: degreeMidi(degree), at: 0, dur: 0.09, gain: 0.35, type: 'sine' }]);
  },
  /** Generic click: a fifth. */
  click() {
    play([
      { midi: degreeMidi(1), at: 0, dur: 0.08, gain: 0.35 },
      { midi: degreeMidi(5), at: 0.03, dur: 0.1, gain: 0.3 },
    ]);
  },
  /** Confirming a choice: I then the octave. */
  confirm(degree = 1) {
    play([
      { midi: degreeMidi(degree), at: 0, dur: 0.12, gain: 0.4 },
      { midi: degreeMidi(degree, 1), at: 0.07, dur: 0.18, gain: 0.35 },
    ]);
  },
  /** Going back: a falling third. */
  back() {
    play([
      { midi: degreeMidi(3), at: 0, dur: 0.08, gain: 0.3 },
      { midi: degreeMidi(1), at: 0.06, dur: 0.14, gain: 0.3 },
    ]);
  },
  /** Wheel tick while browsing sets: a soft high tap. */
  tick() {
    play([{ midi: degreeMidi(5, 1), at: 0, dur: 0.05, gain: 0.2, type: 'sine' }]);
  },
  /** Something was unlocked or completed: I - V - I arpeggio up an octave. */
  fanfare() {
    play([
      { midi: degreeMidi(1), at: 0, dur: 0.25, gain: 0.4 },
      { midi: degreeMidi(3), at: 0.1, dur: 0.25, gain: 0.35 },
      { midi: degreeMidi(5), at: 0.2, dur: 0.3, gain: 0.35 },
      { midi: degreeMidi(1, 1), at: 0.32, dur: 0.6, gain: 0.45 },
    ]);
  },
  /** Judgment sounds while playing a set: a pluck on the chord root for a hit, a dull thud for a drop. */
  judge(j: 'locked' | 'onit' | 'early' | 'late' | 'dropped', degree = 1) {
    if (j === 'dropped') {
      play([
        { midi: 38, at: 0, dur: 0.12, gain: 0.35, type: 'square', glideTo: 30 },
        { midi: 45, at: 0, dur: 0.08, gain: 0.2, type: 'sawtooth', glideTo: 36 },
      ]);
    } else if (j === 'locked') play([{ midi: degreeMidi(degree, 1), at: 0, dur: 0.14, gain: 0.45 }]);
    else if (j === 'onit') play([{ midi: degreeMidi(degree), at: 0, dur: 0.12, gain: 0.38 }]);
    else play([{ midi: degreeMidi(degree), at: 0, dur: 0.06, gain: 0.22, type: 'sine' }]);
  },
  /** A run broke: two falling notes. */
  runBreak() {
    play([
      { midi: degreeMidi(5), at: 0, dur: 0.1, gain: 0.3 },
      { midi: degreeMidi(1), at: 0.09, dur: 0.16, gain: 0.3 },
    ]);
  },
  /** Called from the first user gesture so later sounds are not swallowed by autoplay policy. */
  warm() {
    graph();
  },
};
