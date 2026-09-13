//! When the `zig` feature is on, compile crates/gsyn-zig/src/kernel.zig into a
//! static library for the current target and link it. Otherwise do nothing: the
//! pure-Rust reference kernel in src/synth/kernel.rs is used.
use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../gsyn-zig/src/kernel.zig");
    println!("cargo:rerun-if-env-changed=GSYN_ZIG");
    if env::var("CARGO_FEATURE_ZIG").is_err() {
        return;
    }
    let target = env::var("TARGET").unwrap();
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let zig = env::var("GSYN_ZIG").unwrap_or_else(|_| "zig".into());
    let zig_target = match target.as_str() {
        "wasm32-unknown-unknown" => "wasm32-freestanding",
        "x86_64-pc-windows-msvc" => "x86_64-windows-msvc",
        "x86_64-pc-windows-gnu" => "x86_64-windows-gnu",
        "x86_64-unknown-linux-gnu" => "x86_64-linux-gnu",
        "aarch64-unknown-linux-gnu" => "aarch64-linux-gnu",
        "x86_64-apple-darwin" => "x86_64-macos",
        "aarch64-apple-darwin" => "aarch64-macos",
        other => panic!("gsyn-zig: no zig target mapping for {other}"),
    };
    let src = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../gsyn-zig/src/kernel.zig");
    let lib_path = out.join(lib_name(&target));
    let mut cmd = Command::new(&zig);
    cmd.arg("build-lib")
        .arg(&src)
        .arg("-OReleaseFast")
        .arg("-fno-stack-check")
        .arg("--name")
        .arg("gsynkernel")
        .arg("-target")
        .arg(zig_target)
        .arg(format!("-femit-bin={}", lib_path.display()));
    let status = cmd.status().unwrap_or_else(|e| panic!("failed to run {zig}: {e}"));
    assert!(status.success(), "zig build-lib failed for {zig_target}");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=gsynkernel");
}

fn lib_name(target: &str) -> &'static str {
    if target.contains("windows-msvc") {
        "gsynkernel.lib"
    } else {
        "libgsynkernel.a"
    }
}
