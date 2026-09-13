## What

<!-- one or two sentences -->

## Why

## How I tested it

- [ ] `cargo test -p gsyn-core`
- [ ] `cd app && npx svelte-check && npx vitest run`
- [ ] `cd crates/gsyn-zig && zig build test` (if the kernel changed)
- [ ] `cd services/community && gleam test` (if the service changed)
- [ ] Tried it with a real camera / in the desktop app (if user-facing)
- [ ] Checked the clear camera view and a short recording still work (if the scene, audio graph or settings changed)

## Checklist

- [ ] Added a line under `## [Unreleased]` in CHANGELOG.md
- [ ] No allocation or locking added to the audio path
- [ ] Screenshots or clip attached for visual changes
