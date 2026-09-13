//! DSP hot-path kernel.
//!
//! Two implementations with identical semantics:
//! * `zig` feature ON  -> the Zig SIMD kernel in crates/gsyn-zig (C ABI, linked statically).
//! * `zig` feature OFF -> the pure-Rust reference implementation in this file.
//!
//! Every function is block-based, allocation free, and takes coefficients that
//! the caller already computed for the block. The tests in this module define
//! the contract; the Zig kernel must match the reference within 1e-4.
//!
//! Waveforms
//!   0 = saw (PolyBLEP anti-aliased, rising, range -1..1)
//!   1 = sine (polynomial approximation, same polynomial in both kernels)
//!   2 = triangle (naive)
//!   3 = square (PolyBLEP, 50% duty)
//!
//! Filter: Cytomic (Andrew Simper) trapezoidal state-variable low-pass.
//!   g = tan(pi * fc / fs), k = 2 - 2*res  (res in 0..1), state = [ic1eq, ic2eq]

pub const WAVE_SAW: u32 = 0;
pub const WAVE_SINE: u32 = 1;
pub const WAVE_TRI: u32 = 2;
pub const WAVE_SQUARE: u32 = 3;

#[cfg(feature = "zig")]
mod ffi {
    extern "C" {
        pub fn gsyn_kernel_version() -> u32;
        pub fn gsyn_osc_block(out: *mut f32, n: u32, phase: *mut f32, inc: f32, wave: u32);
        pub fn gsyn_svf_lp_block(io: *mut f32, n: u32, state: *mut f32, g: f32, k: f32);
        pub fn gsyn_mix_add(dst: *mut f32, src: *const f32, gain: f32, n: u32);
        pub fn gsyn_mix_add_ramp(dst: *mut f32, src: *const f32, g0: f32, g1: f32, n: u32);
        pub fn gsyn_softclip_block(io: *mut f32, n: u32, drive: f32);
    }
}

/// Kernel contract version (1 = this file). The Zig kernel reports its own.
pub fn kernel_version() -> u32 {
    #[cfg(feature = "zig")]
    unsafe {
        ffi::gsyn_kernel_version()
    }
    #[cfg(not(feature = "zig"))]
    1
}

pub fn kernel_name() -> &'static str {
    if cfg!(feature = "zig") {
        "zig"
    } else {
        "rust"
    }
}

/// Render `out.len()` samples of waveform `wave`, advancing `phase` (0..1) by `inc` per sample.
#[inline]
pub fn osc_block(out: &mut [f32], phase: &mut f32, inc: f32, wave: u32) {
    #[cfg(feature = "zig")]
    unsafe {
        ffi::gsyn_osc_block(out.as_mut_ptr(), out.len() as u32, phase, inc, wave);
    }
    #[cfg(not(feature = "zig"))]
    reference::osc_block(out, phase, inc, wave);
}

/// In-place trapezoidal SVF low-pass. `state` = [ic1eq, ic2eq].
#[inline]
pub fn svf_lp_block(io: &mut [f32], state: &mut [f32; 2], g: f32, k: f32) {
    #[cfg(feature = "zig")]
    unsafe {
        ffi::gsyn_svf_lp_block(io.as_mut_ptr(), io.len() as u32, state.as_mut_ptr(), g, k);
    }
    #[cfg(not(feature = "zig"))]
    reference::svf_lp_block(io, state, g, k);
}

/// dst[i] += src[i] * gain
#[inline]
pub fn mix_add(dst: &mut [f32], src: &[f32], gain: f32) {
    debug_assert_eq!(dst.len(), src.len());
    #[cfg(feature = "zig")]
    unsafe {
        ffi::gsyn_mix_add(dst.as_mut_ptr(), src.as_ptr(), gain, dst.len() as u32);
    }
    #[cfg(not(feature = "zig"))]
    reference::mix_add(dst, src, gain);
}

/// dst[i] += src[i] * (g0 + (g1 - g0) * i / n)   (linear gain ramp across the block)
#[inline]
pub fn mix_add_ramp(dst: &mut [f32], src: &[f32], g0: f32, g1: f32) {
    debug_assert_eq!(dst.len(), src.len());
    #[cfg(feature = "zig")]
    unsafe {
        ffi::gsyn_mix_add_ramp(dst.as_mut_ptr(), src.as_ptr(), g0, g1, dst.len() as u32);
    }
    #[cfg(not(feature = "zig"))]
    reference::mix_add_ramp(dst, src, g0, g1);
}

/// In-place soft clipper: y = tanh(x * drive) / tanh(drive)  (unity at |x| = 1).
#[inline]
pub fn softclip_block(io: &mut [f32], drive: f32) {
    #[cfg(feature = "zig")]
    unsafe {
        ffi::gsyn_softclip_block(io.as_mut_ptr(), io.len() as u32, drive);
    }
    #[cfg(not(feature = "zig"))]
    reference::softclip_block(io, drive);
}

/// Pure-Rust reference implementation. Always compiled so tests can compare
/// the Zig kernel against it.
pub mod reference {
    #[inline(always)]
    fn polyblep(t: f32, dt: f32) -> f32 {
        if t < dt {
            let x = t / dt;
            x + x - x * x - 1.0
        } else if t > 1.0 - dt {
            let x = (t - 1.0) / dt;
            x * x + x + x + 1.0
        } else {
            0.0
        }
    }

    /// sin(2*pi*x) for x in 0..1. Parabolic approximation refined once
    /// (max abs error about 1e-3). Same polynomial as the Zig kernel.
    #[inline(always)]
    pub fn fast_sin(x: f32) -> f32 {
        let t = if x >= 0.5 { x - 1.0 } else { x }; // -0.5..0.5
        let y = 16.0 * t * (0.5 - t.abs()); // 0 at 0, +1 at 0.25, 0 at +-0.5, -1 at -0.25
        0.225 * (y * y.abs() - y) + y
    }

    pub fn osc_block(out: &mut [f32], phase: &mut f32, inc: f32, wave: u32) {
        let mut p = *phase;
        let inc = inc.clamp(0.0, 0.5);
        match wave {
            0 => {
                for s in out.iter_mut() {
                    *s = (2.0 * p - 1.0) - polyblep(p, inc);
                    p += inc;
                    if p >= 1.0 {
                        p -= 1.0;
                    }
                }
            }
            1 => {
                for s in out.iter_mut() {
                    *s = fast_sin(p);
                    p += inc;
                    if p >= 1.0 {
                        p -= 1.0;
                    }
                }
            }
            2 => {
                for s in out.iter_mut() {
                    *s = if p < 0.5 {
                        4.0 * p - 1.0
                    } else {
                        3.0 - 4.0 * p
                    };
                    p += inc;
                    if p >= 1.0 {
                        p -= 1.0;
                    }
                }
            }
            _ => {
                for s in out.iter_mut() {
                    let mut v = if p < 0.5 { 1.0 } else { -1.0 };
                    v += polyblep(p, inc);
                    let p2 = if p + 0.5 >= 1.0 { p - 0.5 } else { p + 0.5 };
                    v -= polyblep(p2, inc);
                    *s = v;
                    p += inc;
                    if p >= 1.0 {
                        p -= 1.0;
                    }
                }
            }
        }
        *phase = p;
    }

    pub fn svf_lp_block(io: &mut [f32], state: &mut [f32; 2], g: f32, k: f32) {
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        let mut ic1 = state[0];
        let mut ic2 = state[1];
        for s in io.iter_mut() {
            let v0 = *s;
            let v3 = v0 - ic2;
            let v1 = a1 * ic1 + a2 * v3;
            let v2 = ic2 + a2 * ic1 + a3 * v3;
            ic1 = 2.0 * v1 - ic1;
            ic2 = 2.0 * v2 - ic2;
            *s = v2;
        }
        state[0] = ic1;
        state[1] = ic2;
    }

    pub fn mix_add(dst: &mut [f32], src: &[f32], gain: f32) {
        for (d, s) in dst.iter_mut().zip(src) {
            *d += *s * gain;
        }
    }

    pub fn mix_add_ramp(dst: &mut [f32], src: &[f32], g0: f32, g1: f32) {
        let n = dst.len().max(1) as f32;
        let step = (g1 - g0) / n;
        let mut g = g0;
        for (d, s) in dst.iter_mut().zip(src) {
            *d += *s * g;
            g += step;
        }
    }

    /// Rational tanh approximation, input clamped to +-4.5. Same as the Zig kernel.
    #[inline(always)]
    pub fn tanh_approx(x: f32) -> f32 {
        let x = x.clamp(-4.5, 4.5);
        let x2 = x * x;
        x * (135135.0 + x2 * (17325.0 + x2 * (378.0 + x2)))
            / (135135.0 + x2 * (62370.0 + x2 * (3150.0 + x2 * 28.0)))
    }

    pub fn softclip_block(io: &mut [f32], drive: f32) {
        let drive = drive.max(1e-3);
        let norm = 1.0 / tanh_approx(drive);
        for s in io.iter_mut() {
            *s = tanh_approx(*s * drive) * norm;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saw_is_bounded_and_periodic() {
        let mut out = [0f32; 512];
        let mut ph = 0.0;
        osc_block(&mut out, &mut ph, 1.0 / 64.0, WAVE_SAW);
        assert!(out.iter().all(|v| v.abs() <= 1.05));
        assert!(ph.abs() < 1e-3 || (1.0 - ph).abs() < 1e-3, "phase {ph}");
    }

    #[test]
    fn sine_has_expected_shape() {
        let mut out = [0f32; 64];
        let mut ph = 0.0;
        osc_block(&mut out, &mut ph, 1.0 / 64.0, WAVE_SINE);
        assert!(out[0].abs() < 0.02, "{}", out[0]);
        assert!(out[16] > 0.97 && out[16] < 1.03, "{}", out[16]);
        assert!(out[32].abs() < 0.02, "{}", out[32]);
        assert!(out[48] < -0.97 && out[48] > -1.03, "{}", out[48]);
    }

    #[test]
    fn svf_lowpass_attenuates_high_frequencies() {
        let mut io: Vec<f32> = (0..1024)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let mut st = [0.0, 0.0];
        let g = (core::f32::consts::PI * 200.0 / 48000.0).tan();
        svf_lp_block(&mut io, &mut st, g, 1.5);
        let tail_energy: f32 = io[512..].iter().map(|v| v * v).sum::<f32>() / 512.0;
        assert!(tail_energy < 1e-3, "tail energy {tail_energy}");
        let mut dc = vec![1.0f32; 4096];
        let mut st = [0.0, 0.0];
        svf_lp_block(&mut dc, &mut st, g, 1.5);
        assert!((dc[4095] - 1.0).abs() < 0.02);
    }

    #[test]
    fn mix_and_ramp() {
        let src = [1.0f32; 8];
        let mut dst = [0.0f32; 8];
        mix_add(&mut dst, &src, 0.5);
        assert!(dst.iter().all(|v| (*v - 0.5).abs() < 1e-6));
        let mut dst = [0.0f32; 8];
        mix_add_ramp(&mut dst, &src, 0.0, 1.0);
        assert!(dst[0].abs() < 1e-6);
        assert!(dst[7] > 0.8 && dst[7] < 1.0);
    }

    #[test]
    fn softclip_unity_at_one_and_bounded() {
        let mut io = [1.0f32, -1.0, 0.0, 3.0, -3.0, 0.5];
        softclip_block(&mut io, 1.5);
        assert!((io[0] - 1.0).abs() < 1e-4);
        assert!((io[1] + 1.0).abs() < 1e-4);
        assert!(io[2].abs() < 1e-6);
        assert!(io[3] <= 1.11 && io[4] >= -1.11);
        assert!(io[5] > 0.5 && io[5] < 1.0);
    }
}
