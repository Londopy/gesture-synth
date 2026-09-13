//! Gesture Synth DSP hot-path kernel (Zig).
//!
//! This file is the SIMD twin of the pure-Rust `reference` module in
//! crates/gsyn-core/src/synth/kernel.rs. Both implementations must agree
//! numerically (max abs diff <= 1e-4 on every output, for identical inputs).
//! The Rust side links this as a static library when the `zig` cargo feature
//! is enabled and calls the `gsyn_*` symbols below through a plain C ABI.
//!
//! Design rules
//!   * Freestanding-compatible: no std, no libc, no allocation, no panics
//!     (every loop is bounds-driven by the caller-supplied `n`; nothing here
//!     can trap in ReleaseFast). Compiles for `wasm32-freestanding` as well as
//!     native targets.
//!   * Strict float mode (Zig default): no FMA contraction or reassociation, so
//!     per-lane arithmetic is the same IEEE sequence the Rust reference runs.
//!   * SIMD via `@Vector(W, f32)` for the embarrassingly-parallel kernels
//!     (mix, ramp-mix, soft clip, sine and triangle oscillators). Every SIMD
//!     loop is followed by a scalar tail loop so any `n` is accepted.
//!   * Serial state (the oscillator phase accumulator, the SVF integrators) is
//!     advanced exactly as the reference does (`p += inc; if (p >= 1) p -= 1`),
//!     one sample at a time. For the SIMD oscillators we fill a phase vector by
//!     stepping the scalar accumulator W times, then evaluate the waveform
//!     polynomial on the whole vector. This keeps the returned phase
//!     bit-identical to the reference instead of drifting by ULPs, which
//!     matters because a ULP difference right at the 1.0 wrap point would
//!     otherwise show up as a ~1.0 jump in the reported phase.
//!
//! Waveform ids (`wave` argument)
//!   0 = saw      PolyBLEP anti-aliased rising saw, range -1..1 (scalar path)
//!   1 = sine     parabolic fast_sin polynomial (SIMD path)
//!   2 = triangle naive, range -1..1 (SIMD path)
//!   3 = square   PolyBLEP, 50% duty (scalar path; any id >= 3 is square)
//!
//! Filter: Cytomic (Andrew Simper) trapezoidal SVF low-pass.
//!   g = tan(pi * fc / fs), k = 2 - 2*res (res in 0..1), state = [ic1eq, ic2eq]

/// Contract version reported by `gsyn_kernel_version`. Bump together with the
/// Rust `kernel_version()` when the ABI or semantics change.
pub const KERNEL_VERSION: u32 = 1;

/// SIMD lane count. 8 x f32 = 256 bits (AVX); on targets with 128-bit
/// vectors (SSE2, wasm simd128, NEON) LLVM legalises this to two ops.
pub const W = 8;
const V = @Vector(W, f32);
const VBool = @Vector(W, bool);

inline fn splat(x: f32) V {
    return @splat(x);
}

/// [0, 1, 2, ..., W-1] as floats, used to spread a linear ramp across lanes.
const lane_index: V = blk: {
    var v: [W]f32 = undefined;
    for (0..W) |l| v[l] = @floatFromInt(l);
    break :blk v;
};

// ---------------------------------------------------------------------------
// Scalar primitives: exact ports of the Rust reference helpers.
// Public so the Zig test suites can call them directly.
// ---------------------------------------------------------------------------

/// Two-sample polynomial band-limited step residual for a discontinuity at
/// phase 0 / 1. `t` is the phase (0..1), `dt` the per-sample increment.
pub inline fn polyblep(t: f32, dt: f32) f32 {
    if (t < dt) {
        const x = t / dt;
        return x + x - x * x - 1.0;
    } else if (t > 1.0 - dt) {
        const x = (t - 1.0) / dt;
        return x * x + x + x + 1.0;
    } else {
        return 0.0;
    }
}

/// sin(2*pi*x) for x in 0..1. Parabola refined once (max abs error ~1e-3).
/// The polynomial and its evaluation order are shared with the Rust side.
pub inline fn fastSin(x: f32) f32 {
    const t = if (x >= 0.5) x - 1.0 else x; // -0.5..0.5
    const y = 16.0 * t * (0.5 - @abs(t)); // 0 at 0, +1 at 0.25, 0 at +-0.5, -1 at -0.25
    return 0.225 * (y * @abs(y) - y) + y;
}

/// Vector form of `fastSin`, lane-for-lane identical arithmetic.
inline fn fastSinV(x: V) V {
    const t = @select(f32, x >= splat(0.5), x - splat(1.0), x);
    const y = splat(16.0) * t * (splat(0.5) - @abs(t));
    return splat(0.225) * (y * @abs(y) - y) + y;
}

/// Rational tanh approximation (Pade 7/6), input clamped to +-4.5.
pub inline fn tanhApprox(x_in: f32) f32 {
    const x = @min(@max(x_in, -4.5), 4.5);
    const x2 = x * x;
    return x * (135135.0 + x2 * (17325.0 + x2 * (378.0 + x2))) /
        (135135.0 + x2 * (62370.0 + x2 * (3150.0 + x2 * 28.0)));
}

/// Vector form of `tanhApprox`.
inline fn tanhApproxV(x_in: V) V {
    const x = @min(@max(x_in, splat(-4.5)), splat(4.5));
    const x2 = x * x;
    return x * (splat(135135.0) + x2 * (splat(17325.0) + x2 * (splat(378.0) + x2))) /
        (splat(135135.0) + x2 * (splat(62370.0) + x2 * (splat(3150.0) + x2 * splat(28.0))));
}

/// Advance a 0..1 phase accumulator by `inc` with a single wrap, exactly as
/// the reference does. `inc` is already clamped to 0..0.5 so one subtraction
/// is always enough.
inline fn advance(p: f32, inc: f32) f32 {
    var q = p + inc;
    if (q >= 1.0) q -= 1.0;
    return q;
}

// ---------------------------------------------------------------------------
// Exported C ABI
// ---------------------------------------------------------------------------

/// Returns the kernel contract version (1).
pub export fn gsyn_kernel_version() callconv(.c) u32 {
    return KERNEL_VERSION;
}

/// Render `n` samples of waveform `wave` into `out`, advancing `*phase`
/// (0..1) by `inc` per sample. `inc` is clamped to 0..0.5 (Nyquist).
pub export fn gsyn_osc_block(out: [*]f32, n: u32, phase: *f32, inc_in: f32, wave: u32) callconv(.c) void {
    const len: usize = n;
    var p = phase.*;
    const inc = @min(@max(inc_in, 0.0), 0.5);

    switch (wave) {
        // --- 0: PolyBLEP saw. The BLEP residual depends on where each sample
        // sits relative to the wrap, a data-dependent branch, so keep scalar.
        0 => {
            var i: usize = 0;
            while (i < len) : (i += 1) {
                out[i] = (2.0 * p - 1.0) - polyblep(p, inc);
                p = advance(p, inc);
            }
        },
        // --- 1: sine, SIMD. Phase vector is filled serially (exact parity),
        // the polynomial is evaluated on all W lanes at once.
        1 => {
            var i: usize = 0;
            while (i + W <= len) : (i += W) {
                var ph: V = undefined;
                inline for (0..W) |l| {
                    ph[l] = p;
                    p = advance(p, inc);
                }
                out[i..][0..W].* = fastSinV(ph);
            }
            while (i < len) : (i += 1) {
                out[i] = fastSin(p);
                p = advance(p, inc);
            }
        },
        // --- 2: naive triangle, SIMD. y = p < 0.5 ? 4p - 1 : 3 - 4p
        2 => {
            var i: usize = 0;
            while (i + W <= len) : (i += W) {
                var ph: V = undefined;
                inline for (0..W) |l| {
                    ph[l] = p;
                    p = advance(p, inc);
                }
                const four_p = splat(4.0) * ph;
                out[i..][0..W].* = @select(
                    f32,
                    ph < splat(0.5),
                    four_p - splat(1.0),
                    splat(3.0) - four_p,
                );
            }
            while (i < len) : (i += 1) {
                out[i] = if (p < 0.5) 4.0 * p - 1.0 else 3.0 - 4.0 * p;
                p = advance(p, inc);
            }
        },
        // --- 3 (and anything else): PolyBLEP square, two BLEPs half a cycle
        // apart. Scalar for the same reason as the saw.
        else => {
            var i: usize = 0;
            while (i < len) : (i += 1) {
                var v: f32 = if (p < 0.5) 1.0 else -1.0;
                v += polyblep(p, inc);
                const p2 = if (p + 0.5 >= 1.0) p - 0.5 else p + 0.5;
                v -= polyblep(p2, inc);
                out[i] = v;
                p = advance(p, inc);
            }
        },
    }

    phase.* = p;
}

/// In-place trapezoidal SVF low-pass over `n` samples. `state` points to two
/// floats [ic1eq, ic2eq] that persist across blocks. Serial recurrence, scalar.
pub export fn gsyn_svf_lp_block(io: [*]f32, n: u32, state: *[2]f32, g: f32, k: f32) callconv(.c) void {
    const len: usize = n;
    const a1 = 1.0 / (1.0 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    var ic1 = state[0];
    var ic2 = state[1];

    var i: usize = 0;
    while (i < len) : (i += 1) {
        const v0 = io[i];
        const v3 = v0 - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2.0 * v1 - ic1;
        ic2 = 2.0 * v2 - ic2;
        io[i] = v2;
    }

    state[0] = ic1;
    state[1] = ic2;
}

/// dst[i] += src[i] * gain
pub export fn gsyn_mix_add(dst: [*]f32, src: [*]const f32, gain: f32, n: u32) callconv(.c) void {
    const len: usize = n;
    const gv = splat(gain);

    var i: usize = 0;
    while (i + W <= len) : (i += W) {
        const d: V = dst[i..][0..W].*;
        const s: V = src[i..][0..W].*;
        dst[i..][0..W].* = d + s * gv;
    }
    while (i < len) : (i += 1) {
        dst[i] += src[i] * gain;
    }
}

/// dst[i] += src[i] * g_i where g_i ramps linearly from g0 towards g1 across
/// the block: g_i = g0 + i * (g1 - g0) / max(n, 1). Matches the reference
/// within ULP-level accumulation error (the reference adds `step` once per
/// sample; we add `W*step` once per vector and continue serially in the tail).
pub export fn gsyn_mix_add_ramp(dst: [*]f32, src: [*]const f32, g0: f32, g1: f32, n: u32) callconv(.c) void {
    const len: usize = n;
    const nf: f32 = @floatFromInt(@max(n, 1));
    const step = (g1 - g0) / nf;

    // Per-lane gains for the first vector, then a stride of W*step per vector.
    var gv = splat(g0) + lane_index * splat(step);
    const gstep = splat(step * @as(f32, W));

    var i: usize = 0;
    while (i + W <= len) : (i += W) {
        const d: V = dst[i..][0..W].*;
        const s: V = src[i..][0..W].*;
        dst[i..][0..W].* = d + s * gv;
        gv += gstep;
    }
    // Lane 0 of the (already advanced) gain vector is the gain for sample i.
    var g: f32 = gv[0];
    while (i < len) : (i += 1) {
        dst[i] += src[i] * g;
        g += step;
    }
}

/// In-place soft clipper: y = tanh(x * drive) / tanh(drive), unity at |x| = 1.
/// `drive` is floored at 1e-3 so the normalisation never divides by zero.
pub export fn gsyn_softclip_block(io: [*]f32, n: u32, drive_in: f32) callconv(.c) void {
    const len: usize = n;
    const drive = @max(drive_in, 1e-3);
    const norm = 1.0 / tanhApprox(drive);
    const dv = splat(drive);
    const nv = splat(norm);

    var i: usize = 0;
    while (i + W <= len) : (i += W) {
        const x: V = io[i..][0..W].*;
        io[i..][0..W].* = tanhApproxV(x * dv) * nv;
    }
    while (i < len) : (i += 1) {
        io[i] = tanhApprox(io[i] * drive) * norm;
    }
}
