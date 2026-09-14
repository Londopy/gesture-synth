#!/usr/bin/env node
// Demo mode sync and restore check. Runs every built-in demo once through the
// real parser and engine in a headless Chromium, records the transport
// position of every live-slot event and compares it with the choreography,
// then verifies that everything the demo touched was put back. Needs a built
// app served on http://localhost:4173 (npm run build && npm run serve) and a
// Chromium on this machine (Edge or Chrome).
//
//   npm install --no-save puppeteer-core
//   node scripts/demo-check.mjs            # exit code 1 on any failure
//   node scripts/demo-check.mjs --shots    # also writes docs/shots/demo*.png
//   DEMOS=brass-tacks node scripts/demo-check.mjs

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
const SHOTS = process.argv.includes('--shots');
const ONLY = process.env.DEMOS ? process.env.DEMOS.split(',') : null;

const failures = [];
function check(cond, msg) {
  if (cond) console.log('  ok   ' + msg);
  else {
    failures.push(msg);
    console.log('  FAIL ' + msg);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1600,900', '--hide-scrollbars'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || /\[demo\]/.test(m.text())) console.log('[console]', m.text());
});
page.on('dialog', (d) => d.accept());
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.setItem('gsyn.settings.v1', JSON.stringify({ firstRunDone: true, tourDone: true, theme: 'Neon' })));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => !!window.__gsyn);

// 1) a ready runtime without a camera
const ready = await page.evaluate(async () => {
  const rt = window.__gsyn.rt;
  await rt.start({ camera: false });
  await new Promise((r) => setTimeout(r, 600));
  return { phase: rt.phase, cameraFailed: rt.cameraFailed, trackingStatus: rt.trackingStatus, sab: rt.usingSAB, err: rt.error };
});
console.log('runtime', ready);
check(ready.phase === 'ready', 'rt.start({camera:false}) reaches phase ready');
check(ready.cameraFailed === false, 'cameraFailed stays false without a camera');
check(ready.trackingStatus === 'idle', "trackingStatus is 'idle'");

// 2) what the demo must give back
const snapshot = () =>
  page.evaluate(async () => {
    const g = window.__gsyn;
    const rt = g.rt;
    const s = g.settings.s;
    const a = await g.achievements();
    const p = rt.position;
    return {
      bpm: p.bpm,
      beats: p.beats,
      unit: p.unit,
      bars: p.bars,
      state: p.state,
      key: rt.live.key,
      minor: rt.live.minor,
      liveInstrument: s.liveInstrument,
      quantize: s.quantize,
      quantizeInput: s.quantizeInput,
      parser: JSON.stringify(s.parser),
      dirty: rt.dirty,
      mutes: rt.trackSummary.map((t) => !!t.mute),
      stats: { chords: a.stats.chords, bassHits: a.stats.bassHits, arpToggles: a.stats.arpToggles, latches: a.stats.latches, playSeconds: a.stats.playSeconds },
      demosWatched: [...a.stats.demosWatched],
      eggsFound: [...s.eggsFound],
    };
  });
const before = await snapshot();
console.log('snapshot', { bpm: before.bpm, sig: `${before.beats}/${before.unit}`, bars: before.bars, key: before.key, minor: before.minor, inst: before.liveInstrument, q: before.quantize, qi: before.quantizeInput });

// 3) event collector: the beat position is read from the same 'pos' message that carried the event
await page.evaluate(() => {
  window.__demoEv = [];
  window.__gsyn.rt.on((e) => {
    if (e.slot !== 4) return;
    const p = window.__gsyn.rt.position;
    window.__demoEv.push({ type: e.type, on: e.on, degree: e.degree, key: e.key, minor: e.minor, beat: (p.bar - 1) * p.beats + (p.beat - 1) + p.phase, state: p.state, t: performance.now() });
  });
});

const ids = await page.evaluate(async () => (await window.__gsyn.demoLib()).DEMO_IDS.slice());
const demos = ONLY ? ids.filter((i) => ONLY.includes(i)) : ids;
check(demos.length > 0, 'at least one demo to run');

const sameEvents = (a, b) => a.chords === b.chords && a.bassHits === b.bassHits && a.arpToggles === b.arpToggles && a.latches === b.latches;

function wrapDelta(a, b, total) {
  let d = a - b;
  d = ((((d + total / 2) % total) + total) % total) - total / 2;
  return d;
}

// 4) every demo once, compared against its own choreography
for (const id of demos) {
  console.log(`\n== ${id}`);
  const tl = await page.evaluate(async (id) => {
    const lib = await window.__gsyn.demoLib();
    const song = lib.demoById(id);
    const tl = lib.compile(song);
    const KEY_INDEX = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
    return { name: song.name, bpm: song.bpm, bars: song.bars, key: KEY_INDEX[song.key], minor: song.mode === 'minor', beats: tl.beats, total: tl.total, cues: tl.cues, passes: lib.DEMO_PASSES, errors: lib.validateDemoSong(song) };
  }, id);
  check(tl.errors.length === 0, `${tl.name} validates (${tl.errors.join('; ') || 'no problems'})`);
  const msPerBeat = 60000 / tl.bpm;
  const poseCues = tl.cues.filter((c) => c.kind === 'pose');
  const bassCues = tl.cues.filter((c) => c.kind === 'bass');
  const pinchCues = tl.cues.filter((c) => c.kind === 'pinch');
  const latchCues = tl.cues.filter((c) => c.kind === 'freeze');
  const songSec = (tl.total * msPerBeat) / 1000;

  const started = await page.evaluate(async (id) => {
    const d = await window.__gsyn.demo();
    window.__demoEv.length = 0;
    await d.start(id, { mode: 'once' });
    return { active: d.active, mode: d.mode, reason: d.lastReason, songId: d.songId };
  }, id);
  check(started.active === true, `demo.start('${id}') is active (${started.reason || 'no stop reason'})`);
  check(started.mode === 'once', "mode is 'once'");

  const deadline = Date.now() + (tl.passes * songSec + 15) * 1000;
  let last = null;
  let sawPlaying = false;
  let maxBar = 0;
  while (Date.now() < deadline) {
    last = await page.evaluate(async () => {
      const d = await window.__gsyn.demo();
      return { active: d.active, phase: d.phase, bar: d.bar, pass: d.pass, reason: d.lastReason, state: window.__gsyn.rt.position.state };
    });
    if (last.phase === 'playing') sawPlaying = true;
    maxBar = Math.max(maxBar, last.bar);
    if (!last.active) break;
    await sleep(250);
  }
  check(last && last.active === false, `demo ended by itself (phase ${last?.phase}, reason '${last?.reason}')`);
  check(last?.reason === 'end', `stop reason is 'end' (got '${last?.reason}')`);
  check(sawPlaying && maxBar === tl.bars, `reached the last bar (${maxBar}/${tl.bars})`);
  await sleep(400);

  const ev = await page.evaluate(() => window.__demoEv.slice());
  const chordOns = ev.filter((e) => e.type === 'chord_on');
  const basses = ev.filter((e) => e.type === 'bass');
  const arps = ev.filter((e) => e.type === 'arp');
  const latchOn = ev.filter((e) => e.type === 'latch' && e.on);
  // the performer releases the latch with the next pose (or the final fist) while the transport still runs
  const latchOff = ev.filter((e) => e.type === 'latch' && !e.on && e.state === 2);
  // the engine reports the key the demo applies and the one it restores; anything else would be a key gesture
  const keys = ev.filter((e) => e.type === 'key' && !((e.key === tl.key && e.minor === tl.minor) || (e.key === before.key && e.minor === before.minor)));

  // onset timing: distance to the nearest pose cue and to the nearest beat, in ms
  let maxCueMs = 0;
  let sumCueMs = 0;
  let maxBeatMs = 0;
  let earliest = 0;
  let outliers = 0;
  for (const c of chordOns) {
    let best = Infinity;
    for (const q of poseCues) {
      const d = wrapDelta(c.beat, q.beat, tl.total);
      if (Math.abs(d) < Math.abs(best)) best = d;
    }
    const dCue = best * msPerBeat;
    const dBeat = (c.beat - Math.round(c.beat)) * msPerBeat;
    maxCueMs = Math.max(maxCueMs, Math.abs(dCue));
    sumCueMs += Math.abs(dCue);
    maxBeatMs = Math.max(maxBeatMs, Math.abs(dBeat));
    earliest = Math.min(earliest, best);
    if (Math.abs(best) > 0.25) outliers++;
    if (process.env.VERBOSE) console.log(`    chord_on deg ${c.degree} at beat ${fmt(c.beat, 3)} (state ${c.state}) -> cue ${fmt(best * msPerBeat, 1)} ms`);
  }
  if (process.env.VERBOSE) for (const e of ev.filter((e) => e.type !== 'chord_on' && e.type !== 'param')) console.log(`    ${e.type}${e.on === undefined ? '' : e.on ? ' on' : ' off'} at beat ${fmt(e.beat, 3)} (state ${e.state})`);
  const expectedOns = poseCues.length * tl.passes;
  console.log(`  chord_on ${chordOns.length}/${expectedOns}  bass ${basses.length}/${bassCues.length * tl.passes}  arp ${arps.length}/${pinchCues.length * tl.passes}  latch on ${latchOn.length} off ${latchOff.length}  (${latchCues.length * tl.passes} expected)`);
  console.log(`  onset vs cue: mean ${fmt(chordOns.length ? sumCueMs / chordOns.length : 0)} ms, max ${fmt(maxCueMs)} ms, earliest ${fmt(earliest * msPerBeat)} ms; onset vs nearest beat: max ${fmt(maxBeatMs)} ms`);
  check(chordOns.length === expectedOns, `chord_on count ${chordOns.length} === pose cues x passes ${expectedOns}`);
  check(outliers === 0, `every chord_on within 0.25 beat of a pose cue (${outliers} outside)`);
  check(earliest >= -0.05, `no chord_on more than 0.05 beat early (earliest ${fmt(earliest * msPerBeat)} ms)`);
  check(basses.length === bassCues.length * tl.passes, `bass hits ${basses.length} === ${bassCues.length * tl.passes}`);
  check(arps.length === pinchCues.length * tl.passes, `arp toggles ${arps.length} === ${pinchCues.length * tl.passes}`);
  check(latchOn.length === latchCues.length * tl.passes, `latch on ${latchOn.length} === ${latchCues.length * tl.passes}`);
  check(latchOff.length === latchCues.length * tl.passes, `latch off ${latchOff.length} === ${latchCues.length * tl.passes}`);
  check(keys.length === 0, `no key-gesture events (${keys.length})`);

  // 5) restore
  const after = await snapshot();
  const same = (k) => check(JSON.stringify(after[k]) === JSON.stringify(before[k]), `${k} restored (${JSON.stringify(after[k])})`);
  for (const k of ['bpm', 'beats', 'unit', 'bars', 'key', 'minor', 'liveInstrument', 'quantize', 'quantizeInput', 'parser', 'dirty', 'mutes', 'eggsFound']) same(k);
  check(after.state === 0, 'transport stopped after the demo');
  check(sameEvents(after.stats, before.stats), `event stats unchanged ${JSON.stringify(after.stats)}`);
  check(after.stats.playSeconds - before.stats.playSeconds <= 2, `playSeconds not counted during the demo (+${after.stats.playSeconds - before.stats.playSeconds} s of unmuted time)`);
  check(after.demosWatched.includes(id), `demosWatched includes '${id}'`);
  before.demosWatched = after.demosWatched;
  before.stats.playSeconds = after.stats.playSeconds;
}

// 6) takeover: real hands on camera hand the stage back
{
  console.log('\n== takeover');
  const r = await page.evaluate(async () => {
    const g = window.__gsyn;
    const d = await g.demo();
    const m = await g.wasm();
    await d.start('brass-tacks', { mode: 'loop' });
    await new Promise((r) => setTimeout(r, 2500));
    const wasActive = d.active;
    const f = m.synth_hand_landmarks(0.7, 0.5, 0.12, 0b00010, 20, false);
    const lm = [];
    for (let i = 0; i < 21; i++) lm.push({ x: f[i * 3], y: f[i * 3 + 1], z: f[i * 3 + 2] });
    const t0 = performance.now();
    for (let i = 0; i < 15; i++) {
      g.fakeCamera({ hands: [{ landmarks: lm, left: false, confidence: 0.9 }], tMs: performance.now(), inferenceMs: 0 });
      await new Promise((r) => setTimeout(r, 33));
    }
    const took = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 200));
    return { wasActive, active: d.active, reason: d.lastReason, leftPresent: g.rt.left.present, gate: g.rt.cameraGate, took, state: g.rt.position.state };
  });
  check(r.wasActive, 'demo was running before the hands appeared');
  check(r.active === false && r.reason === 'hands', `demo stopped with reason 'hands' (${r.reason}) after ${fmt(r.took, 0)} ms`);
  check(r.leftPresent === true, 'the real hand reached the parser (rt.left.present)');
  check(r.gate === null, 'cameraGate released');
  check(r.state === 0, 'transport stopped');
  await page.evaluate(() => window.__gsyn.rt.clearLiveHands());
  await sleep(300);
  const after = await snapshot();
  for (const k of ['bpm', 'beats', 'unit', 'bars', 'key', 'minor', 'liveInstrument', 'quantize', 'quantizeInput', 'parser', 'dirty']) check(JSON.stringify(after[k]) === JSON.stringify(before[k]), `${k} restored after takeover`);
  // the real hand played a chord once the demo let go: that one counts, so the stats baseline moves here
  check(after.stats.chords === before.stats.chords + 1, `the user's takeover chord counts (chords ${before.stats.chords} -> ${after.stats.chords})`);
  before.stats = after.stats;
}

// 7) stop mid-chord: chord released, transport stopped, snapshot back
{
  console.log('\n== stop mid-chord');
  const r = await page.evaluate(async () => {
    const g = window.__gsyn;
    const d = await g.demo();
    await d.start('lantern-waltz', { mode: 'cycle' });
    await new Promise((r) => setTimeout(r, 3000));
    const during = { degree: g.rt.live.degree, state: g.rt.position.state, phase: d.phase };
    d.stop('esc');
    const immediately = { degree: g.rt.live.degree, active: d.active };
    await new Promise((r) => setTimeout(r, 120));
    return { during, immediately, state: g.rt.position.state, reason: d.lastReason, target: d.target() };
  });
  check(r.during.degree > 0 && r.during.state === 2, `a chord was sounding with the transport running (degree ${r.during.degree}, state ${r.during.state}, phase ${r.during.phase})`);
  check(r.immediately.degree === 0 && r.immediately.active === false, 'stop() releases the chord synchronously');
  check(r.state === 0, 'transport stopped within 120 ms');
  check(r.reason === 'esc', "lastReason is 'esc'");
  check(r.target === null, 'target() is null once stopped');
  await sleep(300);
  const after = await snapshot();
  for (const k of ['bpm', 'beats', 'unit', 'bars', 'key', 'minor', 'liveInstrument', 'quantize', 'quantizeInput', 'parser', 'dirty', 'mutes']) check(JSON.stringify(after[k]) === JSON.stringify(before[k]), `${k} restored after stop`);
  check(sameEvents(after.stats, before.stats), `event stats unchanged after the aborted demos ${JSON.stringify(after.stats)}`);
  check(after.stats.playSeconds - before.stats.playSeconds <= 3, `playSeconds not counted during the aborted demos (+${after.stats.playSeconds - before.stats.playSeconds} s)`);
}

// 8) screenshots (rAF is paused headless, so the scene is stepped by hand)
if (SHOTS) {
  console.log('\n== shots');
  mkdirSync('docs/shots', { recursive: true });
  const shot = async (id, untilBar, name) => {
    await page.evaluate(async (id) => {
      const d = await window.__gsyn.demo();
      await d.start(id, { mode: 'loop' });
    }, id);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const s = await page.evaluate(async () => {
        const d = await window.__gsyn.demo();
        return { bar: window.__gsyn.rt.position.bar, active: d.active, phase: d.phase };
      });
      if (!s.active) break;
      if (s.phase === 'playing' && s.bar === untilBar) break;
      await sleep(100);
    }
    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) window.__gsyn.tick(33);
    });
    await page.screenshot({ path: `docs/shots/${name}.png` });
    console.log('  saved', name);
    await page.evaluate(async () => (await window.__gsyn.demo()).stop('button'));
    await sleep(500);
  };
  await shot('brass-tacks', 4, 'demo');
  await shot('slow-orbit', 8, 'demo-latch');
}

await browser.close();
console.log(failures.length ? `\n${failures.length} failure(s):\n - ${failures.join('\n - ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
