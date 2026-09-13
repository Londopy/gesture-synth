#!/usr/bin/env node
// Serves the built web app from a folder on http://localhost:4173 with the
// cross-origin isolation headers the app wants (SharedArrayBuffer). No
// dependencies: run it with plain Node 18+.
//
//   node serve.mjs            # serves ./dist or the folder this script sits in
//   node serve.mjs 8080       # custom port
//   node serve.mjs 8080 ./dist

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 4173);
const root = resolve(process.argv[3] || (existsSync(join(here, 'index.html')) ? here : existsSync(join(here, 'dist', 'index.html')) ? join(here, 'dist') : join(here, '..', 'app', 'dist')));

if (!existsSync(join(root, 'index.html'))) {
  console.error(`No index.html in ${root}. Build the app first (npm run build) or pass the folder as the second argument.`);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, path);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA routes (/loop/<id>, /learn/<id>, ...) fall back to the shell
    file = join(root, 'index.html');
  }
  const ext = extname(file).toLowerCase();
  const cache = file.includes(`${'assets'}`) || ext === '.task' || ext === '.wasm' ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': cache });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`Gesture Synth is running at http://localhost:${port}`);
  console.log(`Serving ${root}`);
  console.log('Open the address in Chrome, Edge or Firefox and click Start. Ctrl+C stops the server.');
});
