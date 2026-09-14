// Medal definitions. Pure data + pure predicates over the Stats snapshot so
// the whole set is unit-testable without the app running.

import { DEMO_IDS } from '../demo/ids';

export type Tier = 'bronze' | 'silver' | 'gold' | 'platinum';
export type Category = 'play' | 'loop' | 'learn' | 'explore' | 'dedication' | 'hush';

export const CATEGORY_INFO: Record<Category, { name: string; blurb: string; icon: string }> = {
  play: { name: 'Playing', blurb: 'Chords, shapes, keys and dynamics.', icon: '🖐️' },
  loop: { name: 'Looping', blurb: 'The loop pedal and the grid.', icon: '🔁' },
  learn: { name: 'Learning', blurb: 'Tutorials and the song builder.', icon: '🎓' },
  explore: { name: 'Exploring', blurb: 'Every corner of the app.', icon: '🧭' },
  dedication: { name: 'Dedication', blurb: 'Time and days.', icon: '⏳' },
  hush: { name: 'Hush-Hush', blurb: 'Medals that give no hint until you have them.', icon: '🤫' },
};

export interface Stats {
  chords: number;
  sevenths: number;
  degrees: number[]; // distinct 1..7
  shapes: number[]; // distinct 0..3
  qualities: number[]; // distinct 0..2
  octaves: number[]; // distinct -1,0,1
  keys: number[]; // distinct pitch classes played in
  keyGestures: number; // key changes by the two-fist gesture
  bassHits: number;
  arpToggles: number;
  latches: number;
  thereminSeconds: number;
  playSeconds: number;
  days: string[]; // YYYY-MM-DD played
  loops: number;
  overdubs: number;
  maxTracksFilled: number;
  stepMutes: number;
  chordEdits: number;
  oddMeterLoops: number;
  maxBpmRecorded: number;
  minBpmRecorded: number;
  tutorialsDone: number;
  bestTutorialScore: number;
  bestPerfectStreak: number;
  songsBuilt: number;
  themesUsed: string[];
  instrumentsUsed: string[];
  clearViewUsed: boolean;
  videosSaved: number;
  exports: number;
  publishes: number;
  sessionsSaved: number;
  tourDone: boolean;
  secretsFound: number;
  eggs: string[];
  nightSessions: number;
  quickChanges: number; // major<->minor within 10 s
  chordsInOneSession: number;
  bestChordsInOneSession: number;
  demosWatched: string[]; // distinct demo ids watched to the end
  demoPlays: number;
  // Stage sets: how many finished, best rating tier per song (0 rough .. 5 flawless), longest run
  setsPlayed: number;
  setRatings: Record<string, number>;
  bestRun: number;
}

export function emptyStats(): Stats {
  return {
    chords: 0,
    sevenths: 0,
    degrees: [],
    shapes: [],
    qualities: [],
    octaves: [],
    keys: [],
    keyGestures: 0,
    bassHits: 0,
    arpToggles: 0,
    latches: 0,
    thereminSeconds: 0,
    playSeconds: 0,
    days: [],
    loops: 0,
    overdubs: 0,
    maxTracksFilled: 0,
    stepMutes: 0,
    chordEdits: 0,
    oddMeterLoops: 0,
    maxBpmRecorded: 0,
    minBpmRecorded: 999,
    tutorialsDone: 0,
    bestTutorialScore: 0,
    bestPerfectStreak: 0,
    songsBuilt: 0,
    themesUsed: [],
    instrumentsUsed: [],
    clearViewUsed: false,
    videosSaved: 0,
    exports: 0,
    publishes: 0,
    sessionsSaved: 0,
    tourDone: false,
    secretsFound: 0,
    eggs: [],
    nightSessions: 0,
    quickChanges: 0,
    chordsInOneSession: 0,
    bestChordsInOneSession: 0,
    demosWatched: [],
    demoPlays: 0,
    setsPlayed: 0,
    setRatings: {},
    bestRun: 0,
  };
}

export interface Medal {
  id: string;
  name: string;
  /** shown before unlock (hush medals show nothing) */
  hint: string;
  /** shown after unlock */
  description: string;
  category: Category;
  tier: Tier;
  icon: string;
  hidden?: boolean;
  /** progress for counters: [current, target] */
  progress?: (s: Stats) => [number, number];
  check: (s: Stats) => boolean;
}

const counter = (get: (s: Stats) => number, target: number) => ({ progress: (s: Stats): [number, number] => [Math.min(get(s), target), target], check: (s: Stats) => get(s) >= target });
const distinct = (get: (s: Stats) => unknown[], target: number) => counter((s) => get(s).length, target);

export const MEDALS: Medal[] = [
  // ---- playing --------------------------------------------------------------
  { id: 'first_chord', name: 'First Note', hint: 'Play a chord.', description: 'You played your first chord.', category: 'play', tier: 'bronze', icon: '🎵', ...counter((s) => s.chords, 1) },
  { id: 'scale_walker', name: 'Scale Walker', hint: 'Play every degree of the scale.', description: 'All seven degrees, I through VII.', category: 'play', tier: 'silver', icon: '🪜', ...distinct((s) => s.degrees, 7) },
  { id: 'shape_shifter', name: 'Shape Shifter', hint: 'Play every right-hand shape.', description: 'Triad, inversion, seventh and dom7 / m7b5.', category: 'play', tier: 'silver', icon: '🔷', ...distinct((s) => s.shapes, 4) },
  { id: 'bittersweet', name: 'Bittersweet', hint: 'Major and minor, quickly.', description: 'Flipped the tilt from major to minor within ten seconds.', category: 'play', tier: 'bronze', icon: '🌗', ...counter((s) => s.quickChanges, 1) },
  { id: 'range_finder', name: 'Range Finder', hint: 'Use both octaves.', description: 'Thumb in and thumb out: an octave down and an octave up.', category: 'play', tier: 'bronze', icon: '📏', check: (s) => s.octaves.includes(-1) && s.octaves.includes(1) },
  { id: 'jazz_hands', name: 'Jazz Hands', hint: 'Play sevenths.', description: 'Fifty seventh chords.', category: 'play', tier: 'silver', icon: '🎷', ...counter((s) => s.sevenths, 50) },
  { id: 'extension_cord', name: 'Extension Cord', hint: 'Play a lot of sevenths.', description: 'Five hundred seventh chords.', category: 'play', tier: 'gold', icon: '🔌', ...counter((s) => s.sevenths, 500) },
  { id: 'modulator', name: 'Modulator', hint: 'Change key with your hands.', description: 'Changed key with the two-fist gesture.', category: 'play', tier: 'silver', icon: '🔄', ...counter((s) => s.keyGestures, 1) },
  { id: 'around_the_wheel', name: 'Around the Wheel', hint: 'Play in every key.', description: 'Played chords in all twelve keys.', category: 'play', tier: 'gold', icon: '🎡', ...distinct((s) => s.keys, 12) },
  { id: 'drop_it', name: 'Drop It', hint: 'Bass.', description: 'Twenty-five bass flicks.', category: 'play', tier: 'bronze', icon: '🔈', ...counter((s) => s.bassHits, 25) },
  { id: 'arpeggiator', name: 'Arpeggiator', hint: 'Pinch.', description: 'Turned the arpeggiator on.', category: 'play', tier: 'bronze', icon: '🌀', ...counter((s) => s.arpToggles, 1) },
  { id: 'hands_free', name: 'Hands Free', hint: 'Let it ring.', description: 'Latched a chord by holding still.', category: 'play', tier: 'bronze', icon: '🫳', ...counter((s) => s.latches, 1) },
  { id: 'ghost', name: 'Ghost in the Machine', hint: 'Play the theremin for a while.', description: 'One minute of theremin.', category: 'play', tier: 'silver', icon: '👻', ...counter((s) => s.thereminSeconds, 60) },
  { id: 'thousand_hands', name: 'Thousand Hands', hint: 'Play many chords.', description: 'One thousand chords.', category: 'play', tier: 'gold', icon: '🙌', ...counter((s) => s.chords, 1000) },
  { id: 'chord_lord', name: 'Chord Lord', hint: 'Play a great many chords.', description: 'Ten thousand chords.', category: 'play', tier: 'platinum', icon: '👑', ...counter((s) => s.chords, 10000) },
  { id: 'marathon', name: 'Marathon', hint: 'A long take.', description: 'Two hundred chords in a single session.', category: 'play', tier: 'silver', icon: '🏃', ...counter((s) => s.bestChordsInOneSession, 200) },
  // ---- looping ---------------------------------------------------------------
  { id: 'loop_de_loop', name: 'Loop de Loop', hint: 'Record a loop.', description: 'Recorded your first loop.', category: 'loop', tier: 'bronze', icon: '🔁', ...counter((s) => s.loops, 1) },
  { id: 'layer_cake', name: 'Layer Cake', hint: 'Record over something.', description: 'Overdubbed onto a track that already had a loop.', category: 'loop', tier: 'silver', icon: '🍰', ...counter((s) => s.overdubs, 1) },
  { id: 'full_stack', name: 'Full Stack', hint: 'Use every track.', description: 'All four tracks playing at once.', category: 'loop', tier: 'silver', icon: '🧱', ...counter((s) => s.maxTracksFilled, 4) },
  { id: 'chop_shop', name: 'Chop Shop', hint: 'Edit the grid.', description: 'Muted a step in the beat grid.', category: 'loop', tier: 'bronze', icon: '🔪', ...counter((s) => s.stepMutes, 1) },
  { id: 'producer', name: 'Producer', hint: 'Change a chord after the fact.', description: 'Replaced a chord from the grid popover.', category: 'loop', tier: 'bronze', icon: '🎛️', ...counter((s) => s.chordEdits, 1) },
  { id: 'odd_one_out', name: 'Odd One Out', hint: 'Not in four.', description: 'Recorded a loop in 5/4, 6/8 or 7/8.', category: 'loop', tier: 'silver', icon: '🎲', ...counter((s) => s.oddMeterLoops, 1) },
  { id: 'speed_demon', name: 'Speed Demon', hint: 'Fast.', description: 'Recorded at 200 BPM or more.', category: 'loop', tier: 'bronze', icon: '⚡', check: (s) => s.maxBpmRecorded >= 200 },
  { id: 'slow_burn', name: 'Slow Burn', hint: 'Slow.', description: 'Recorded at 50 BPM or less.', category: 'loop', tier: 'bronze', icon: '🐢', check: (s) => s.minBpmRecorded <= 50 },
  { id: 'loop_machine', name: 'Loop Machine', hint: 'Record many loops.', description: 'Twenty-five loops recorded.', category: 'loop', tier: 'gold', icon: '🤖', ...counter((s) => s.loops, 25) },
  // ---- learning --------------------------------------------------------------
  { id: 'student', name: 'Student', hint: 'Finish a tutorial.', description: 'Finished a tutorial with 60% or better.', category: 'learn', tier: 'bronze', icon: '📗', check: (s) => s.bestTutorialScore >= 60 },
  { id: 'scholar', name: 'Scholar', hint: 'Finish a tutorial well.', description: 'Finished a tutorial with 90% or better.', category: 'learn', tier: 'silver', icon: '📘', check: (s) => s.bestTutorialScore >= 90 },
  { id: 'flawless', name: 'Flawless', hint: 'Perfect timing, again and again.', description: 'Eight perfect hits in a row.', category: 'learn', tier: 'gold', icon: '💎', ...counter((s) => s.bestPerfectStreak, 8) },
  { id: 'songwriter', name: 'Songwriter', hint: 'Build something.', description: 'Built a progression and dropped it into a track or a tutorial.', category: 'learn', tier: 'bronze', icon: '✍️', ...counter((s) => s.songsBuilt, 1) },
  { id: 'graduate', name: 'Graduate', hint: 'Finish several tutorials.', description: 'Five tutorials finished.', category: 'learn', tier: 'silver', icon: '🎓', ...counter((s) => s.tutorialsDone, 5) },
  // ---- stage sets -------------------------------------------------------------
  { id: 'first_take', name: 'First Take', hint: 'Play a set on Stage.', description: 'Finished your first set.', category: 'learn', tier: 'bronze', icon: '🎙️', ...counter((s) => s.setsPlayed, 1) },
  { id: 'tight_five', name: 'Tight Five', hint: 'Rate Tight or better on five songs.', description: 'Five songs rated Tight, In the Pocket or Flawless.', category: 'learn', tier: 'silver', icon: '🖐️', ...counter((s) => Object.values(s.setRatings).filter((r) => r >= 3).length, 5) },
  { id: 'pocket', name: 'In the Pocket', hint: 'A take with almost nothing dropped.', description: 'Rated In the Pocket on any song.', category: 'learn', tier: 'gold', icon: '🕳️', check: (s) => Object.values(s.setRatings).some((r) => r >= 4) },
  { id: 'flawless_take', name: 'Flawless Take', hint: '', description: 'Rated Flawless on any song: every chord locked or on it.', category: 'learn', tier: 'platinum', icon: '🏆', hidden: true, check: (s) => Object.values(s.setRatings).some((r) => r >= 5) },
  { id: 'long_run', name: 'Long Run', hint: 'Keep a run going.', description: 'A run of 24 chords without a drop.', category: 'learn', tier: 'silver', icon: '🏃', ...counter((s) => s.bestRun, 24) },
  // ---- exploring -------------------------------------------------------------
  { id: 'eye_candy', name: 'Eye Candy', hint: 'Try every theme.', description: 'Used all five built-in themes.', category: 'explore', tier: 'bronze', icon: '🎨', ...distinct((s) => s.themesUsed.filter((t) => ['Neon', 'Ember', 'Ice', 'Mono', 'Vapor'].includes(t)), 5) },
  { id: 'multi', name: 'Multi-instrumentalist', hint: 'Try every instrument.', description: 'Played all seven built-in instruments.', category: 'explore', tier: 'silver', icon: '🎹', ...distinct((s) => s.instrumentsUsed, 7) },
  { id: 'camera_shy', name: 'Camera Shy', hint: 'Look at yourself.', description: 'Used the clear camera view.', category: 'explore', tier: 'bronze', icon: '📷', check: (s) => s.clearViewUsed },
  { id: 'director', name: 'Director', hint: 'Record a video.', description: 'Saved a video recording.', category: 'explore', tier: 'silver', icon: '🎬', ...counter((s) => s.videosSaved, 1) },
  { id: 'producers_cut', name: "Producer's Cut", hint: 'Export something.', description: 'Exported a MIDI, WAV or session file.', category: 'explore', tier: 'bronze', icon: '💾', ...counter((s) => s.exports, 1) },
  { id: 'broadcast', name: 'Broadcast', hint: 'Share with the world.', description: 'Published to the community.', category: 'explore', tier: 'silver', icon: '📡', ...counter((s) => s.publishes, 1) },
  { id: 'keeper', name: 'Keeper', hint: 'Save your work.', description: 'Saved a session.', category: 'explore', tier: 'bronze', icon: '🗂️', ...counter((s) => s.sessionsSaved, 1) },
  { id: 'guided', name: 'Guided', hint: 'Take the tour.', description: 'Finished the guided tour.', category: 'explore', tier: 'bronze', icon: '🧭', check: (s) => s.tourDone },
  { id: 'spectator', name: 'Spectator', hint: 'Watch a demo all the way through.', description: 'Watched a full demo performance.', category: 'explore', tier: 'bronze', icon: '🍿', ...distinct((s) => s.demosWatched, 1) },
  { id: 'front_row', name: 'Front Row', hint: 'Watch every built-in demo.', description: 'Watched all four built-in demos.', category: 'explore', tier: 'silver', icon: '🎟️', ...distinct((s) => s.demosWatched.filter((d) => (DEMO_IDS as readonly string[]).includes(d)), DEMO_IDS.length) },
  // ---- dedication ------------------------------------------------------------
  { id: 'warm_up', name: 'Warm Up', hint: 'Keep playing.', description: 'One hour of playing.', category: 'dedication', tier: 'silver', icon: '🔥', ...counter((s) => s.playSeconds, 3600) },
  { id: 'devoted', name: 'Devoted', hint: 'Keep playing, a lot.', description: 'Ten hours of playing.', category: 'dedication', tier: 'gold', icon: '🏆', ...counter((s) => s.playSeconds, 36000) },
  { id: 'weekly', name: 'Regular', hint: 'Come back.', description: 'Played on seven different days.', category: 'dedication', tier: 'gold', icon: '📅', ...distinct((s) => s.days, 7) },
  { id: 'centurion', name: 'Centurion', hint: 'Come back, a lot.', description: 'Played on a hundred different days.', category: 'dedication', tier: 'platinum', icon: '🛡️', ...distinct((s) => s.days, 100) },
  // ---- hush-hush -------------------------------------------------------------
  { id: 'curious', name: 'Curious', hint: '', description: 'Found your first secret gesture.', category: 'hush', tier: 'bronze', icon: '🔍', hidden: true, check: (s) => s.secretsFound >= 1 },
  { id: 'secret_keeper', name: 'Secret Keeper', hint: '', description: 'Found every secret gesture.', category: 'hush', tier: 'platinum', icon: '🗝️', hidden: true, ...counter((s) => s.secretsFound, 10) },
  { id: 'night_owl', name: 'Night Owl', hint: '', description: 'Played between midnight and four in the morning.', category: 'hush', tier: 'bronze', icon: '🦉', hidden: true, check: (s) => s.nightSessions >= 1 },
  { id: 'turn_that_frown', name: 'Turn That Frown', hint: '', description: 'You know what you did.', category: 'hush', tier: 'bronze', icon: '🙃', hidden: true, check: (s) => s.eggs.includes('flip') },
  { id: 'arcade', name: 'Insert Coin', hint: '', description: 'Entered the code.', category: 'hush', tier: 'silver', icon: '🕹️', hidden: true, check: (s) => s.eggs.includes('konami') },
  { id: 'completionist', name: 'Completionist', hint: '', description: 'Every other medal.', category: 'hush', tier: 'platinum', icon: '🌟', hidden: true, check: () => false /* resolved by the store */ },
];

export const TIER_INFO: Record<Tier, { name: string; color: string; glow: string; points: number }> = {
  bronze: { name: 'Bronze', color: '#cd7f32', glow: 'rgba(205,127,50,0.55)', points: 10 },
  silver: { name: 'Silver', color: '#d7dbe3', glow: 'rgba(215,219,227,0.55)', points: 25 },
  gold: { name: 'Gold', color: '#ffd166', glow: 'rgba(255,209,102,0.6)', points: 50 },
  platinum: { name: 'Platinum', color: '#9fe8ff', glow: 'rgba(159,232,255,0.65)', points: 100 },
};

export const CATEGORIES = Object.keys(CATEGORY_INFO) as Category[];

export function medalById(id: string): Medal | undefined {
  return MEDALS.find((m) => m.id === id);
}
