//! Continuous parameter curves for loop tracks (spec 7, record flow step 4).
//!
//! While recording, continuous params are sampled at 100 Hz into a raw buffer.
//! On loop end they are simplified with Ramer-Douglas-Peucker so filter
//! sweeps and crescendos survive with very few points. Playback evaluates the
//! polyline by linear interpolation and loops.

use serde::{Deserialize, Serialize};

/// Sampling rate used while recording curves.
pub const CURVE_HZ: f32 = 100.0;

/// One curve point: time in samples from loop start, value.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct CurvePoint {
    pub t: u64,
    pub v: f32,
}

#[derive(Clone, PartialEq, Debug, Default, Serialize, Deserialize)]
pub struct Curve {
    pub points: Vec<CurvePoint>,
}

impl Curve {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    pub fn push(&mut self, t: u64, v: f32) {
        // keep time monotonic
        if let Some(last) = self.points.last() {
            if t <= last.t {
                if let Some(l) = self.points.last_mut() {
                    l.v = v;
                }
                return;
            }
        }
        self.points.push(CurvePoint { t, v });
    }

    /// Linear interpolation with wrap-around at `loop_len`.
    pub fn value_at(&self, t: u64, loop_len: u64, default: f32) -> f32 {
        let n = self.points.len();
        if n == 0 {
            return default;
        }
        if n == 1 {
            return self.points[0].v;
        }
        let t = if loop_len > 0 { t % loop_len } else { t };
        // binary search for the segment
        let idx = self.points.partition_point(|p| p.t <= t);
        if idx == 0 {
            // before first point: interpolate from last point (wrapped) to first
            let last = self.points[n - 1];
            let first = self.points[0];
            let span = (first.t + loop_len.saturating_sub(last.t)) as f32;
            if span <= 0.0 {
                return first.v;
            }
            let dt = (t + loop_len.saturating_sub(last.t)) as f32;
            return last.v + (first.v - last.v) * (dt / span).clamp(0.0, 1.0);
        }
        if idx >= n {
            let last = self.points[n - 1];
            let first = self.points[0];
            let span = (first.t + loop_len.saturating_sub(last.t)) as f32;
            if span <= 0.0 || loop_len == 0 {
                return last.v;
            }
            let dt = (t - last.t) as f32;
            return last.v + (first.v - last.v) * (dt / span).clamp(0.0, 1.0);
        }
        let a = self.points[idx - 1];
        let b = self.points[idx];
        let span = (b.t - a.t) as f32;
        if span <= 0.0 {
            return b.v;
        }
        a.v + (b.v - a.v) * ((t - a.t) as f32 / span)
    }

    /// Ramer-Douglas-Peucker simplification with tolerance `eps` in value units.
    /// Time is normalized to value-scale so the distance metric is meaningful.
    pub fn simplify(&mut self, eps: f32) {
        let n = self.points.len();
        if n < 3 {
            return;
        }
        let t0 = self.points[0].t as f64;
        let t1 = self.points[n - 1].t as f64;
        let tscale = if t1 > t0 { 1.0 / (t1 - t0) } else { 1.0 };
        let pts: Vec<(f64, f64)> = self.points.iter().map(|p| ((p.t as f64 - t0) * tscale, p.v as f64)).collect();
        let mut keep = vec![false; n];
        keep[0] = true;
        keep[n - 1] = true;
        rdp(&pts, 0, n - 1, eps as f64, &mut keep);
        let mut out = Vec::with_capacity(keep.iter().filter(|k| **k).count());
        for (i, p) in self.points.iter().enumerate() {
            if keep[i] {
                out.push(*p);
            }
        }
        self.points = out;
    }

    /// Drop points at or after `loop_len` (used when a recording overruns).
    pub fn truncate_to(&mut self, loop_len: u64) {
        self.points.retain(|p| p.t < loop_len);
    }

    /// Merge another curve's points (overdub): later recording replaces the value
    /// in the time range it covers.
    pub fn overdub(&mut self, other: &Curve) {
        if other.points.is_empty() {
            return;
        }
        let (a, b) = (other.points[0].t, other.points[other.points.len() - 1].t);
        self.points.retain(|p| p.t < a || p.t > b);
        self.points.extend_from_slice(&other.points);
        self.points.sort_by_key(|p| p.t);
    }
}

fn rdp(pts: &[(f64, f64)], start: usize, end: usize, eps: f64, keep: &mut [bool]) {
    // iterative stack to avoid deep recursion on long recordings
    let mut stack = vec![(start, end)];
    while let Some((s, e)) = stack.pop() {
        if e <= s + 1 {
            continue;
        }
        let (ax, ay) = pts[s];
        let (bx, by) = pts[e];
        let dx = bx - ax;
        let dy = by - ay;
        let seg_len = (dx * dx + dy * dy).sqrt();
        let mut max_d = 0.0;
        let mut max_i = s;
        for i in s + 1..e {
            let (px, py) = pts[i];
            let d = if seg_len < 1e-12 {
                ((px - ax).powi(2) + (py - ay).powi(2)).sqrt()
            } else {
                ((dx * (ay - py) - (ax - px) * dy).abs()) / seg_len
            };
            if d > max_d {
                max_d = d;
                max_i = i;
            }
        }
        if max_d > eps {
            keep[max_i] = true;
            stack.push((s, max_i));
            stack.push((max_i, e));
        }
    }
}

/// Records a parameter at a fixed rate while the loop runs.
#[derive(Clone, Debug, Default)]
pub struct CurveRecorder {
    pub curve: Curve,
    next_t: u64,
    interval: u64,
}

impl CurveRecorder {
    pub fn new(sample_rate: f32) -> Self {
        Self { curve: Curve::new(), next_t: 0, interval: (sample_rate / CURVE_HZ).max(1.0) as u64 }
    }

    pub fn reset(&mut self) {
        self.curve = Curve::new();
        self.next_t = 0;
    }

    /// Offer a sample at loop position `t`; stored only when the 100 Hz interval elapsed.
    #[inline]
    pub fn offer(&mut self, t: u64, v: f32) {
        if t >= self.next_t {
            self.curve.push(t, v);
            self.next_t = t + self.interval;
        }
    }

    /// Finish: simplify and hand back the curve.
    pub fn finish(&mut self, eps: f32) -> Curve {
        let mut c = core::mem::take(&mut self.curve);
        c.simplify(eps);
        self.next_t = 0;
        c
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolates_and_wraps() {
        let mut c = Curve::new();
        c.push(0, 0.0);
        c.push(1000, 1.0);
        assert!((c.value_at(500, 2000, 0.0) - 0.5).abs() < 1e-6);
        // after last point, ramps back toward first point at wrap
        assert!((c.value_at(1500, 2000, 0.0) - 0.5).abs() < 1e-6);
        assert_eq!(c.value_at(0, 2000, 0.0), 0.0);
    }

    #[test]
    fn rdp_keeps_corners_drops_line() {
        let mut c = Curve::new();
        for i in 0..=100u64 {
            c.push(i * 10, i as f32 / 100.0); // straight ramp
        }
        c.simplify(0.01);
        assert_eq!(c.points.len(), 2);
        let mut c = Curve::new();
        for i in 0..=100u64 {
            let v = if i < 50 { i as f32 / 50.0 } else { 1.0 - (i - 50) as f32 / 50.0 };
            c.push(i * 10, v);
        }
        c.simplify(0.01);
        assert_eq!(c.points.len(), 3);
        assert_eq!(c.points[1].t, 500);
    }

    #[test]
    fn recorder_rate() {
        let mut r = CurveRecorder::new(48_000.0);
        for t in (0..48_000u64).step_by(128) {
            r.offer(t, (t as f32 / 48_000.0).sin());
        }
        let c = r.finish(0.001);
        assert!(c.points.len() <= 101);
        assert!(c.points.len() >= 2);
    }

    #[test]
    fn overdub_replaces_range() {
        let mut a = Curve::new();
        a.push(0, 0.0);
        a.push(100, 0.0);
        a.push(200, 0.0);
        let mut b = Curve::new();
        b.push(90, 1.0);
        b.push(110, 1.0);
        a.overdub(&b);
        assert_eq!(a.points.len(), 4);
        assert!((a.value_at(100, 300, 0.0) - 1.0).abs() < 1e-6);
    }
}
