// Difficulty of a song as 1-5 "hands", from what the hands actually have to
// do: how often they change, how many right-hand shapes appear, octave jumps
// (thumb), major/minor flips (tilt) and the tempo those happen at. Pure and
// deterministic so the Sets screen and tests agree.
import type { Song } from '../learn/songs';

export interface DifficultyBreakdown {
  hands: 1 | 2 | 3 | 4 | 5;
  score: number; // continuous 0..~10 before bucketing
  chordsPerBar: number;
  shapes: number;
  octaveChanges: number;
  qualityFlips: number;
  bpm: number;
}

export function difficultyOf(song: Song): DifficultyBreakdown {
  const chords = [...song.chords].sort((a, b) => a.bar - b.bar || a.beat - b.beat);
  const n = Math.max(1, chords.length);
  const chordsPerBar = n / Math.max(1, song.bars);
  const shapes = new Set(chords.map((c) => c.shape)).size;
  let octaveChanges = 0;
  let qualityFlips = 0;
  for (let i = 1; i < chords.length; i++) {
    if (chords[i].octave !== chords[i - 1].octave) octaveChanges++;
    if (chords[i].quality !== chords[i - 1].quality) qualityFlips++;
  }
  // Rates per bar keep long and short songs comparable.
  const perBar = (x: number) => x / Math.max(1, song.bars);
  const tempo = Math.max(0, (song.bpm - 70) / 60); // 0 at 70 bpm, 1 at 130
  const score =
    2.2 * Math.max(0, chordsPerBar - 1) + // one chord a bar is the baseline
    0.9 * (shapes - 1) + // each extra right-hand shape
    2.0 * perBar(octaveChanges) + // thumb moves are the hardest single change
    0.6 * perBar(qualityFlips) + // a tilt flip is cheap but still a change
    1.6 * tempo +
    (chords.some((c) => c.octave !== 0) ? 0.4 : 0);
  const hands = (score < 1 ? 1 : score < 2.2 ? 2 : score < 3.6 ? 3 : score < 5.2 ? 4 : 5) as DifficultyBreakdown['hands'];
  return { hands, score, chordsPerBar, shapes, octaveChanges, qualityFlips, bpm: song.bpm };
}

export const DIFFICULTY_LABELS = ['', 'Easy', 'Light', 'Steady', 'Busy', 'Fierce'] as const;
