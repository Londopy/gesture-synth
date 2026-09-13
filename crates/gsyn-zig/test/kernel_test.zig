//! Basic invariant tests for the Zig DSP kernel (mirrors the Rust unit tests
//! in crates/gsyn-core/src/synth/kernel.rs).
//!
//! Run with either:
//!   zig build test
//!   zig test --dep kernel -Mroot=test/kernel_test.zig -Mkernel=src/kernel.zig
//! (`zig test test/kernel_test.zig` alone cannot work: Zig forbids importing
//! files outside the root module's directory, so the kernel is supplied as a
//! named module "kernel".)
const std = @import("std");
const kernel = @import("kernel");

const expect = std.testing.expect;

test "kernel version is 1" {
    try expect(kernel.gsyn_kernel_version() == 1);
    try expect(kernel.KERNEL_VERSION == 1);
}

test "saw is bounded in [-1.05, 1.05] and returns phase to a cycle boundary" {
    var out: [512]f32 = undefined;
    var ph: f32 = 0.0;
    kernel.gsyn_osc_block(&out, out.len, &ph, 1.0 / 64.0, 0);
    for (out) |v| try expect(@abs(v) <= 1.05);
    // 512 samples at 1/64 per sample = exactly 8 cycles.
    try expect(@abs(ph) < 1e-3 or @abs(1.0 - ph) < 1e-3);
    // Must actually look like a saw: rising through the cycle, big drop at wrap.
    // (Sample 0 sits exactly on the discontinuity, which PolyBLEP lifts to the
    // midpoint 0.0, so compare samples strictly inside the ramp.)
    try expect(@abs(out[0]) < 1e-6);
    try expect(out[3] > out[2] and out[2] > out[1]);
    try expect(out[62] > 0.8);
    try expect(out[64] < -0.8 or out[65] < -0.8);
}

test "sine has the expected shape at quarter points" {
    var out: [64]f32 = undefined;
    var ph: f32 = 0.0;
    kernel.gsyn_osc_block(&out, out.len, &ph, 1.0 / 64.0, 1);
    try expect(@abs(out[0]) < 0.02);
    try expect(out[16] > 0.97 and out[16] < 1.03);
    try expect(@abs(out[32]) < 0.02);
    try expect(out[48] < -0.97 and out[48] > -1.03);
    for (out) |v| try expect(@abs(v) <= 1.01);
}

test "sine tail path (n not a multiple of the SIMD width) is continuous with the vector path" {
    // Render 13 samples in one call and in two calls (8 + 5); must be identical.
    var a: [13]f32 = undefined;
    var pa: f32 = 0.1;
    kernel.gsyn_osc_block(&a, a.len, &pa, 0.0137, 1);

    var b0: [8]f32 = undefined;
    var b1: [5]f32 = undefined;
    var pb: f32 = 0.1;
    kernel.gsyn_osc_block(&b0, b0.len, &pb, 0.0137, 1);
    kernel.gsyn_osc_block(&b1, b1.len, &pb, 0.0137, 1);

    for (0..8) |i| try expect(a[i] == b0[i]);
    for (0..5) |i| try expect(a[8 + i] == b1[i]);
    try expect(pa == pb);
}

test "triangle is bounded and peaks at the half cycle" {
    var out: [64]f32 = undefined;
    var ph: f32 = 0.0;
    kernel.gsyn_osc_block(&out, out.len, &ph, 1.0 / 64.0, 2);
    try expect(@abs(out[0] + 1.0) < 1e-5); // 4*0 - 1
    try expect(@abs(out[32] - 1.0) < 1e-5); // 3 - 4*0.5
    for (out) |v| try expect(@abs(v) <= 1.0 + 1e-6);
}

test "square is bounded and flips sign at the half cycle" {
    var out: [64]f32 = undefined;
    var ph: f32 = 0.0;
    kernel.gsyn_osc_block(&out, out.len, &ph, 1.0 / 64.0, 3);
    for (out) |v| try expect(@abs(v) <= 1.05);
    try expect(out[8] > 0.9);
    try expect(out[40] < -0.9);
}

test "inc is clamped to Nyquist" {
    var out: [16]f32 = undefined;
    var ph: f32 = 0.0;
    kernel.gsyn_osc_block(&out, out.len, &ph, 3.0, 1); // clamps to 0.5
    // 16 * 0.5 = 8 full cycles -> back at 0.
    try expect(@abs(ph) < 1e-6);
    var ph2: f32 = 0.25;
    kernel.gsyn_osc_block(&out, out.len, &ph2, -1.0, 1); // clamps to 0
    try expect(ph2 == 0.25);
    for (out) |v| try expect(@abs(v - out[0]) < 1e-6);
}

test "SVF low-pass passes DC and crushes Nyquist" {
    const g: f32 = @floatCast(std.math.tan(std.math.pi * 200.0 / 48000.0));
    const k: f32 = 1.5;

    // Nyquist: alternating +1/-1.
    var io: [1024]f32 = undefined;
    for (&io, 0..) |*v, i| v.* = if (i % 2 == 0) 1.0 else -1.0;
    var st = [2]f32{ 0.0, 0.0 };
    kernel.gsyn_svf_lp_block(&io, io.len, &st, g, k);
    var e: f32 = 0.0;
    for (io[512..]) |v| e += v * v;
    e /= 512.0;
    try expect(e < 1e-3);

    // DC: constant 1.0 settles to 1.0.
    var dc: [4096]f32 = undefined;
    for (&dc) |*v| v.* = 1.0;
    var st2 = [2]f32{ 0.0, 0.0 };
    kernel.gsyn_svf_lp_block(&dc, dc.len, &st2, g, k);
    try expect(@abs(dc[4095] - 1.0) < 0.02);
}

test "SVF state carries across blocks" {
    const g: f32 = 0.05;
    const k: f32 = 1.0;
    var whole: [256]f32 = undefined;
    for (&whole, 0..) |*v, i| v.* = if (i < 128) 1.0 else 0.0;
    var split = whole;
    var s_whole = [2]f32{ 0.0, 0.0 };
    var s_split = [2]f32{ 0.0, 0.0 };
    kernel.gsyn_svf_lp_block(&whole, whole.len, &s_whole, g, k);
    kernel.gsyn_svf_lp_block(&split, 100, &s_split, g, k);
    kernel.gsyn_svf_lp_block(split[100..].ptr, 156, &s_split, g, k);
    for (whole, split) |a, b| try expect(a == b);
    try expect(s_whole[0] == s_split[0] and s_whole[1] == s_split[1]);
}

test "mix_add and mix_add_ramp" {
    const src = [_]f32{1.0} ** 8;
    var dst = [_]f32{0.0} ** 8;
    kernel.gsyn_mix_add(&dst, &src, 0.5, 8);
    for (dst) |v| try expect(@abs(v - 0.5) < 1e-6);

    var dst2 = [_]f32{0.0} ** 8;
    kernel.gsyn_mix_add_ramp(&dst2, &src, 0.0, 1.0, 8);
    try expect(@abs(dst2[0]) < 1e-6);
    try expect(dst2[7] > 0.8 and dst2[7] < 1.0);
    for (1..8) |i| try expect(dst2[i] > dst2[i - 1]);

    // Odd length exercises the scalar tail.
    const src3 = [_]f32{2.0} ** 11;
    var dst3 = [_]f32{1.0} ** 11;
    kernel.gsyn_mix_add(&dst3, &src3, 0.25, 11);
    for (dst3) |v| try expect(@abs(v - 1.5) < 1e-6);

    // n = 0 is a no-op and must not touch memory.
    var dst4 = [_]f32{7.0} ** 4;
    kernel.gsyn_mix_add(&dst4, &src, 100.0, 0);
    kernel.gsyn_mix_add_ramp(&dst4, &src, 100.0, 200.0, 0);
    for (dst4) |v| try expect(v == 7.0);
}

test "softclip is unity at 1.0 and bounded" {
    var io = [_]f32{ 1.0, -1.0, 0.0, 3.0, -3.0, 0.5 };
    kernel.gsyn_softclip_block(&io, io.len, 1.5);
    try expect(@abs(io[0] - 1.0) < 1e-4);
    try expect(@abs(io[1] + 1.0) < 1e-4);
    try expect(@abs(io[2]) < 1e-6);
    // Hard ceiling is 1/tanh(drive): tanh(4.5)/tanh(1.5) = 1.1046 for these
    // inputs (so a naive "<= 1.1" bound is slightly too tight for drive 1.5).
    const ceiling = 1.0 / kernel.tanhApprox(1.5);
    try expect(io[3] > 1.0 and io[3] <= ceiling + 1e-6);
    try expect(io[4] < -1.0 and io[4] >= -ceiling - 1e-6);
    try expect(io[5] > 0.5 and io[5] < 1.0);

    // SIMD path (n >= 8) gives the same unity result.
    var wide = [_]f32{1.0} ** 16;
    kernel.gsyn_softclip_block(&wide, wide.len, 2.0);
    for (wide) |v| try expect(@abs(v - 1.0) < 1e-4);

    // Monotonic and odd-symmetric.
    try expect(kernel.tanhApprox(0.5) > 0.0);
    try expect(kernel.tanhApprox(-0.5) == -kernel.tanhApprox(0.5));
    try expect(kernel.tanhApprox(10.0) == kernel.tanhApprox(4.5));
}

test "scalar helpers match closed forms" {
    try expect(@abs(kernel.fastSin(0.0)) < 1e-6);
    try expect(@abs(kernel.fastSin(0.25) - 1.0) < 1e-6);
    try expect(@abs(kernel.fastSin(0.75) + 1.0) < 1e-6);
    try expect(kernel.polyblep(0.5, 0.01) == 0.0);
    // tanh(1) = 0.76159...
    try expect(@abs(kernel.tanhApprox(1.0) - 0.7615942) < 1e-5);
}
