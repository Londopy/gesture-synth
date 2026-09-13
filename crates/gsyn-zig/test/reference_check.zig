//! Numerical parity tests: the SIMD kernel in src/kernel.zig versus a straight
//! scalar port of the Rust `reference` module in
//! crates/gsyn-core/src/synth/kernel.rs. Every output must agree within 1e-4.
//!
//! Run with either:
//!   zig build test
//!   zig test --dep kernel -Mroot=test/reference_check.zig -Mkernel=src/kernel.zig
const std = @import("std");
const kernel = @import("kernel");

const expect = std.testing.expect;
const TOL: f32 = 1e-4;

// ---------------------------------------------------------------------------
// Scalar reference: line-for-line port of kernel.rs `mod reference`.
// Deliberately does not share any code with src/kernel.zig.
// ---------------------------------------------------------------------------
const reference = struct {
    fn polyblep(t: f32, dt: f32) f32 {
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

    fn fast_sin(x: f32) f32 {
        const t = if (x >= 0.5) x - 1.0 else x;
        const y = 16.0 * t * (0.5 - @abs(t));
        return 0.225 * (y * @abs(y) - y) + y;
    }

    fn osc_block(out: []f32, phase: *f32, inc_in: f32, wave: u32) void {
        var p = phase.*;
        const inc = std.math.clamp(inc_in, 0.0, 0.5);
        switch (wave) {
            0 => for (out) |*s| {
                s.* = (2.0 * p - 1.0) - polyblep(p, inc);
                p += inc;
                if (p >= 1.0) p -= 1.0;
            },
            1 => for (out) |*s| {
                s.* = fast_sin(p);
                p += inc;
                if (p >= 1.0) p -= 1.0;
            },
            2 => for (out) |*s| {
                s.* = if (p < 0.5) 4.0 * p - 1.0 else 3.0 - 4.0 * p;
                p += inc;
                if (p >= 1.0) p -= 1.0;
            },
            else => for (out) |*s| {
                var v: f32 = if (p < 0.5) 1.0 else -1.0;
                v += polyblep(p, inc);
                const p2 = if (p + 0.5 >= 1.0) p - 0.5 else p + 0.5;
                v -= polyblep(p2, inc);
                s.* = v;
                p += inc;
                if (p >= 1.0) p -= 1.0;
            },
        }
        phase.* = p;
    }

    fn svf_lp_block(io: []f32, state: *[2]f32, g: f32, k: f32) void {
        const a1 = 1.0 / (1.0 + g * (g + k));
        const a2 = g * a1;
        const a3 = g * a2;
        var ic1 = state[0];
        var ic2 = state[1];
        for (io) |*s| {
            const v0 = s.*;
            const v3 = v0 - ic2;
            const v1 = a1 * ic1 + a2 * v3;
            const v2 = ic2 + a2 * ic1 + a3 * v3;
            ic1 = 2.0 * v1 - ic1;
            ic2 = 2.0 * v2 - ic2;
            s.* = v2;
        }
        state[0] = ic1;
        state[1] = ic2;
    }

    fn mix_add(dst: []f32, src: []const f32, gain: f32) void {
        for (dst, src) |*d, s| d.* += s * gain;
    }

    fn mix_add_ramp(dst: []f32, src: []const f32, g0: f32, g1: f32) void {
        const n: f32 = @floatFromInt(@max(dst.len, 1));
        const step = (g1 - g0) / n;
        var g = g0;
        for (dst, src) |*d, s| {
            d.* += s * g;
            g += step;
        }
    }

    fn tanh_approx(x_in: f32) f32 {
        const x = std.math.clamp(x_in, -4.5, 4.5);
        const x2 = x * x;
        return x * (135135.0 + x2 * (17325.0 + x2 * (378.0 + x2))) /
            (135135.0 + x2 * (62370.0 + x2 * (3150.0 + x2 * 28.0)));
    }

    fn softclip_block(io: []f32, drive_in: f32) void {
        const drive = @max(drive_in, 1e-3);
        const norm = 1.0 / tanh_approx(drive);
        for (io) |*s| s.* = tanh_approx(s.* * drive) * norm;
    }
};

// ---------------------------------------------------------------------------
// Deterministic pseudo-random source (xorshift32), independent of std.Random
// so the test vectors are stable across Zig releases.
// ---------------------------------------------------------------------------
const Rng = struct {
    s: u32,

    fn next(self: *Rng) u32 {
        var x = self.s;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.s = x;
        return x;
    }

    /// Uniform in [0, 1).
    fn unit(self: *Rng) f32 {
        return @as(f32, @floatFromInt(self.next() >> 8)) * (1.0 / 16777216.0);
    }

    /// Uniform in [lo, hi).
    fn range(self: *Rng, lo: f32, hi: f32) f32 {
        return lo + (hi - lo) * self.unit();
    }

    fn fill(self: *Rng, buf: []f32, lo: f32, hi: f32) void {
        for (buf) |*v| v.* = self.range(lo, hi);
    }
};

fn maxAbsDiff(a: []const f32, b: []const f32) f32 {
    var m: f32 = 0.0;
    for (a, b) |x, y| m = @max(m, @abs(x - y));
    return m;
}

fn expectClose(a: []const f32, b: []const f32, what: []const u8) !void {
    const d = maxAbsDiff(a, b);
    if (d > TOL) {
        std.debug.print("\n{s}: max abs diff {e} exceeds {e}\n", .{ what, d, TOL });
        return error.ParityMismatch;
    }
}

// Block length deliberately not a multiple of 8 so every SIMD kernel also
// exercises its scalar tail loop.
const N = 1003;

test "osc_block matches reference for all waves and several increments" {
    const incs = [_]f32{
        1.0 / 64.0, // exact binary fraction
        0.01, // inexact, drifts
        0.0023, // low frequency
        0.1234567,
        0.37,
        0.5, // Nyquist
        0.75, // clamped to 0.5
        -0.1, // clamped to 0
    };
    var rng = Rng{ .s = 0xC0FFEE01 };
    for (0..4) |wave_usize| {
        const wave: u32 = @intCast(wave_usize);
        for (incs) |inc| {
            // A few random starting phases per (wave, inc), including 0.
            for (0..4) |trial| {
                const p0: f32 = if (trial == 0) 0.0 else rng.unit();
                var ref_out: [N]f32 = undefined;
                var zig_out: [N]f32 = undefined;
                var ref_ph = p0;
                var zig_ph = p0;
                reference.osc_block(&ref_out, &ref_ph, inc, wave);
                kernel.gsyn_osc_block(&zig_out, N, &zig_ph, inc, wave);
                try expectClose(&ref_out, &zig_out, "osc output");
                if (@abs(ref_ph - zig_ph) > TOL) {
                    std.debug.print("\nosc phase wave={d} inc={e}: ref {e} zig {e}\n", .{ wave, inc, ref_ph, zig_ph });
                    return error.ParityMismatch;
                }
            }
        }
    }
}

test "osc_block: sine and triangle returned phase is bit-identical to reference" {
    // Stronger than 1e-4: the phase accumulator is advanced serially in both
    // implementations, so it must agree exactly.
    var rng = Rng{ .s = 0x12345678 };
    for ([_]u32{ 1, 2 }) |wave| {
        for (0..16) |_| {
            const inc = rng.range(0.0, 0.5);
            const p0 = rng.unit();
            var ref_out: [N]f32 = undefined;
            var zig_out: [N]f32 = undefined;
            var ref_ph = p0;
            var zig_ph = p0;
            reference.osc_block(&ref_out, &ref_ph, inc, wave);
            kernel.gsyn_osc_block(&zig_out, N, &zig_ph, inc, wave);
            try expect(ref_ph == zig_ph);
            try expectClose(&ref_out, &zig_out, "osc output");
        }
    }
}

test "svf_lp_block matches reference on random input with random coefficients" {
    var rng = Rng{ .s = 0x5EEDF00D };
    const gs = [_]f32{ 0.001, 0.013, 0.1, 0.5, 1.0, 3.0 };
    const ks = [_]f32{ 0.05, 0.5, 1.0, 1.5, 2.0 };
    for (gs) |g| {
        for (ks) |k| {
            var ref_io: [N]f32 = undefined;
            rng.fill(&ref_io, -1.0, 1.0);
            var zig_io = ref_io;
            var ref_st = [2]f32{ rng.range(-0.5, 0.5), rng.range(-0.5, 0.5) };
            var zig_st = ref_st;
            reference.svf_lp_block(&ref_io, &ref_st, g, k);
            kernel.gsyn_svf_lp_block(&zig_io, N, &zig_st, g, k);
            try expectClose(&ref_io, &zig_io, "svf output");
            try expectClose(&ref_st, &zig_st, "svf state");
        }
    }
}

test "mix_add matches reference" {
    var rng = Rng{ .s = 0xA5A5A5A5 };
    for (0..12) |_| {
        var src: [N]f32 = undefined;
        var ref_dst: [N]f32 = undefined;
        rng.fill(&src, -2.0, 2.0);
        rng.fill(&ref_dst, -2.0, 2.0);
        var zig_dst = ref_dst;
        const gain = rng.range(-3.0, 3.0);
        reference.mix_add(&ref_dst, &src, gain);
        kernel.gsyn_mix_add(&zig_dst, &src, gain, N);
        try expectClose(&ref_dst, &zig_dst, "mix_add");
    }
}

test "mix_add_ramp matches reference" {
    var rng = Rng{ .s = 0x0BADBEEF };
    const lens = [_]u32{ 1, 7, 8, 9, 64, 255, 256, N };
    for (lens) |len| {
        for (0..6) |_| {
            var src: [N]f32 = undefined;
            var ref_dst: [N]f32 = undefined;
            rng.fill(&src, -1.0, 1.0);
            rng.fill(&ref_dst, -1.0, 1.0);
            var zig_dst = ref_dst;
            const g0 = rng.range(-2.0, 2.0);
            const g1 = rng.range(-2.0, 2.0);
            reference.mix_add_ramp(ref_dst[0..len], src[0..len], g0, g1);
            kernel.gsyn_mix_add_ramp(&zig_dst, &src, g0, g1, len);
            try expectClose(ref_dst[0..len], zig_dst[0..len], "mix_add_ramp");
            // Samples past `len` must be untouched.
            try expect(std.mem.eql(f32, ref_dst[len..], zig_dst[len..]));
        }
    }
    // Degenerate: n = 0 must be a no-op for both.
    var a = [_]f32{ 1.0, 2.0 };
    var b = a;
    reference.mix_add_ramp(a[0..0], a[0..0], 0.0, 1.0);
    kernel.gsyn_mix_add_ramp(&b, &b, 0.0, 1.0, 0);
    try expect(std.mem.eql(f32, &a, &b));
}

test "softclip_block matches reference" {
    var rng = Rng{ .s = 0x7E57C11F };
    const drives = [_]f32{ 0.0, 1e-3, 0.25, 1.0, 1.5, 3.0, 10.0, 100.0 };
    for (drives) |drive| {
        var ref_io: [N]f32 = undefined;
        rng.fill(&ref_io, -3.0, 3.0);
        var zig_io = ref_io;
        reference.softclip_block(&ref_io, drive);
        kernel.gsyn_softclip_block(&zig_io, N, drive);
        try expectClose(&ref_io, &zig_io, "softclip");
    }
}

test "scalar helpers in kernel agree with reference helpers exactly" {
    var rng = Rng{ .s = 0x31415926 };
    for (0..4096) |_| {
        const x = rng.range(-6.0, 6.0);
        try expect(kernel.tanhApprox(x) == reference.tanh_approx(x));
        const ph = rng.unit();
        try expect(kernel.fastSin(ph) == reference.fast_sin(ph));
        const dt = rng.range(0.0, 0.5);
        try expect(kernel.polyblep(ph, dt) == reference.polyblep(ph, dt));
    }
}
