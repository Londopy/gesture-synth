# Changelog

All notable changes to Gesture Synth are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and is machine-readable
with [patchnotes](https://pypi.org/project/patchnotes/) (`patchnotes CHANGELOG.md validate`).
Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Clear camera view: the plain, untinted camera picture with every effect off, with an optional hand wireframe overlay. Three view modes now cycle with `C` (performance, practice, clear camera) and are selectable in the top-right menu, Visuals and Settings.
- Video recorder (`Ctrl/Cmd+Shift+R` or the camera button): records the scene or the raw camera feed with the instrument mix (metronome excluded) and an optional microphone (device picker, gain, level meter) for singing or talking over a loop. Start/stop with a timer, preview, save as webm or mp4.
- Release pipeline: pushing a `v*` tag builds Windows (.msi, setup .exe) and Linux (.AppImage, .deb) installers, a zip of the website with a zero-dependency local server (`node serve.mjs` on http://localhost:4173), `SHA256SUMS.txt`, and release notes generated from this changelog with patchnotes plus an install tutorial.
- `scripts/serve.mjs` and `npm run serve` to run the built site locally with the cross-origin isolation headers.
- Ten hidden gestures (secrets): finger heart, double thumbs up, wave, clap, both fists raised, OK sign, prayer hands, high five, the finger, and the Konami code (unlocks the Arcade theme). Each draws something in the scene and pops an emoji; none of them changes the music. Help › Secrets keeps score with hints, and a Settings toggle turns them off.
- Medals: 48 achievements in six categories (Playing, Looping, Learning, Exploring, Dedication, Hush-Hush) with bronze / silver / gold / platinum tiers and points, progress bars for counters, osu!-style unlock toast with a chime and a spinning shine, a Medals page (rail 🏅, `/medals`) with tier totals, latest unlocks and a detail panel, and hidden medals that show no hint until earned. Stats persist locally; reset from the page or Settings.
- A "Made by Londo" button (GitHub mark) pinned to the bottom of the left rail, in the Help header and in Settings › About, opening the repository; desktop hands the link to the system browser. Settings › About also has a "Report a problem" link.
- Headless screenshot script (`scripts/shots.mjs`) and cheat-sheet renderer (`scripts/render-cheatsheet.mjs`) that drive the camera-less dev hook; `window.__gsyn.tick()` steps one scene frame.
- README: hero and feature screenshots, generated gesture cheat sheet, mermaid architecture diagram, collapsible reference sections, badge wall with the patchnotes changelog badge.

### Fixed
- CI: the Zig kernel is built with -fPIC (Rust links tests as position-independent code on Linux), the community job installs rebar3, and the desktop check fetches the ffmpeg sidecar that Tauri requires at build time.

### Changed
- The camera feed setting became the view mode setting; a saved "camera feed on" preference migrates to the practice view.
- Background field uses a sin-free noise hash (the old one produced blocky squares on some GPUs) and the Neon theme background sits in the blue/violet range instead of olive for sharp keys.
- CI and the release workflow no longer use hosted macOS runners (they hung without finishing); every job now has a timeout. macOS is an opt-in workflow (Apple Silicon runner, arm64 only, no Homebrew, 45 min timeout) that attaches a `.dmg` to an existing release; see DEPLOY.md.
- `scripts/fetch-ffmpeg.mjs --static` falls back to the `ffmpeg-static` package when ffmpeg is not on PATH, so release builds never run without the sidecar.

## [0.1.0] - 2026-09-12

First working build of the whole spec: one Rust core, one TypeScript frontend,
one Zig kernel, one Gleam service, shipped as a Tauri desktop app and a web app.

### Added
- Gesture parser (`crates/gsyn-core`): landmark normalization, per-finger extension test, thumb in/out hysteresis, palm tilt with dead zone, height-to-volume with perceptual curve, 90 ms debounce, confidence hold and fade, chord-degree table for the left hand, shape table for the right hand, flick bass hit, pinch arpeggiator toggle, two-fist circle-of-fifths key change, 2 s latch, Full / Scale-only / Fixed-degree and Full / Fixed-style / Dynamics-only schemes, Theremin mode with velocity prediction and optional snap-to-scale.
- Musical state model with flat float encoding for SharedArrayBuffer and IPC transport, chord derivation (inversion, sevenths, dom7 / m7b5 / dim7 setting, open voicing, octave), roman-numeral and absolute chord names.
- Synth engine: two-oscillator voices, ADSR, trapezoidal state-variable low-pass filter, chord legato (common tones held), arpeggiator, theremin glide voice with vibrato, seven instrument presets, master soft clipper, FDN reverb, stereo delay, limiter, metronome on a separate cue bus.
- Sample-accurate transport: BPM 40 to 240, time signatures 2/4 3/4 4/4 5/4 6/8 7/8, 1 to 16 bars, count-in, beat ticks, 16th / 8th / triplet quantize grids.
- Loop pedal: four event-stream tracks, count-in record flow, overdub and replace modes, loop record, wrap or cut at loop end, quantized onsets, per-step mute grid, chord replacement at a step, track lengths that divide the loop, mixer (volume, pan, mute, solo, instrument, MIDI channel), 100 Hz parameter curves simplified with Ramer-Douglas-Peucker, 15 Hz landmark capture for ghost playback.
- File formats: `session.gsyn.json`, `song.gsyn.json`, `instrument.gsyn.json`, `theme.gsyn.json`; deterministic ASCII-safe serialization so files are byte-identical across web and desktop.
- MIDI: note on/off with legato, CC74 cutoff, CC7/CC11 volume, CC10 pan, per-track channels, Standard MIDI File export (one track per loop track).
- Offline bounce to 16-bit WAV.
- Zig SIMD kernel (`crates/gsyn-zig`) for oscillators, filter, mixing and soft clip, selectable with `--features zig`, with parity tests against the pure-Rust reference kernel.
- WASM bindings (`crates/gsyn-wasm`): parser on the main thread, engine inside an AudioWorklet, flat typed-array protocol, JSON only at UI rate.
- Web app (`app/`): Svelte 5 + Three.js scene with background field, circle-of-fifths ring, tinted camera feed, wireframe hands, ghost hands, note constellation, GPU particles with bass impulse and treble sparkle, filter haze pass, HUD, theremin pitch ruler and ribbon, beat pulse, automatic quality ladder.
- App chrome: dark glass panels tinted by the current key hue, beat-pulsing glows, key wheel, mode and scheme menus, transport with breathing record button, track selector, BPM / time signature / bars / metronome panel, collapsible beat grid and mixer, help overlay with animated gesture cheat sheet, 7-step guided tour with live "try it" checks, calibration screen.
- Pages: Play, Learn (tutorials with ghost target outlines, countdown, timing + shape score, section loop, slow-down), Song Builder (roman or absolute progressions, click entry, tutorial generation, drop into track, export, publish), Instruments (live preset editor), Visuals (five themes, density, ghost opacity, camera feed, bloom, import / export), Community (browse, search, tags, likes, comments, remix chains, share links, sign in), Settings (audio, MIDI, camera, gestures, loop pedal, shortcuts editor, accessibility, storage, community URL).
- Exports: session download, `.mid`, `.wav`, `.webm` clip via MediaRecorder (metronome excluded), `.mp4` via ffmpeg sidecar on desktop or ffmpeg.wasm when cross-origin isolated, 15 s share clip, publish loop to Community.
- Storage: OPFS on the web (localStorage fallback), app data folder on desktop, import / export as files.
- PWA manifest and service worker (offline after first load), hosting header files for Netlify / Cloudflare Pages / Vercel, routes `/`, `/song/<id>`, `/loop/<id>`, `/learn/<id>`, `/preset/<id>`, `/open?u=gsyn://...`.
- Desktop shell (`src-tauri`): Tauri 2, native cpal audio thread fed by a lock-free triple buffer and command ring, midir MIDI out, data-folder file commands, ffmpeg sidecar conversion, `gsyn://` deep links, generated icon set.
- Community service (`services/community`): Gleam on the BEAM with wisp and mist; accounts with PBKDF2-HMAC-SHA256 passwords and hashed bearer tokens; items of kind song / tutorial / preset / theme / loop with tags and remix parents; likes, comments, short links with redirect; list with search, tag, author, sort and pagination; CORS and CORP headers; in-memory store for development and a Postgres store with schema.
- Sample content in `content/` and scripts to fetch the MediaPipe runtime and hand model, render the app icon, and copy an ffmpeg sidecar.
- Camera-less test hook `window.__gsyn.synth(...)` that feeds synthetic hands through the whole pipeline.

### Changed
- Camera failure at startup is not fatal: the app continues with keyboard, loops and every page, and offers a retry in Settings. The spec's first-run flow assumed the camera always starts.

### Fixed
- The AudioWorklet receives raw `.wasm` bytes and compiles them itself. Chromium silently drops a `postMessage` to an AudioWorklet port when the payload contains a `WebAssembly.Module`.
- The synthetic hand generator used by tutorials and tests produces a relaxed thumb inside the octave-neutral band instead of reading as "thumb in".

[Unreleased]: https://github.com/Londopy/gesture-synth/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Londopy/gesture-synth/releases/tag/v0.1.0
