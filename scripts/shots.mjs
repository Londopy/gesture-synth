#!/usr/bin/env node
// Headless screenshots for the README / release page, driven through the
// camera-less dev hook. Needs a built app served on http://localhost:4173
// (npm run serve) and a Chromium on this machine (Edge or Chrome).
//
//   npm install --no-save puppeteer-core
//   node scripts/shots.mjs            -> docs/shots/*.png

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const exe = process.env.CHROME ?? CANDIDATES.find((p) => existsSync(p));
if (!exe) throw new Error('no Chromium found; set CHROME=path');
const URL = process.env.APP_URL ?? 'http://localhost:4173/';
mkdirSync('docs/shots', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1600,900', '--hide-scrollbars'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
page.on('dialog', (d) => d.accept()); // the app asks before leaving with an unsaved loop
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.setItem('gsyn.settings.v1', JSON.stringify({ firstRunDone: true, tourDone: true, theme: 'Neon' })));
await page.reload({ waitUntil: 'networkidle0' });

const ready = await page.evaluate(async () => {
  const rt = window.__gsyn.rt;
  await rt.start();
  await new Promise((r) => setTimeout(r, 600));
  return { phase: rt.phase, err: rt.error, sab: rt.usingSAB };
});
console.log('runtime', ready);

/** Run frames of synthetic hands through parser + scene. */
async function pose(leftMask, rightMask, leftTilt, rightTilt, rightY, frames = 12, extra = '') {
  await page.evaluate(
    async (a) => {
      const g = window.__gsyn;
      await g.synth(a.leftMask, a.rightMask, a.leftTilt, a.rightTilt, a.rightY, 1);
      for (let i = 0; i < a.frames; i++) {
        await g.synth(a.leftMask, a.rightMask, a.leftTilt, a.rightTilt, a.rightY, 1);
        g.tick(33);
      }
      // eslint-disable-next-line no-new-func
      if (a.extra) await new Function('g', 'rt', a.extra)(g, g.rt);
    },
    { leftMask, rightMask, leftTilt, rightTilt, rightY, frames, extra },
  );
}
async function ticks(n) {
  await page.evaluate((n) => {
    for (let i = 0; i < n; i++) window.__gsyn.tick(33);
  }, n);
}
async function shot(name) {
  await page.screenshot({ path: `docs/shots/${name}.png` });
  console.log('saved', name);
}
async function key(k, opts = {}) {
  await page.evaluate((a) => window.dispatchEvent(new KeyboardEvent('keydown', { key: a.k, bubbles: true, ...a.opts })), { k, opts });
}

// 1) play view: a loop on track 4 + a live IV maj7, grid open
await page.evaluate(async () => {
  const rt = window.__gsyn.rt;
  rt.setBpm(96);
  rt.setBars(2);
  rt.cmd({ cmd: 'set_count_in_bars', bars: 0 });
  const song = { version: 1, name: 'Hero', author: '', bpm: 96, time_sig: '4/4', key: 'D', mode: 'major', bars: 2, chords: [{ bar: 1, beat: 1, degree: 1, quality: 'major', shape: 'seventh', octave: 0, dur_beats: 4 }, { bar: 1, beat: 3, degree: 5, quality: 'major', shape: 'dom_or_dim7', octave: 0, dur_beats: 2 }, { bar: 2, beat: 1, degree: 6, quality: 'minor', shape: 'seventh', octave: 0, dur_beats: 2 }, { bar: 2, beat: 3, degree: 4, quality: 'major', shape: 'root', octave: 0, dur_beats: 2 }], hints: { left_scheme: { kind: 'full' }, right_scheme: { kind: 'full' } }, tags: [], instrument: 'Pad' };
  await rt.loadSongIntoTrack(JSON.stringify(song), 3);
  rt.play();
  await new Promise((r) => setTimeout(r, 700));
});
await pose(0b11110, 0b01110, 22, 40, 0.28, 30);
await ticks(20);
await shot('play');
await key('g');
await page.waitForSelector('.dock');
await ticks(10);
await shot('grid');
await key('g');

// 2) performance view hero (no chrome)
await key('f');
await pose(0b11110, 0b01110, 22, 40, 0.28, 40);
await ticks(25);
await shot('hero');
await pose(0b00110, 0b01110, -24, 40, 0.3, 30);
await ticks(25);
await shot('hero-minor');

// 3) theremin
await key('Tab');
for (let i = 0; i < 10; i++) await pose(0b11110, 0b11110, 0, 0, 0.72 - i * 0.05, 4);
await ticks(10);
await shot('theremin');
await key('Tab');
await key('f');

// 4) easter egg: finger heart
await page.evaluate(async () => {
  const g = window.__gsyn, rt = g.rt;
  const m = await g.wasm();
  const mk = (cx, cy, mask, right) => {
    const f = m.synth_hand_landmarks(cx, cy, 0.12, mask, 0, right);
    const lm = [];
    for (let i = 0; i < 21; i++) lm.push({ x: f[i * 3], y: f[i * 3 + 1], z: f[i * 3 + 2] });
    return { landmarks: lm, left: right, confidence: 0.95 };
  };
  const L = mk(0.58, 0.62, 0b00011, false), R = mk(0.42, 0.62, 0b00011, true);
  L.landmarks[8] = { x: 0.5, y: 0.4, z: 0 };
  R.landmarks[8] = { x: 0.5, y: 0.405, z: 0 };
  L.landmarks[4] = { x: 0.5, y: 0.53, z: 0 };
  R.landmarks[4] = { x: 0.5, y: 0.535, z: 0 };
  for (let i = 0; i < 40; i++) {
    rt.onFrame({ hands: [L, R], tMs: performance.now(), inferenceMs: 0 });
    g.tick(33);
    await new Promise((r) => setTimeout(r, 12));
  }
  for (let i = 0; i < 14; i++) {
    g.tick(33);
    await new Promise((r) => setTimeout(r, 12));
  }
});
const eggs = await page.evaluate(() => JSON.parse(localStorage.getItem('gsyn.settings.v1')).eggsFound);
console.log('eggs found', eggs);
await shot('egg-heart');

// 5) help > secrets and the recorder sheet
await key('h');
await page.waitForSelector('[aria-label="Help"]');
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Secrets/.test(b.textContent)).click());
await new Promise((r) => setTimeout(r, 200));
await shot('secrets');
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Gestures/.test(b.textContent)).click());
await new Promise((r) => setTimeout(r, 400));
await shot('help-gestures');
await key('Escape');
await key('r', { ctrlKey: true, shiftKey: true });
await page.waitForSelector('[aria-label="Record video"]');
await ticks(5);
await shot('recorder');

// 6) medals: play the seven degrees and the four shapes, catch the unlock toast, then the page
await key('Escape');
await page.evaluate(() => { window.__gsyn.rt.stop(); window.__gsyn.rt.dirty = false; localStorage.removeItem('gsyn.achievements.v1'); });
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__gsyn);
await page.evaluate(async () => { const rt = window.__gsyn.rt; await rt.start(); await new Promise((r) => setTimeout(r, 500)); });
const masks = [0b00010, 0b00110, 0b01110, 0b11110, 0b11111, 0b10010, 0b10011];
for (let i = 0; i < 7; i++) await pose(masks[i], [0b00010, 0b00110, 0b01110, 0b11110][i % 4], 20, 0, 0.3, 6);
await pose(0b00010, 0b00010, -25, 0, 0.3, 6);
await new Promise((r) => setTimeout(r, 900));
await ticks(20);
await shot('medal-unlock');
await page.evaluate(() => { history.pushState(null, '', '/medals'); window.dispatchEvent(new PopStateEvent('popstate')); });
await new Promise((r) => setTimeout(r, 600));
await page.evaluate(() => [...document.querySelectorAll('.cell')].find((c) => /Scale Walker/.test(c.textContent))?.click());
await new Promise((r) => setTimeout(r, 400));
await shot('medals');

await browser.close();
