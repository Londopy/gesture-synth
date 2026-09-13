export { chordName, type Quality, type Shape } from '../lib/music';
import { PITCH_NAMES } from '../lib/music';

export function KEY_INDEX_FROM_NAME(name: string): number {
  const i = PITCH_NAMES.indexOf(name as any);
  if (i >= 0) return i;
  const flats: Record<string, number> = { Db: 1, Eb: 3, Gb: 6, Ab: 8, Bb: 10 };
  return flats[name] ?? 0;
}
