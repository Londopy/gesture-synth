// 7-step guided tour (spec 9 "Onboarding"). Each step has a hand diagram spec
// and a live "try it" predicate evaluated against the runtime.

import type { LiveState, Position } from '../music';
import type { HandInfo } from '../tracking/parser';

export interface DiagramHand {
  /** thumb..pinky */
  fingers: [boolean, boolean, boolean, boolean, boolean];
  tilt: number;
  right: boolean;
  /** vertical position 0..1 (0 top) for the height animations */
  y?: number;
  /** animate between this and `fingers`/`tilt`/`y` */
  to?: Partial<Pick<DiagramHand, 'fingers' | 'tilt' | 'y'>>;
}

export interface TourStep {
  id: string;
  title: string;
  body: string;
  hands: DiagramHand[];
  tryIt: string;
  check: (ctx: { live: LiveState; left: HandInfo; right: HandInfo; pos: Position; cameraOk: boolean; tracks: LiveState[] }) => boolean;
  /** Highlight a chrome region by CSS selector. */
  highlight?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'camera',
    title: 'Camera and calibration',
    body: 'Allow the camera and sit so both hands fit in the frame, side by side. Raise your right hand to the top of the frame, then the bottom: that sets your volume range.',
    hands: [
      { fingers: [false, true, true, true, true], tilt: 0, right: false, y: 0.5 },
      { fingers: [false, true, true, true, true], tilt: 0, right: true, y: 0.2, to: { y: 0.8 } },
    ],
    tryIt: 'Show both hands to the camera',
    check: ({ left, right, cameraOk }) => cameraOk && left.present && right.present,
  },
  {
    id: 'left',
    title: 'Left hand picks the chord',
    body: 'Index only is I. Add the middle finger for II, ring for III, all four for IV, all five for V. Index + pinky is VI, add the thumb for VII. A fist mutes.',
    hands: [{ fingers: [false, true, false, false, false], tilt: 20, right: false, to: { fingers: [false, true, true, true, true] } }],
    tryIt: 'Hold up index + middle (II) with the left hand',
    check: ({ live }) => live.degree === 2,
    highlight: '[data-tour="hud"]',
  },
  {
    id: 'right',
    title: 'Right hand shapes it',
    body: 'One finger is the plain triad, two is first inversion, three adds a seventh, four makes it a dominant (or half-diminished) seventh. The thumb folded in drops an octave, stuck out raises one.',
    hands: [{ fingers: [false, true, false, false, false], tilt: 0, right: true, to: { fingers: [false, true, true, true, false] } }],
    tryIt: 'Show three fingers on the right hand (seventh)',
    check: ({ live }) => live.shape === 2 && live.degree > 0,
  },
  {
    id: 'dynamics',
    title: 'Filter and volume',
    body: 'Tilt the right palm inward to open the filter, outward to close it. Raise the hand for louder, lower for quieter. The left palm tilt switches major (inward) and minor (outward).',
    hands: [
      { fingers: [false, true, false, false, false], tilt: 25, right: false, to: { tilt: -25 } },
      { fingers: [false, true, false, false, false], tilt: -35, right: true, y: 0.7, to: { tilt: 35, y: 0.3 } },
    ],
    tryIt: 'Open the filter past 80% and play a minor chord',
    check: ({ live }) => live.cutoff > 0.8 && live.quality === 1 && live.degree > 0,
  },
  {
    id: 'record',
    title: 'Loop pedal: record',
    body: 'Press R (or the record button). You get one bar of count-in with the big numbers, then the loop records for the set number of bars and plays back on its own.',
    hands: [{ fingers: [false, true, false, false, false], tilt: 20, right: false }, { fingers: [false, true, false, false, false], tilt: 0, right: true }],
    tryIt: 'Record a loop on track 1',
    check: ({ tracks, pos }) => pos.state === 2 && tracks.some((t) => t.degree > 0),
    highlight: '[data-tour="transport"]',
  },
  {
    id: 'layer',
    title: 'Layer and edit',
    body: 'Press 2 to select track 2 and record again: the first track keeps playing. Open the grid (G) to mute single steps, change a chord with a right-click, and mix tracks.',
    hands: [{ fingers: [false, true, true, false, false], tilt: 20, right: false }, { fingers: [false, true, true, false, false], tilt: 0, right: true }],
    tryIt: 'Select track 2',
    check: ({ pos }) => pos.selected === 1,
    highlight: '[data-tour="tracks"]',
  },
  {
    id: 'shortcuts',
    title: 'Shortcuts',
    body: 'Space plays and stops. [ and ] move the key around the circle of fifths. Tab toggles Theremin mode. F hides all chrome for a performance. H shows the full list any time.',
    hands: [],
    tryIt: 'Press ] to move the key up a fifth',
    check: ({ live }) => live.key !== 0,
  },
];
