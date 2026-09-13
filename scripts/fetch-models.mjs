#!/usr/bin/env node
// Copies the MediaPipe Tasks Vision WASM runtime into app/public/mediapipe and
// downloads the hand landmarker model into app/public/models so the app works
// offline (PWA) and inside the Tauri webview without hitting Google's CDN.
//
//   node scripts/fetch-models.mjs            copy runtime + download model
//   node scripts/fetch-models.mjs --copy-only  copy runtime only (postinstall)

import { mkdirSync, copyFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const appDir = join(root, 'app');
const copyOnly = process.argv.includes('--copy-only');

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';

function findWasmDir() {
  const candidates = [
    join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
    join(appDir, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
  ];
  return candidates.find((c) => existsSync(c));
}

function copyRuntime() {
  const src = findWasmDir();
  if (!src) {
    console.warn('[models] @mediapipe/tasks-vision not installed yet; skipping runtime copy');
    return false;
  }
  const dst = join(appDir, 'public', 'mediapipe');
  mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of readdirSync(src)) {
    const s = join(src, f);
    if (statSync(s).isFile()) {
      copyFileSync(s, join(dst, f));
      n++;
    }
  }
  console.log(`[models] copied ${n} MediaPipe runtime files -> app/public/mediapipe`);
  return true;
}

async function downloadModel() {
  const dst = join(appDir, 'public', 'models', 'hand_landmarker.task');
  mkdirSync(dirname(dst), { recursive: true });
  if (existsSync(dst) && statSync(dst).size > 1_000_000) {
    console.log('[models] hand_landmarker.task already present');
    return;
  }
  console.log('[models] downloading hand_landmarker.task ...');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dst, buf);
  console.log(`[models] saved ${(buf.length / 1e6).toFixed(1)} MB -> app/public/models/hand_landmarker.task`);
}

copyRuntime();
if (!copyOnly) {
  downloadModel().catch((e) => {
    console.error('[models]', e.message);
    process.exitCode = 1;
  });
}
