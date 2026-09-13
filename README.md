# Gesture Synth

A desktop and web instrument you play with your hands in front of a camera.
Left hand picks the chord (scale degree + major/minor tilt), right hand shapes
it (inversion, sevenths, octave, filter, volume). A loop pedal records gesture
performances into four tracks against a metronome; everything is drawn back as
a live, harmony-aware scene (wireframe hands, note constellation, circle of
fifths, audio-reactive particles, ghost hands replaying your loops).

One codebase, two targets: a Tauri 2 desktop app (native audio thread, MIDI
out, ffmpeg export) and a static web app at the same URL structure (PWA,
offline after first load). Sessions are byte-identical across both.

```
crates/gsyn-core      Rust: gesture parser, chord model, synth, transport, loop engine, formats, MIDI
crates/gsyn-wasm      wasm-bindgen surface (parser on the main thread, engine in an AudioWorklet)
crates/gsyn-zig       Zig SIMD DSP kernel (oscillators, SVF, mixing, soft clip); linked via `--features zig`
app/                  Svelte 5 + TypeScript + Three.js frontend (web + Tauri webview)
src-tauri/            Tauri 2 shell: cpal audio, midir MIDI, data folder, ffmpeg sidecar, gsyn:// links
services/community    Gleam (BEAM) community service: accounts, uploads, likes, comments, remix chains, short links
content/              Sample songs, instrument and theme files (.gsyn.json)
scripts/              Model/runtime fetch, icon render, ffmpeg sidecar
```

## Prerequisites

| Tool | Version used | Notes |
| --- | --- | --- |
| Rust | 1.98 | plus `rustup target add wasm32-unknown-unknown` |
| Node | 24 | npm workspaces |
| Zig | 0.16 | only for the `zig` kernel feature |
| Gleam / Erlang | 1.18 / OTP 29 | only for the community service |
| ffmpeg | any | optional: sidecar for mp4 export (`node scripts/fetch-ffmpeg.mjs`) |
| Tauri prerequisites | | WebView2 on Windows, Xcode CLT on macOS, webkit2gtk on Linux |

## Quick start (web)

```bash
npm install                 # root + app workspace, installs wasm-pack and the Tauri CLI
npm run models              # copies the MediaPipe runtime and downloads the hand model (7.8 MB) into app/public
npm run dev                 # builds the WASM, starts Vite on http://localhost:5173 with COOP/COEP headers
```

Open the URL, click Start, allow the camera. Two hands side by side, palms to
the camera. Index finger up on the left hand plays I.

## Desktop (Tauri)

```bash
node scripts/fetch-ffmpeg.mjs   # optional mp4 sidecar
npm run tauri:dev               # dev window against the Vite server
npm run tauri:build             # installers in src-tauri/target/release/bundle
```

The desktop build runs the same Rust engine on a native cpal audio thread
(lower latency, buffer size in Settings), sends MIDI through midir, stores
sessions in the app data folder and registers the `gsyn://` scheme so
`gsyn://loop/<id>` opens the same content as `https://<host>/loop/<id>`.

## Tests

```bash
npm test                    # cargo test -p gsyn-core (66 tests) + vitest (frontend)
cargo test -p gsyn-core --features zig   # same tests against the Zig kernel
cd crates/gsyn-zig && zig build test     # kernel invariants + parity with the Rust reference
cd services/community && gleam test      # 23 end-to-end HTTP tests against the in-memory store
```

## Community service

```bash
cd services/community
gleam run                                       # in-memory store on :8787
DATABASE_URL=postgres://... gleam run           # Postgres (psql -f sql/schema.sql first)
```

Set the URL in the app under Settings, or `VITE_COMMUNITY_URL` at build time.
Endpoints, env vars and curl examples are in `services/community/README.md`.

## Hosting the web build

The web build needs cross-origin isolation for SharedArrayBuffer (AudioWorklet
ring buffer, ffmpeg.wasm threads):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`app/public/_headers` (Netlify, Cloudflare Pages) and `app/vercel.json` set
them. Without them the app still runs: it falls back to postMessage (one
camera frame of extra latency) and webm-only export.

## Controls

| Key | Action |
| --- | --- |
| Space | play / stop |
| R | record on the selected track (1 bar count-in) |
| 1-4 | select track |
| M / S | mute / solo selected track |
| Delete / Shift+Delete | clear track / all tracks |
| Tab | Gesture / Theremin mode |
| [ / ] | key down / up around the circle of fifths |
| - / = | BPM -1 / +1 (Shift: 10) |
| Esc | panic |
| F | performance view (hide chrome) |
| G | beat grid + mixer |
| H or ? | help |
| Ctrl/Cmd+S, Ctrl/Cmd+E | save session, export sheet |

The gesture cheat sheet with animated hands is in the app under Help.

## Files

All JSON, UTF-8, ASCII-safe (`crates/gsyn-core/src/session.rs`):

- `*.session.gsyn.json`: transport, key, four tracks (events, curves, 15 Hz landmarks, step mutes), theme, calibration
- `*.song.gsyn.json`: chord progression with timing, hints, tags
- `*.instrument.gsyn.json`: oscillators, envelope, filter, fx
- `*.theme.gsyn.json`: palette, particle density, bloom, haze, ghost opacity, background style

Exports: `.mid` (one track per loop track, CCs 74/7/10), `.wav` (offline
bounce), `.webm` (MediaRecorder, scene + audio, no metronome), `.mp4` (ffmpeg
sidecar on desktop, ffmpeg.wasm in isolated browsers).

## Notes

- Camera-less testing: `window.__gsyn.synth(leftMask, rightMask, leftTilt, rightTilt, rightY)` feeds synthetic hands through the whole pipeline (masks are finger bitmasks, bit 0 = thumb).
- Chromium silently drops `postMessage` of a `WebAssembly.Module` to an AudioWorklet port; the worklet receives raw bytes and compiles them itself.
- The Zig kernel and the pure-Rust reference kernel are numerically interchangeable (parity tests in `crates/gsyn-zig/test`).
