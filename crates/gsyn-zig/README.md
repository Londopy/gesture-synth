# gsyn-zig: Gesture Synth DSP kernel

`src/kernel.zig` is the SIMD hot-path kernel for Gesture Synth. It is a
numerically faithful twin of the pure-Rust `reference` module in
`crates/gsyn-core/src/synth/kernel.rs`: same polynomials, same evaluation
order, same state handling. The Rust side switches between the two with the
`zig` cargo feature; every output of the two kernels agrees within `1e-4`
(in practice, lane-for-lane identical floats except for ULP-level ramp drift).

It is freestanding: no `std` imports in the kernel, no libc, no allocation,
no panics, strict IEEE float mode (no FMA contraction). It compiles for
`wasm32-freestanding` and every native target Zig supports.

## What the kernel does

| Function | Purpose |
|---|---|
| oscillator | 4 waveforms, phase accumulator 0..1, `inc` clamped to 0..0.5. Saw and square are PolyBLEP anti-aliased (scalar, data-dependent branches), sine and triangle are evaluated 8 lanes at a time. |
| SVF low-pass | Cytomic / Andrew Simper trapezoidal state-variable filter, `g = tan(pi*fc/fs)`, `k = 2 - 2*res`. Serial recurrence, scalar. |
| mix_add | `dst += src * gain`, SIMD. |
| mix_add_ramp | `dst += src * g_i`, `g_i` ramps linearly `g0 -> g1` across the block, SIMD. |
| softclip | `tanh(x*drive) / tanh(drive)` using a rational Pade tanh clamped to +-4.5, SIMD. |

SIMD width is `@Vector(8, f32)` (`kernel.W`). Every vector loop is followed by
a scalar tail, so any block length `n` (including 0) is accepted. On 128-bit
targets (SSE2, wasm `simd128`, NEON) LLVM splits each 8-wide op into two.

## C ABI

All symbols are `export fn ... callconv(.c)`. Pointers are non-null and
point at `n` contiguous `f32`s unless stated. No function allocates or panics.

| Symbol | Signature | Notes |
|---|---|---|
| `gsyn_kernel_version` | `u32 gsyn_kernel_version(void)` | Returns `1`. Rust `kernel_version()` reports it. |
| `gsyn_osc_block` | `void gsyn_osc_block(float* out, u32 n, float* phase, float inc, u32 wave)` | Writes `n` samples; advances `*phase`. `wave`: 0 saw, 1 sine, 2 triangle, 3+ square. |
| `gsyn_svf_lp_block` | `void gsyn_svf_lp_block(float* io, u32 n, float state[2], float g, float k)` | In place. `state = [ic1eq, ic2eq]` persists between blocks. |
| `gsyn_mix_add` | `void gsyn_mix_add(float* dst, const float* src, float gain, u32 n)` | `dst[i] += src[i] * gain` |
| `gsyn_mix_add_ramp` | `void gsyn_mix_add_ramp(float* dst, const float* src, float g0, float g1, u32 n)` | `dst[i] += src[i] * (g0 + i*(g1-g0)/max(n,1))` |
| `gsyn_softclip_block` | `void gsyn_softclip_block(float* io, u32 n, float drive)` | In place. `drive` floored at `1e-3`. Unity gain at `|x| = 1`. |

The Rust declarations live in the `ffi` module of `kernel.rs`.

## Building

Requires Zig 0.16.0.

### Native static library (what `build.rs` does)

```sh
# Windows MSVC  -> zig-out/gsynkernel.lib
zig build-lib src/kernel.zig -OReleaseFast -fno-stack-check --name gsynkernel \
    -target x86_64-windows-msvc -femit-bin=zig-out/gsynkernel.lib

# wasm32        -> zig-out/libgsynkernel.a
zig build-lib src/kernel.zig -OReleaseFast -fno-stack-check --name gsynkernel \
    -target wasm32-freestanding -femit-bin=zig-out/libgsynkernel.a
```

### With the Zig build system

```sh
zig build -Doptimize=ReleaseFast                            # host target -> zig-out/lib/ (default mode is Debug)
zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
zig build -Dtarget=x86_64-linux-gnu -Doptimize=ReleaseSmall
zig build test                                              # runs both Zig test suites on the host
zig build test -Doptimize=ReleaseFast                       # same, against the optimised kernel
```

### Running the tests directly

Zig forbids `@import("../src/kernel.zig")` from `test/` ("import of file
outside module path"), so the kernel is provided as a named module `kernel`:

```sh
zig test --dep kernel -Mroot=test/kernel_test.zig     -Mkernel=src/kernel.zig
zig test --dep kernel -Mroot=test/reference_check.zig -Mkernel=src/kernel.zig
```

`test/kernel_test.zig` checks the same invariants as the Rust unit tests
(saw bounded and periodic, sine quarter points, SVF passes DC / crushes
Nyquist, softclip unity at 1.0, block splitting, n = 0 safety).
`test/reference_check.zig` contains an independent scalar port of the Rust
reference and asserts the SIMD kernel matches it within `1e-4` across all
four waveforms, eight increments (including clamped ones), random phases,
random SVF coefficients, random mix gains, odd block lengths, and drives
from 0 to 100. Block length 1003 is used so every SIMD tail path is covered.

## How Rust links it

`crates/gsyn-core/build.rs` runs only when the `zig` feature is enabled:

1. Maps the cargo `TARGET` triple to a Zig target
   (`x86_64-pc-windows-msvc -> x86_64-windows-msvc`,
   `wasm32-unknown-unknown -> wasm32-freestanding`, etc.).
2. Runs the `zig build-lib ...` command shown above with
   `-femit-bin=$OUT_DIR/gsynkernel.lib` (MSVC) or `$OUT_DIR/libgsynkernel.a`.
3. Emits `cargo:rustc-link-search=native=$OUT_DIR` and
   `cargo:rustc-link-lib=static=gsynkernel`.

`kernel.rs` then dispatches every public function to the `ffi` externs
instead of `reference::*`. Override the compiler path with `GSYN_ZIG=/path/to/zig`.

```sh
cargo build -p gsyn-core --features zig
cargo test  -p gsyn-core --features zig     # Rust-side contract tests against the Zig kernel
```

## Numerical parity notes

* Phase accumulators are advanced serially (`p += inc; if (p >= 1) p -= 1`)
  in both kernels, so the returned phase is bit-identical, not just close.
  The SIMD sine/triangle paths fill an 8-lane phase vector from that serial
  accumulator and vectorise only the waveform polynomial.
* `mix_add_ramp` adds `8*step` once per vector where the reference adds
  `step` eight times; the difference is bounded by a few ULPs times the block
  length and stays far under `1e-4` for any realistic block size.
* The kernel is compiled in Zig's default strict float mode. Do not add
  `@setFloatMode(.optimized)`: it would permit FMA fusion and reassociation
  and break the bit-level agreement the parity tests rely on.

## Known limits

* `inc` is clamped to `[0, 0.5]`; NaN increments or NaN input samples
  propagate as NaN (no sanitising), same as the Rust reference.
* Block lengths are `u32`; `n` is trusted and never bounds-checked beyond
  what the caller passes.
* `gsyn_mix_add` / `gsyn_mix_add_ramp` assume `dst` and `src` do not
  partially overlap (identical pointers are fine).
* The SVF is intentionally scalar (serial recurrence); there is no
  multi-channel batching yet.
* The 8-wide vector is a fixed choice; there is no runtime CPU dispatch. Pass
  `-mcpu=...` (or `-Dcpu=...` with `zig build`) to enable AVX on native builds.
* `build.zig` is for stand-alone development and testing only; the Rust
  build uses `zig build-lib` directly and does not read it.
