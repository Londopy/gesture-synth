#!/usr/bin/env node
// Downloads a static ffmpeg for the current platform into src-tauri/binaries
// named the way Tauri expects a sidecar: ffmpeg-<rust target triple>[.exe].
// On this machine ffmpeg is already on PATH, so we copy that if present.

import { execSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const triple = execSync('rustc -vV').toString().match(/host: (.*)/)[1].trim();
const ext = process.platform === 'win32' ? '.exe' : '';
const dst = join('src-tauri', 'binaries', `ffmpeg-${triple}${ext}`);
mkdirSync(join('src-tauri', 'binaries'), { recursive: true });
if (existsSync(dst)) {
  console.log('[ffmpeg] sidecar already present:', dst);
  process.exit(0);
}
let src = '';
try {
  src = execSync(process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg').toString().split(/\r?\n/)[0].trim();
} catch {
  /* not on PATH */
}
if (src && existsSync(src)) {
  copyFileSync(src, dst);
  console.log('[ffmpeg] copied', src, '->', dst);
} else if (process.argv.includes('--static')) {
  // no ffmpeg on PATH: pull a prebuilt static binary via the ffmpeg-static npm
  // package (Linux x64/arm64, macOS x64/arm64, Windows x64), no Homebrew needed
  console.log('[ffmpeg] not on PATH, installing ffmpeg-static ...');
  execSync('npm install --no-save --no-audit --no-fund ffmpeg-static@5', { stdio: 'inherit' });
  const bin = join('node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (!existsSync(bin)) {
    console.error('[ffmpeg] ffmpeg-static did not provide a binary for this platform');
    process.exit(1);
  }
  copyFileSync(bin, dst);
  if (process.platform !== 'win32') chmodSync(dst, 0o755);
  console.log('[ffmpeg] copied', bin, '->', dst);
} else {
  console.log(`[ffmpeg] no ffmpeg on PATH. Download a static build for ${triple} and save it as ${dst}`);
  console.log('  Windows: https://www.gyan.dev/ffmpeg/builds/   macOS: https://evermeet.cx/ffmpeg/   Linux: https://johnvansickle.com/ffmpeg/');
  process.exit(1);
}
