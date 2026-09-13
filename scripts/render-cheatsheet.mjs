#!/usr/bin/env node
// Renders docs/cheatsheet.svg: every playing gesture as a wireframe hand,
// generated from the Rust synthetic-hand model (via the WASM build) so the
// diagrams match what the parser expects. Needs `npm run wasm` first.

import { readFileSync, writeFileSync } from 'node:fs';
import { initSync, synth_hand_landmarks } from '../app/src/lib/wasm/pkg/gsyn.js';

initSync({ module: new WebAssembly.Module(readFileSync('app/src/lib/wasm/pkg/gsyn_bg.wasm')) });

const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const FINGER_OF = [-1, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
const TIPS = [4, 8, 12, 16, 20];

function hand(fingers, tilt, right, color, x, y, size = 300) {
  const mask = fingers.reduce((m, b, i) => m | (b ? 1 << i : 0), 0);
  const lm = synth_hand_landmarks(0.5, 0.62, 0.22, mask, tilt, right);
  const P = [];
  for (let i = 0; i < 21; i++) P.push([x + ((1 - lm[i * 3]) - 0.5) * size, y + (lm[i * 3 + 1] - 0.5) * size]);
  const ext = (i) => (FINGER_OF[i] < 0 ? true : fingers[FINGER_OF[i]]);
  let s = `<g filter="url(#glow)">`;
  for (const [a, b] of BONES) s += `<line x1="${P[a][0].toFixed(1)}" y1="${P[a][1].toFixed(1)}" x2="${P[b][0].toFixed(1)}" y2="${P[b][1].toFixed(1)}" stroke="${color}" stroke-width="${ext(b) ? 3.4 : 2}" stroke-opacity="${ext(b) ? 1 : 0.4}" stroke-linecap="round"/>`;
  for (let i = 0; i < 21; i++) s += `<circle cx="${P[i][0].toFixed(1)}" cy="${P[i][1].toFixed(1)}" r="${TIPS.includes(i) ? 4 : i === 0 ? 3.4 : 2.2}" fill="${color}" fill-opacity="${ext(i) ? 1 : 0.5}"/>`;
  return s + `</g>`;
}

const W = 1600, H = 720;
const MAJOR = '#ffb347', RIGHT = '#dfe6ff', MINOR = '#8f9cff';
const left = [
  ['I', [false, true, false, false, false]],
  ['II', [false, true, true, false, false]],
  ['III', [false, true, true, true, false]],
  ['IV', [false, true, true, true, true]],
  ['V', [true, true, true, true, true]],
  ['VI', [false, true, false, false, true]],
  ['VII', [true, true, false, false, true]],
  ['mute', [false, false, false, false, false]],
];
const right = [
  ['triad', [false, true, false, false, false], 0],
  ['1st inversion', [false, true, true, false, false], 0],
  ['seventh', [false, true, true, true, false], 0],
  ['dom7 / m7b5', [false, true, true, true, true], 0],
  ['octave up', [true, true, false, false, false], 0],
  ['octave down', [false, true, false, false, false], 0, 'thumb in'],
  ['filter open', [false, true, false, false, false], 38],
  ['filter closed', [false, true, false, false, false], -38],
];

let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#151a2b"/><stop offset="1" stop-color="#0b0d12"/></linearGradient>
  <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<rect width="${W}" height="${H}" rx="28" fill="url(#bg)"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="28" fill="none" stroke="#ffffff" stroke-opacity="0.12"/>
<text x="60" y="64" fill="#ffffff" font-size="26" font-weight="600">Left hand · chord degree</text>
<text x="60" y="92" fill="#ffffff" fill-opacity="0.55" font-size="15">tilt the palm inward for major, outward for minor · fist = mute</text>
<text x="60" y="404" fill="#ffffff" font-size="26" font-weight="600">Right hand · shape, octave, filter, volume</text>
<text x="60" y="432" fill="#ffffff" fill-opacity="0.55" font-size="15">count the fingers for the shape · thumb out = +1 octave, folded in = −1 · tilt = filter · height = volume</text>
`;
const colW = (W - 120) / 8;
left.forEach(([label, f], i) => {
  const cx = 60 + colW * i + colW / 2;
  svg += hand(f, 22, false, label === "mute" ? "#8a8f9c" : MAJOR, cx, 200);
  svg += `<text x="${cx}" y="330" text-anchor="middle" fill="#ffffff" font-size="22" font-weight="500">${label}</text>`;
});
right.forEach(([label, f, tilt, note], i) => {
  const cx = 60 + colW * i + colW / 2;
  const color = label.startsWith('filter closed') ? MINOR : RIGHT;
  svg += hand(f, tilt, true, color, cx, 560);
  svg += `<text x="${cx}" y="670" text-anchor="middle" fill="#ffffff" font-size="19" font-weight="500">${label}</text>`;
  if (note) svg += `<text x="${cx}" y="692" text-anchor="middle" fill="#ffffff" fill-opacity="0.5" font-size="13">${note}</text>`;
});
// tilt arrows for the filter pair
svg += `<text x="${60 + colW * 6 + colW / 2}" y="452" text-anchor="middle" fill="${MAJOR}" font-size="18">↻ inward</text>`;
svg += `<text x="${60 + colW * 7 + colW / 2}" y="452" text-anchor="middle" fill="${MINOR}" font-size="18">↺ outward</text>`;
svg += `</svg>\n`;
writeFileSync('docs/cheatsheet.svg', svg);
console.log('wrote docs/cheatsheet.svg', (svg.length / 1024).toFixed(0), 'kB');
