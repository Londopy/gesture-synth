#!/usr/bin/env node
// Stage end-to-end check in a headless Chromium: boots into the game shell,
// opens the menu and the Sets wheel, then plays Four Chords twice through the
// real parser with synthetic hands, once on the beat (must rate Flawless) and
// once 150 ms late (must rate below Tight with Late judgments). Needs a built
// app served on http://localhost:4173 (npm run build && npm run serve).
//
//   npm install --no-save puppeteer-core
//   node scripts/stage-check.mjs            # exit code 1 on any failure
//   node scripts/stage-check.mjs --shots    # also writes docs/shots/stage-*.png
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
if (SHOTS) mkdirSync('docs/shots', { recursive: true });

const failures = [];
function check(cond, msg) {
  if (cond) console.log('  ok   ' + msg);
  else {
    console.log('  FAIL ' + msg);
    failures.push(msg);
  }
}

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1600,900', '--hide-scrollbars'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', (d) => d.accept());
const tick = (n = 3) => page.evaluate((n) => { for (let i = 0; i < n; i++) window.__gsyn?.tick?.(33); }, n);
const shot = async (name) => { if (SHOTS) { await tick(6); await page.screenshot({ path: `docs/shots/${name}.png` }); } };

await page.goto(URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('gsyn.settings.v1', JSON.stringify({ shell: 'stage', introSeen: 3, theme: 'Neon', firstRunDone: true, tourDone: true }));
});
await page.reload({ waitUntil: 'networkidle0' });

console.log('== menu');
const items = await page.evaluate(() => document.querySelectorAll('[role="menuitem"]').length);
check(items === 7, `seven menu keys (${items})`);
await page.mouse.click(1200, 450); // any click starts the sound
await page.waitForFunction(() => window.__gsyn && window.__gsyn.rt.phase === 'ready', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));
const music = await page.evaluate(() => ({ state: window.__gsyn.rt.position.state, bpm: window.__gsyn.rt.position.bpm, track4: window.__gsyn.rt.trackSummary[3]?.empty }));
check(music.state === 2 && music.bpm === 72 && music.track4 === false, `menu music playing on track 4 at 72 BPM (${JSON.stringify(music)})`);
await page.hover('[role="menuitem"]:nth-child(2)');
await shot('stage-menu');

console.log('== sets');
await page.click('[role="menuitem"]:nth-child(2)');
await new Promise((r) => setTimeout(r, 900));
const sets = await page.evaluate(() => ({ cards: document.querySelectorAll('.card').length, selected: document.querySelector('aside .name')?.textContent }));
check(sets.cards >= 10, `song cards on the wheel (${sets.cards})`);
check(!!sets.selected, `a song is selected (${sets.selected})`);
await page.keyboard.press('ArrowRight');
await new Promise((r) => setTimeout(r, 900));
const moved = await page.evaluate(() => ({ name: document.querySelector('aside .name')?.textContent, state: window.__gsyn.rt.position.state }));
check(moved.name !== sets.selected, `arrow key moves the selection (${moved.name})`);
check(moved.state === 2, 'the selected song previews through the engine');
await shot('stage-sets');

/** Play Four Chords with synthetic hands; lateMs shifts every chord late. */
async function playSet(lateMs) {
  await page.evaluate(async () => {
    window.__gsyn.rt.cameraGate = () => true; // no camera here; we feed the hands
    const st = await window.__gsyn.stage();
    st.playSet('four-chords');
  });
  await page.waitForFunction(() => /Press Start|Hold both hands/.test(document.body.innerText), { timeout: 40000 });
  return page.evaluate(async (lateMs) => {
    const g = window.__gsyn;
    const rt = g.rt;
    const st = await g.stage();
    const chords = [[0b00010, 22], [0b11111, 22], [0b10010, -24], [0b11110, 22]]; // I V vi IV: left masks + tilt
    const msPerBeat = 60000 / 84;
    const leadMs = 105 - lateMs; // the parser commits a pose after ~96 ms
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Start'))?.click();
    const t0 = performance.now();
    await new Promise((resolve) => {
      const iv = setInterval(async () => {
        if (st.screen === 'results' || performance.now() - t0 > 30000) {
          clearInterval(iv);
          resolve();
          return;
        }
        const p = rt.position;
        if (p.state !== 2) {
          await g.synth(chords[0][0], 0b00010, chords[0][1], 0, 0.3, 1); // hold I through the count-in
          return;
        }
        const beatPos = (p.bar - 1) * p.beats + (p.beat - 1) + p.phase;
        const idx = Math.min(3, Math.max(0, Math.floor((beatPos + leadMs / msPerBeat) / 4)));
        await g.synth(chords[idx][0], 0b00010, chords[idx][1], 0, 0.3, 1);
        g.tick(16);
      }, 16);
    });
    const r = st.lastResult;
    return r && { screen: st.screen, score: r.score.score, hits: r.score.hits.map((h) => ({ j: h.judgment, ms: h.offsetMs })), text: document.body.innerText.replace(/\s+/g, ' ').match(/TAKE RATING (\S+(?: \S+)*?) /)?.[1] };
  }, lateMs);
}

console.log('== set on the beat');
const onBeat = await playSet(0);
check(onBeat?.screen === 'results', 'the set ends on the results screen');
check(onBeat?.hits.length === 4, `four judgments (${onBeat?.hits.length})`);
check(onBeat?.hits.every((h) => h.j === 'locked'), `every chord Locked (${onBeat?.hits.map((h) => `${h.j}@${Math.round(h.ms)}ms`).join(' ')})`);
await new Promise((r) => setTimeout(r, 1000));
const ratingOn = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').match(/TAKE RATING (.+?) (Every|Tight|Solid|You|Most|A first)/)?.[1]);
check(ratingOn === 'Flawless', `rated Flawless (${ratingOn})`);
await shot('stage-results');
await page.keyboard.press('Escape'); // back to Sets
await new Promise((r) => setTimeout(r, 700));

console.log('== set 150 ms late');
const late = await playSet(150);
check(late?.hits.slice(1).every((h) => h.j === 'late'), `chords after the first judged Late (${late?.hits.map((h) => `${h.j}@${Math.round(h.ms)}ms`).join(' ')})`);
check(late?.hits.slice(1).every((h) => h.ms > 120 && h.ms < 220), 'late offsets measured inside the Late window');
await new Promise((r) => setTimeout(r, 1000));
const ratingLate = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').match(/TAKE RATING (.+?) (Every|Tight|Solid|You|Most|A first)/)?.[1]);
check(['Rough', 'Loose', 'Steady'].includes(ratingLate), `rated below Tight (${ratingLate})`);

console.log('== restore');
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 700));
const after = await page.evaluate(() => ({ state: window.__gsyn.rt.position.state, records: JSON.parse(localStorage.getItem('gsyn.stage.v1') || '{}') }));
check(after.records.sets === 2, `two sets recorded locally (${after.records.sets})`);
check(after.records.bests?.['four-chords']?.rating === 'flawless', 'the best take kept is the Flawless one');

check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
