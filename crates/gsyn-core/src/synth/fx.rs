//! Master effects: stereo delay, FDN reverb, peak limiter (spec section 6 "Master").
//! Buffers are allocated once at construction; `process` never allocates.

use super::kernel;

/// Simple one-pole low-pass used for damping.
#[derive(Clone, Copy, Default)]
struct OnePole {
    z: f32,
}

impl OnePole {
    #[inline]
    fn run(&mut self, x: f32, coeff: f32) -> f32 {
        self.z += (x - self.z) * coeff;
        self.z
    }
}

/// Stereo ping-pong-ish delay fed from a mono send.
pub struct StereoDelay {
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    pos: usize,
    pub time_samples: usize,
    pub feedback: f32,
    pub damping: f32,
    damp_l: OnePole,
    damp_r: OnePole,
}

impl StereoDelay {
    pub fn new(sample_rate: f32) -> Self {
        let max = (sample_rate * 2.0) as usize + 1;
        Self {
            buf_l: vec![0.0; max],
            buf_r: vec![0.0; max],
            pos: 0,
            time_samples: (sample_rate * 0.375) as usize,
            feedback: 0.42,
            damping: 0.35,
            damp_l: OnePole::default(),
            damp_r: OnePole::default(),
        }
    }

    pub fn set_time_seconds(&mut self, sample_rate: f32, secs: f32) {
        self.time_samples = ((sample_rate * secs) as usize).clamp(1, self.buf_l.len() - 1);
    }

    /// Sync the delay to a musical division of the beat.
    pub fn sync_to_beat(&mut self, samples_per_beat: f64, division: f32) {
        let t = (samples_per_beat * division as f64) as usize;
        self.time_samples = t.clamp(1, self.buf_l.len() - 1);
    }

    /// `send` is mono input; output is added to out_l/out_r.
    pub fn process(&mut self, send: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let n = self.buf_l.len();
        let d = self.time_samples.min(n - 1);
        for i in 0..send.len() {
            let rp = (self.pos + n - d) % n;
            let yl = self.buf_l[rp];
            let yr = self.buf_r[rp];
            // cross feedback for width
            let fl = self.damp_l.run(yr * self.feedback + send[i], self.damping);
            let fr = self.damp_r.run(yl * self.feedback, self.damping);
            self.buf_l[self.pos] = fl;
            self.buf_r[self.pos] = fr;
            out_l[i] += yl;
            out_r[i] += yr;
            self.pos = (self.pos + 1) % n;
        }
    }

    pub fn clear(&mut self) {
        self.buf_l.iter_mut().for_each(|v| *v = 0.0);
        self.buf_r.iter_mut().for_each(|v| *v = 0.0);
    }
}

struct Allpass {
    buf: Vec<f32>,
    pos: usize,
    g: f32,
}

impl Allpass {
    fn new(len: usize, g: f32) -> Self {
        Self {
            buf: vec![0.0; len.max(1)],
            pos: 0,
            g,
        }
    }
    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let d = self.buf[self.pos];
        let v = x - self.g * d;
        self.buf[self.pos] = v;
        self.pos = (self.pos + 1) % self.buf.len();
        d + self.g * v
    }
}

/// 4-line feedback delay network reverb with Householder mixing.
pub struct FdnReverb {
    lines: [Vec<f32>; 4],
    pos: [usize; 4],
    damp: [OnePole; 4],
    diffuse: [Allpass; 2],
    /// 0..1, maps to feedback gain
    pub size: f32,
    pub damping: f32,
    pub mix: f32,
}

impl FdnReverb {
    pub fn new(sample_rate: f32) -> Self {
        let k = sample_rate / 48_000.0;
        let lens = [1557.0, 1917.0, 2269.0, 2647.0].map(|l: f32| (l * k) as usize);
        Self {
            lines: [
                vec![0.0; lens[0]],
                vec![0.0; lens[1]],
                vec![0.0; lens[2]],
                vec![0.0; lens[3]],
            ],
            pos: [0; 4],
            damp: [OnePole::default(); 4],
            diffuse: [
                Allpass::new((347.0 * k) as usize, 0.6),
                Allpass::new((113.0 * k) as usize, 0.55),
            ],
            size: 0.8,
            damping: 0.25,
            mix: 1.0,
        }
    }

    /// Mono send in, stereo added to outputs.
    pub fn process(&mut self, send: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let fb = 0.55 + 0.44 * self.size.clamp(0.0, 1.0);
        let dc = 1.0 - self.damping.clamp(0.0, 0.99);
        for i in 0..send.len() {
            let mut x = send[i];
            x = self.diffuse[0].run(x);
            x = self.diffuse[1].run(x);
            let mut y = [0.0f32; 4];
            for l in 0..4 {
                y[l] = self.lines[l][self.pos[l]];
            }
            // Householder: v - 0.5 * sum(v)
            let s = 0.5 * (y[0] + y[1] + y[2] + y[3]);
            let mut f = [y[0] - s, y[1] - s, y[2] - s, y[3] - s];
            for l in 0..4 {
                f[l] = self.damp[l].run(f[l] * fb + x, dc);
                self.lines[l][self.pos[l]] = f[l];
                self.pos[l] = (self.pos[l] + 1) % self.lines[l].len();
            }
            out_l[i] += (y[0] + y[2]) * 0.5 * self.mix;
            out_r[i] += (y[1] + y[3]) * 0.5 * self.mix;
        }
    }

    pub fn clear(&mut self) {
        for l in self.lines.iter_mut() {
            l.iter_mut().for_each(|v| *v = 0.0);
        }
    }
}

/// Brick-wall-ish peak limiter with fast attack / slow release.
pub struct Limiter {
    pub threshold: f32,
    gain: f32,
    attack: f32,
    release: f32,
}

impl Limiter {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            threshold: 0.95,
            gain: 1.0,
            attack: 1.0 - libm::expf(-1.0 / (sample_rate * 0.0008)),
            release: 1.0 - libm::expf(-1.0 / (sample_rate * 0.12)),
        }
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let peak = l[i].abs().max(r[i].abs());
            let target = if peak > self.threshold {
                self.threshold / peak
            } else {
                1.0
            };
            let c = if target < self.gain {
                self.attack
            } else {
                self.release
            };
            self.gain += (target - self.gain) * c;
            l[i] *= self.gain;
            r[i] *= self.gain;
        }
    }
}

/// Whole master chain: soft clipper -> (delay, reverb returns) -> limiter.
pub struct Master {
    pub delay: StereoDelay,
    pub reverb: FdnReverb,
    pub limiter: Limiter,
    pub drive: f32,
    pub reverb_enabled: bool,
    pub delay_enabled: bool,
    pub output_gain: f32,
}

impl Master {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            delay: StereoDelay::new(sample_rate),
            reverb: FdnReverb::new(sample_rate),
            limiter: Limiter::new(sample_rate),
            drive: 1.2,
            reverb_enabled: true,
            delay_enabled: true,
            output_gain: 0.9,
        }
    }

    /// `rev_send`/`dly_send` are mono send buses accumulated by the voices.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], rev_send: &[f32], dly_send: &[f32]) {
        kernel::softclip_block(l, self.drive);
        kernel::softclip_block(r, self.drive);
        if self.delay_enabled {
            self.delay.process(dly_send, l, r);
        }
        if self.reverb_enabled {
            self.reverb.process(rev_send, l, r);
        }
        for i in 0..l.len() {
            l[i] *= self.output_gain;
            r[i] *= self.output_gain;
        }
        self.limiter.process(l, r);
    }

    pub fn clear(&mut self) {
        self.delay.clear();
        self.reverb.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverb_decays() {
        let mut rv = FdnReverb::new(48_000.0);
        let mut l = vec![0.0f32; 128];
        let mut r = vec![0.0f32; 128];
        let mut send = vec![0.0f32; 128];
        send[0] = 1.0;
        rv.process(&send, &mut l, &mut r);
        let send0 = vec![0.0f32; 128];
        let mut early = 0.0f32;
        let mut late = 0.0f32;
        for b in 0..2000 {
            l.iter_mut().for_each(|v| *v = 0.0);
            r.iter_mut().for_each(|v| *v = 0.0);
            rv.process(&send0, &mut l, &mut r);
            let e: f32 = l.iter().map(|v| v.abs()).sum();
            if b < 100 {
                early += e;
            } else if b > 1800 {
                late += e;
            }
        }
        assert!(early > late * 5.0, "early {early} late {late}");
        assert!(late.is_finite());
    }

    #[test]
    fn limiter_caps_peaks() {
        let mut lim = Limiter::new(48_000.0);
        let mut l = vec![3.0f32; 4800];
        let mut r = vec![-3.0f32; 4800];
        lim.process(&mut l, &mut r);
        assert!(l[4799] <= 0.96 && l[4799] > 0.5);
        assert!(r[4799] >= -0.96);
    }

    #[test]
    fn delay_repeats() {
        let mut d = StereoDelay::new(48_000.0);
        d.time_samples = 100;
        d.feedback = 0.5;
        d.damping = 1.0;
        let mut send = vec![0.0f32; 512];
        send[0] = 1.0;
        let mut l = vec![0.0f32; 512];
        let mut r = vec![0.0f32; 512];
        d.process(&send, &mut l, &mut r);
        assert!(l[100].abs() > 0.9, "{}", l[100]);
        assert!(r[200].abs() > 0.4, "{}", r[200]);
    }
}
