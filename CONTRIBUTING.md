# Contributing to Gesture Synth

Thanks for helping. This document covers setup, the layout, how to test each
part, and what a good pull request looks like.

## Ground rules

- Be kind. The [Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere in this project.
- Open an issue before a large change (new page, new file format field, new engine feature) so we can agree on the shape first.
- Security problems go to the process in [SECURITY.md](SECURITY.md), not to a public issue.

## Setup

Requirements: Rust 1.85+ with the `wasm32-unknown-unknown` target, Node 20+,
and optionally Zig 0.16 (kernel), Gleam 1.18 + Erlang/OTP 27+ (community
service), and the Tauri prerequisites for your OS.

```bash
git clone https://github.com/Londopy/gesture-synth.git
cd gesture-synth
npm install
npm run models            # MediaPipe runtime + hand model into app/public
npm run dev               # WASM build + Vite on http://localhost:5173
```

Desktop: `npm run tauri:dev`. Community service: `cd services/community && gleam run`.

## Layout

| Path | What lives there | Language |
| --- | --- | --- |
| `crates/gsyn-core` | gesture parser, music theory, synth, transport, loop engine, formats, MIDI, engine | Rust |
| `crates/gsyn-wasm` | wasm-bindgen surface | Rust |
| `crates/gsyn-zig` | SIMD DSP kernel, optional | Zig |
| `app/src/lib` | audio (worklet bridge), tracking (MediaPipe, parser bridge), scene (Three.js layers), state (runtime, settings, UI), ui (chrome), export, storage, community client | TypeScript / Svelte 5 |
| `app/src/routes` | pages | Svelte 5 |
| `src-tauri` | desktop shell | Rust |
| `services/community` | community backend | Gleam |
| `content` | sample `.gsyn.json` files | JSON |

One rule shapes everything: exactly one producer of `MusicalState` per slot
(the parser for the live slot, the loop engine for track slots). The synth
and the scene are consumers. Please keep it that way.

## Tests

Run everything relevant to your change before opening a PR.

```bash
cargo test -p gsyn-core                      # core (also: --features zig)
cd app && npx svelte-check && npx vitest run # frontend types + unit tests
cd crates/gsyn-zig && zig build test         # kernel + parity with the Rust reference
cd services/community && gleam test          # HTTP tests against the memory store
```

Camera-less end-to-end testing in the browser: open the app, then in the
console run `window.__gsyn.synth(leftMask, rightMask, leftTilt, rightTilt, rightY)`.
Masks are finger bitmasks (bit 0 thumb, bit 1 index, ...). This drives the
real parser, worklet engine and scene without a webcam.

## Style

- Rust: `cargo fmt`, `cargo clippy -p gsyn-core -- -D warnings`. Nothing in the audio path may allocate or lock; new synth code goes through the block-based kernel functions.
- TypeScript / Svelte: the project uses Svelte 5 runes (`$state`, `$derived`, `$effect`). Keep per-frame data out of reactive state; the scene reads plain fields on the runtime.
- Zig: `zig fmt`. Keep the kernel freestanding (no std allocations, no libc) so it still builds for wasm32.
- Gleam: `gleam format`. Add a test for every endpoint change.
- Comments explain why, not what. Reference the spec section when a constant comes from it (for example "spec 4.8").

## Adding things

- **A gesture or control scheme**: `crates/gsyn-core/src/gesture.rs` + a test with `synth_hand`, then the cheat sheet in `app/src/lib/ui/HelpOverlay.svelte` and, if it changes the tour, `app/src/lib/tour/steps.ts`.
- **An instrument preset**: `crates/gsyn-core/src/instruments.rs` (`BUILTIN_NAMES` + a constructor) and the `INSTRUMENTS` lists in the UI.
- **A visual theme**: `app/src/lib/themes.ts`.
- **A file format field**: add it with `#[serde(default)]` so old files still load, bump `FORMAT_VERSION` only for breaking changes, and add a round-trip test in `session.rs`.
- **A community endpoint**: `services/community/src/community/router.gleam` + handler module + `test/community_test.gleam` + the `CommunityApi` client in `app/src/lib/community/api.ts`.

## Pull requests

1. Branch from `main`, one topic per PR.
2. Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) using a Keep a Changelog heading (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Breaking`). `patchnotes CHANGELOG.md validate` must pass.
3. Describe what changed and how you tested it. Screenshots or a short clip for anything visual.
4. CI must be green (core tests, frontend check + tests, Zig tests, Gleam tests).

## Releasing

```bash
patchnotes CHANGELOG.md bump 0.2.0    # moves Unreleased into a dated release
# bump "version" in Cargo.toml (workspace), package.json, app/package.json, src-tauri/tauri.conf.json
git tag v0.2.0 && git push --tags     # the release workflow builds desktop bundles
```

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
