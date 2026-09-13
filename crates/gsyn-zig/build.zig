//! Build script for the Gesture Synth Zig DSP kernel (Zig 0.16).
//!
//!   zig build -Doptimize=ReleaseFast            -> zig-out/lib/gsynkernel.lib (native Windows)
//!                                                  or zig-out/lib/libgsynkernel.a (other hosts)
//!   zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast
//!                                               -> zig-out/lib/libgsynkernel.a (wasm32)
//!   zig build test                              -> unit tests + reference-parity tests (host target)
//!
//! Note: the Rust build.rs in crates/gsyn-core does NOT use this file; it
//! invokes `zig build-lib src/kernel.zig ...` directly. This script exists for
//! stand-alone development, CI, and running the Zig test suites.
const std = @import("std");

pub fn build(b: *std.Build) void {
    // -Dtarget / -Doptimize passthrough. Default is Debug; pass
    // -Doptimize=ReleaseFast (or --release=fast) for the production kernel.
    // (Do not set `preferred_optimize_mode` here: in Zig 0.16 that replaces
    // the -Doptimize option with -Drelease, which build scripts do not expect.)
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // ---- static library ---------------------------------------------------
    const kernel_mod = b.createModule(.{
        .root_source_file = b.path("src/kernel.zig"),
        .target = target,
        .optimize = optimize,
        // Freestanding-friendly: no libc, no stack probes (the Rust build.rs
        // passes -fno-stack-check too), single threaded.
        .link_libc = false,
        .stack_check = false,
        .single_threaded = true,
    });

    const lib = b.addLibrary(.{
        .name = "gsynkernel",
        .linkage = .static,
        .root_module = kernel_mod,
    });
    b.installArtifact(lib);

    // ---- tests --------------------------------------------------------------
    // Tests always build for and run on the host, even when -Dtarget points at
    // wasm32-freestanding, so `zig build test` works in any configuration.
    const host = b.graph.host;
    const kernel_host_mod = b.createModule(.{
        .root_source_file = b.path("src/kernel.zig"),
        .target = host,
        .optimize = optimize,
    });

    const test_step = b.step("test", "Run Zig unit tests and reference-parity tests");
    const test_files = [_][]const u8{
        "test/kernel_test.zig",
        "test/reference_check.zig",
    };
    for (test_files) |path| {
        const t = b.addTest(.{
            .name = std.fs.path.stem(path),
            .root_module = b.createModule(.{
                .root_source_file = b.path(path),
                .target = host,
                .optimize = optimize,
                .imports = &.{
                    .{ .name = "kernel", .module = kernel_host_mod },
                },
            }),
        });
        test_step.dependOn(&b.addRunArtifact(t).step);
    }
}
