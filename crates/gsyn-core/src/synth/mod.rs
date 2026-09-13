//! Synth engine (spec section 6): voices, chord legato, arpeggiator, theremin,
//! metronome and master chain. Everything here runs on the audio thread and
//! never allocates after construction.

pub mod fx;
pub mod kernel;

use crate::instruments::{Envelope, Instrument, OscSpec};
use crate::music;
use crate::MAX_BLOCK;

/// Number of chord slots: 4 loop tracks + live.
pub const SLOTS: usize = 5;
pub const LIVE_SLOT: usize = 4;
/// Voices per slot: 4 chord voices + 1 bass-hit voice.
const VOICES: usize = 5;
const BASS_VOICE: usize = 4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy, Debug)]
struct Adsr {
    stage: Stage,
    level: f32,
}

impl Default for Adsr {
    fn default() -> Self {
        Self {
            stage: Stage::Idle,
            level: 0.0,
        }
    }
}

impl Adsr {
    #[inline]
    fn trigger(&mut self) {
        self.stage = Stage::Attack;
    }
    #[inline]
    fn release(&mut self) {
        if self.stage != Stage::Idle {
            self.stage = Stage::Release;
        }
    }
    #[inline]
    fn active(&self) -> bool {
        self.stage != Stage::Idle
    }
    /// Fill `out` with per-sample envelope levels.
    fn render(&mut self, out: &mut [f32], env: &Envelope, sr: f32) {
        let a_inc = 1.0 / (env.a.max(0.001) * sr);
        let d_coef = 1.0 - libm::expf(-1.0 / (env.d.max(0.001) * sr * 0.3));
        let r_coef = 1.0 - libm::expf(-1.0 / (env.r.max(0.001) * sr * 0.3));
        let sus = env.s.clamp(0.0, 1.0);
        for o in out.iter_mut() {
            match self.stage {
                Stage::Idle => self.level = 0.0,
                Stage::Attack => {
                    self.level += a_inc;
                    if self.level >= 1.0 {
                        self.level = 1.0;
                        self.stage = Stage::Decay;
                    }
                }
                Stage::Decay => {
                    self.level += (sus - self.level) * d_coef;
                    if self.level - sus < 0.002 {
                        self.stage = Stage::Sustain;
                    }
                }
                Stage::Sustain => self.level = sus,
                Stage::Release => {
                    self.level += (0.0 - self.level) * r_coef;
                    if self.level < 0.0005 {
                        self.level = 0.0;
                        self.stage = Stage::Idle;
                    }
                }
            }
            *o = self.level;
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Voice {
    note: u8,
    env: Adsr,
    phase: [f32; 2],
    freq: f32,
    target_freq: f32,
    filt: [f32; 2],
    /// Per-voice random pan offset for width.
    spread: f32,
    age: u32,
}

impl Default for Voice {
    fn default() -> Self {
        Self {
            note: 0,
            env: Adsr::default(),
            phase: [0.0, 0.37],
            freq: 220.0,
            target_freq: 220.0,
            filt: [0.0; 2],
            spread: 0.0,
            age: 0,
        }
    }
}

impl Voice {
    #[inline]
    fn active(&self) -> bool {
        self.env.active()
    }

    fn start(&mut self, note: u8, glide: bool) {
        self.note = note;
        self.target_freq = music::midi_to_hz(note as f32);
        if !glide || !self.active() {
            self.freq = self.target_freq;
        }
        self.env.trigger();
        self.age = 0;
    }

    /// Render this voice into `out` (mono, overwriting). Returns false if idle.
    fn render(
        &mut self,
        out: &mut [f32],
        env_buf: &mut [f32],
        tmp: &mut [f32],
        inst: &Instrument,
        osc: &[OscSpec; 2],
        cutoff_hz: f32,
        sr: f32,
    ) -> bool {
        if !self.active() {
            return false;
        }
        let n = out.len();
        // glide
        if inst.glide > 0.0 && (self.freq - self.target_freq).abs() > 0.01 {
            let c = 1.0 - libm::expf(-(n as f32) / (inst.glide * sr));
            self.freq += (self.target_freq - self.freq) * c;
        } else {
            self.freq = self.target_freq;
        }
        out[..n].iter_mut().for_each(|v| *v = 0.0);
        for (k, o) in osc.iter().enumerate() {
            if o.level <= 0.0001 {
                continue;
            }
            let f = self.freq * libm::exp2f(o.octave as f32 + o.detune / 1200.0);
            let inc = (f / sr).min(0.49);
            kernel::osc_block(&mut tmp[..n], &mut self.phase[k], inc, o.wave.kernel_id());
            kernel::mix_add(&mut out[..n], &tmp[..n], o.level);
        }
        // filter
        let fc = cutoff_hz.clamp(20.0, sr * 0.45);
        let g = libm::tanf(core::f32::consts::PI * fc / sr);
        let k = 2.0 - 2.0 * inst.filter.res.clamp(0.0, 0.95);
        kernel::svf_lp_block(&mut out[..n], &mut self.filt, g, k);
        // envelope
        self.env.render(&mut env_buf[..n], &inst.env, sr);
        for i in 0..n {
            out[i] *= env_buf[i];
        }
        self.age = self.age.wrapping_add(n as u32);
        true
    }
}

/// Per-slot parameters for one block, supplied by the engine from MusicalState.
#[derive(Clone, Copy, Debug)]
pub struct SlotParams {
    pub cutoff: f32,
    pub volume: f32,
    pub pan: f32,
    pub arp: bool,
    /// Arp step period in samples (already derived from rate + tempo).
    pub arp_period: u32,
    /// Track gain (mixer volume) 0..1.
    pub gain: f32,
    /// Track pan -1..1 (added to the gesture pan).
    pub track_pan: f32,
    pub audible: bool,
}

impl Default for SlotParams {
    fn default() -> Self {
        Self {
            cutoff: 0.7,
            volume: 0.0,
            pan: 0.0,
            arp: false,
            arp_period: 12_000,
            gain: 1.0,
            track_pan: 0.0,
            audible: true,
        }
    }
}

/// One chord "instrument lane": 4 legato voices + bass-hit voice + arp.
pub struct ChordSlot {
    pub inst: Instrument,
    osc: [OscSpec; 2],
    voices: [Voice; VOICES],
    sounding: [u8; 4],
    count: u8,
    cutoff_s: f32,
    vol_s: f32,
    pan_s: f32,
    arp_pos: u32,
    arp_idx: usize,
    arp_was_on: bool,
    tmp: [f32; MAX_BLOCK],
    tmp2: [f32; MAX_BLOCK],
    env_buf: [f32; MAX_BLOCK],
    voice_buf: [f32; MAX_BLOCK],
}

impl ChordSlot {
    pub fn new(inst: Instrument) -> Self {
        let osc = inst.osc_pair();
        let mut voices = [Voice::default(); VOICES];
        let spreads = [-0.35, 0.2, -0.1, 0.35, 0.0];
        for (v, s) in voices.iter_mut().zip(spreads) {
            v.spread = s;
        }
        Self {
            inst,
            osc,
            voices,
            sounding: [0; 4],
            count: 0,
            cutoff_s: 0.7,
            vol_s: 0.0,
            pan_s: 0.0,
            arp_pos: 0,
            arp_idx: 0,
            arp_was_on: false,
            tmp: [0.0; MAX_BLOCK],
            tmp2: [0.0; MAX_BLOCK],
            env_buf: [0.0; MAX_BLOCK],
            voice_buf: [0.0; MAX_BLOCK],
        }
    }

    pub fn set_instrument(&mut self, inst: Instrument) {
        self.osc = inst.osc_pair();
        self.inst = inst;
    }

    pub fn sounding(&self) -> &[u8] {
        &self.sounding[..self.count as usize]
    }

    pub fn is_sounding(&self) -> bool {
        self.count > 0
    }

    /// Chord legato: keep common tones, retrigger only changed voices (spec 6).
    pub fn chord_on(&mut self, notes: &[u8]) {
        let count = notes.len().min(4);
        let new = &notes[..count];
        // release voices whose note is not in the new chord
        for v in self.voices[..4].iter_mut() {
            if v.active() && !new.contains(&v.note) {
                v.env.release();
            }
        }
        // assign new notes to voices
        for &n in new {
            if self.voices[..4]
                .iter()
                .any(|v| v.active() && v.note == n && v.env.stage != Stage::Release)
            {
                continue; // common tone: hold
            }
            // reuse a releasing voice with the same note, else the quietest free/oldest voice
            let idx = self.voices[..4]
                .iter()
                .position(|v| v.active() && v.note == n)
                .or_else(|| self.voices[..4].iter().position(|v| !v.active()))
                .or_else(|| {
                    self.voices[..4]
                        .iter()
                        .enumerate()
                        .filter(|(_, v)| !new.contains(&v.note))
                        .min_by_key(|(_, v)| (v.env.level * 1000.0) as i32)
                        .map(|(i, _)| i)
                })
                .unwrap_or(0);
            self.voices[idx].start(n, self.inst.glide > 0.0);
        }
        self.sounding[..count].copy_from_slice(new);
        self.count = count as u8;
        self.arp_idx = 0;
    }

    pub fn chord_off(&mut self) {
        for v in self.voices[..4].iter_mut() {
            v.env.release();
        }
        self.count = 0;
    }

    pub fn bass_hit(&mut self, note: u8) {
        self.voices[BASS_VOICE].start(note, false);
        // bass hit is a one-shot: schedule release quickly by starting in decay-ish
        // (its envelope follows the instrument; the engine releases it after ~200 ms)
    }

    pub fn bass_release(&mut self) {
        self.voices[BASS_VOICE].env.release();
    }

    pub fn all_off(&mut self) {
        for v in self.voices.iter_mut() {
            v.env = Adsr::default();
        }
        self.count = 0;
    }

    fn arp_step(&mut self) {
        if self.count == 0 {
            return;
        }
        let n = self.count as usize;
        self.arp_idx = (self.arp_idx + 1) % n;
        let note = self.sounding[self.arp_idx];
        for (i, v) in self.voices[..4].iter_mut().enumerate() {
            if i == self.arp_idx {
                v.start(note, false);
            } else {
                v.env.release();
            }
        }
    }

    /// Render into stereo buses (accumulate). `rev`/`dly` are mono send buses.
    pub fn render(
        &mut self,
        out_l: &mut [f32],
        out_r: &mut [f32],
        rev: &mut [f32],
        dly: &mut [f32],
        p: &SlotParams,
        sr: f32,
    ) {
        let n = out_l.len().min(MAX_BLOCK);
        // arp handling
        if p.arp && self.count > 0 {
            if !self.arp_was_on {
                self.arp_pos = 0;
                // gate all but first voice
                self.arp_idx = self.count as usize - 1;
                self.arp_step();
            }
            self.arp_pos += n as u32;
            if self.arp_pos >= p.arp_period.max(256) {
                self.arp_pos = 0;
                self.arp_step();
            }
        } else if self.arp_was_on && self.count > 0 {
            // arp turned off: restore the full chord
            let s = self.sounding;
            let c = self.count as usize;
            self.chord_on(&s[..c]);
        }
        self.arp_was_on = p.arp;

        // parameter smoothing per block
        let c = 1.0 - libm::expf(-(n as f32) / (sr * 0.012));
        self.cutoff_s += (p.cutoff - self.cutoff_s) * c;
        self.vol_s += (p.volume - self.vol_s) * c;
        self.pan_s += ((p.pan * 0.6 + p.track_pan).clamp(-1.0, 1.0) - self.pan_s) * c;
        if !p.audible {
            // still advance envelopes so releases finish, but output nothing
            for v in self.voices.iter_mut() {
                if v.active() {
                    v.render(
                        &mut self.voice_buf[..n],
                        &mut self.env_buf[..n],
                        &mut self.tmp[..n],
                        &self.inst,
                        &self.osc,
                        1000.0,
                        sr,
                    );
                }
            }
            return;
        }
        let range = self.inst.filter.cutoff_range;
        let cutoff_hz = range[0]
            * libm::powf(
                (range[1] / range[0]).max(1.0),
                self.cutoff_s.clamp(0.0, 1.0),
            );
        let gain = self.vol_s * p.gain * self.inst.gain * 0.35;
        if gain <= 1e-5 && !self.voices.iter().any(|v| v.active()) {
            return;
        }
        // mix voices
        self.tmp2[..n].iter_mut().for_each(|v| *v = 0.0);
        let mut any = false;
        let mut left_mix = [0.0f32; MAX_BLOCK];
        let mut right_mix = [0.0f32; MAX_BLOCK];
        for (i, v) in self.voices.iter_mut().enumerate() {
            let is_bass = i == BASS_VOICE;
            let fc = if is_bass {
                cutoff_hz.min(1800.0)
            } else {
                cutoff_hz
            };
            if v.render(
                &mut self.voice_buf[..n],
                &mut self.env_buf[..n],
                &mut self.tmp[..n],
                &self.inst,
                &self.osc,
                fc,
                sr,
            ) {
                any = true;
                let pan = (self.pan_s + v.spread * 0.4).clamp(-1.0, 1.0);
                let (gl, gr) = pan_gains(pan);
                let vg = if is_bass { 1.3 } else { 1.0 };
                kernel::mix_add(&mut left_mix[..n], &self.voice_buf[..n], gl * vg);
                kernel::mix_add(&mut right_mix[..n], &self.voice_buf[..n], gr * vg);
                kernel::mix_add(&mut self.tmp2[..n], &self.voice_buf[..n], vg);
            }
        }
        if !any {
            return;
        }
        kernel::mix_add(&mut out_l[..n], &left_mix[..n], gain);
        kernel::mix_add(&mut out_r[..n], &right_mix[..n], gain);
        kernel::mix_add(&mut rev[..n], &self.tmp2[..n], gain * self.inst.fx.reverb);
        kernel::mix_add(&mut dly[..n], &self.tmp2[..n], gain * self.inst.fx.delay);
    }
}

#[inline]
fn pan_gains(pan: f32) -> (f32, f32) {
    // constant power
    let a = (pan.clamp(-1.0, 1.0) + 1.0) * 0.25 * core::f32::consts::PI;
    let (s, c) = libm::sincosf(a);
    (c, s)
}

/// Mono glide voice for Theremin mode.
pub struct ThereminVoice {
    pub inst: Instrument,
    osc: [OscSpec; 2],
    phase: [f32; 2],
    freq_s: f32,
    vib_phase: f32,
    filt: [f32; 2],
    vol_s: f32,
    cutoff_s: f32,
    env: Adsr,
    tmp: [f32; MAX_BLOCK],
    buf: [f32; MAX_BLOCK],
    env_buf: [f32; MAX_BLOCK],
}

impl ThereminVoice {
    pub fn new(inst: Instrument) -> Self {
        let osc = inst.osc_pair();
        Self {
            inst,
            osc,
            phase: [0.0; 2],
            freq_s: 220.0,
            vib_phase: 0.0,
            filt: [0.0; 2],
            vol_s: 0.0,
            cutoff_s: 0.7,
            env: Adsr::default(),
            tmp: [0.0; MAX_BLOCK],
            buf: [0.0; MAX_BLOCK],
            env_buf: [0.0; MAX_BLOCK],
        }
    }

    pub fn set_instrument(&mut self, inst: Instrument) {
        self.osc = inst.osc_pair();
        self.inst = inst;
    }

    pub fn render(
        &mut self,
        out_l: &mut [f32],
        out_r: &mut [f32],
        rev: &mut [f32],
        on: bool,
        pitch_hz: f32,
        volume: f32,
        vibrato: f32,
        cutoff: f32,
        sr: f32,
    ) {
        let n = out_l.len().min(MAX_BLOCK);
        if on && volume > 0.001 {
            if !self.env.active() {
                self.env.trigger();
            }
        } else if self.env.active() && self.env.stage != Stage::Release {
            self.env.release();
        }
        if !self.env.active() {
            return;
        }
        let c = 1.0 - libm::expf(-(n as f32) / (sr * 0.01));
        self.freq_s += (pitch_hz.clamp(30.0, 4000.0) - self.freq_s) * c;
        self.vol_s += (volume - self.vol_s) * c;
        self.cutoff_s += (cutoff - self.cutoff_s) * c;
        // vibrato ~5.5 Hz, depth up to +-40 cents
        self.vib_phase += 5.5 * n as f32 / sr;
        if self.vib_phase >= 1.0 {
            self.vib_phase -= 1.0;
        }
        let vib = kernel::reference::fast_sin(self.vib_phase) * vibrato * 40.0;
        let f = self.freq_s * libm::exp2f(vib / 1200.0);
        self.buf[..n].iter_mut().for_each(|v| *v = 0.0);
        for (k, o) in self.osc.iter().enumerate() {
            if o.level <= 0.0001 {
                continue;
            }
            let ff = f * libm::exp2f(o.octave as f32 + o.detune / 1200.0);
            kernel::osc_block(
                &mut self.tmp[..n],
                &mut self.phase[k],
                (ff / sr).min(0.49),
                o.wave.kernel_id(),
            );
            kernel::mix_add(&mut self.buf[..n], &self.tmp[..n], o.level);
        }
        let range = self.inst.filter.cutoff_range;
        let fc = range[0]
            * libm::powf(
                (range[1] / range[0]).max(1.0),
                self.cutoff_s.clamp(0.0, 1.0),
            );
        let g = libm::tanf(core::f32::consts::PI * fc.clamp(20.0, sr * 0.45) / sr);
        kernel::svf_lp_block(
            &mut self.buf[..n],
            &mut self.filt,
            g,
            2.0 - 2.0 * self.inst.filter.res,
        );
        self.env.render(&mut self.env_buf[..n], &self.inst.env, sr);
        for i in 0..n {
            self.buf[i] *= self.env_buf[i];
        }
        let gain = self.vol_s * self.inst.gain * 0.4;
        kernel::mix_add(&mut out_l[..n], &self.buf[..n], gain * 0.72);
        kernel::mix_add(&mut out_r[..n], &self.buf[..n], gain * 0.72);
        kernel::mix_add(&mut rev[..n], &self.buf[..n], gain * self.inst.fx.reverb);
    }
}

/// Metronome click on the cue bus (spec 6): accent on beat 1.
pub struct Metronome {
    remaining: u32,
    phase: f32,
    inc: f32,
    amp: f32,
    pub volume: f32,
    pub enabled: bool,
}

impl Metronome {
    pub fn new() -> Self {
        Self {
            remaining: 0,
            phase: 0.0,
            inc: 0.0,
            amp: 0.0,
            volume: 0.6,
            enabled: true,
        }
    }

    /// Schedule a click starting at the given offset within the next rendered block.
    pub fn click(&mut self, accent: bool, sr: f32) {
        let f = if accent { 1760.0 } else { 1175.0 };
        self.inc = f / sr;
        self.remaining = (sr * if accent { 0.045 } else { 0.03 }) as u32;
        self.amp = if accent { 1.0 } else { 0.6 };
        self.phase = 0.0;
    }

    /// Render into the cue bus starting at `offset` (overwrite-add).
    pub fn render(&mut self, cue: &mut [f32], offset: usize) {
        if !self.enabled || self.remaining == 0 {
            return;
        }
        let total = self.remaining as f32;
        let start = offset.min(cue.len());
        for s in cue[start..].iter_mut() {
            if self.remaining == 0 {
                break;
            }
            let env = (self.remaining as f32 / total).min(1.0);
            *s += kernel::reference::fast_sin(self.phase) * env * env * self.amp * self.volume;
            self.phase += self.inc;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
            self.remaining -= 1;
        }
    }
}

impl Default for Metronome {
    fn default() -> Self {
        Self::new()
    }
}

/// The complete synth: slots + theremin + metronome + master.
pub struct Synth {
    pub sr: f32,
    pub slots: Vec<ChordSlot>,
    pub theremin: ThereminVoice,
    pub metronome: Metronome,
    pub master: fx::Master,
    rev: [f32; MAX_BLOCK],
    dly: [f32; MAX_BLOCK],
}

impl Synth {
    pub fn new(sr: f32) -> Self {
        let slots = (0..SLOTS)
            .map(|_| ChordSlot::new(Instrument::default()))
            .collect();
        Self {
            sr,
            slots,
            theremin: ThereminVoice::new(crate::instruments::lead()),
            metronome: Metronome::new(),
            master: fx::Master::new(sr),
            rev: [0.0; MAX_BLOCK],
            dly: [0.0; MAX_BLOCK],
        }
    }

    pub fn all_off(&mut self) {
        for s in self.slots.iter_mut() {
            s.all_off();
        }
        self.master.clear();
    }

    /// Render one block (<= MAX_BLOCK). `out_l/out_r` are overwritten; `cue` is
    /// overwritten with the metronome (callers mix it as they like).
    pub fn render(
        &mut self,
        out_l: &mut [f32],
        out_r: &mut [f32],
        params: &[SlotParams; SLOTS],
        theremin: Option<(f32, f32, f32, f32)>,
    ) {
        let n = out_l.len().min(MAX_BLOCK);
        out_l[..n].iter_mut().for_each(|v| *v = 0.0);
        out_r[..n].iter_mut().for_each(|v| *v = 0.0);
        self.rev[..n].iter_mut().for_each(|v| *v = 0.0);
        self.dly[..n].iter_mut().for_each(|v| *v = 0.0);
        for (i, slot) in self.slots.iter_mut().enumerate() {
            slot.render(
                &mut out_l[..n],
                &mut out_r[..n],
                &mut self.rev[..n],
                &mut self.dly[..n],
                &params[i],
                self.sr,
            );
        }
        match theremin {
            Some((hz, vol, vib, cutoff)) => self.theremin.render(
                &mut out_l[..n],
                &mut out_r[..n],
                &mut self.rev[..n],
                true,
                hz,
                vol,
                vib,
                cutoff,
                self.sr,
            ),
            None => self.theremin.render(
                &mut out_l[..n],
                &mut out_r[..n],
                &mut self.rev[..n],
                false,
                220.0,
                0.0,
                0.0,
                0.5,
                self.sr,
            ),
        }
        let (rev, dly) = (self.rev, self.dly);
        self.master
            .process(&mut out_l[..n], &mut out_r[..n], &rev[..n], &dly[..n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(vol: f32) -> [SlotParams; SLOTS] {
        let mut p = [SlotParams::default(); SLOTS];
        p[LIVE_SLOT].volume = vol;
        p
    }

    fn rms(buf: &[f32]) -> f32 {
        (buf.iter().map(|v| v * v).sum::<f32>() / buf.len() as f32).sqrt()
    }

    #[test]
    fn chord_makes_sound_and_releases() {
        let mut s = Synth::new(48_000.0);
        s.slots[LIVE_SLOT].chord_on(&[48, 52, 55]);
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        let p = params(0.8);
        let mut peak = 0.0f32;
        for _ in 0..200 {
            s.render(&mut l, &mut r, &p, None);
            peak = peak.max(rms(&l));
        }
        assert!(peak > 0.02, "peak {peak}");
        assert!(l.iter().all(|v| v.is_finite() && v.abs() <= 1.0));
        s.slots[LIVE_SLOT].chord_off();
        s.master.reverb_enabled = false;
        s.master.delay_enabled = false;
        for _ in 0..2000 {
            s.render(&mut l, &mut r, &p, None);
        }
        assert!(rms(&l) < 1e-3, "tail {}", rms(&l));
    }

    #[test]
    fn legato_keeps_common_tones() {
        let mut slot = ChordSlot::new(Instrument::default());
        slot.chord_on(&[48, 52, 55]);
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        let mut rev = [0.0f32; 128];
        let mut dly = [0.0f32; 128];
        let p = SlotParams {
            volume: 1.0,
            ..Default::default()
        };
        for _ in 0..50 {
            slot.render(&mut l, &mut r, &mut rev, &mut dly, &p, 48_000.0);
        }
        let ages_before: Vec<(u8, u32)> = slot.voices[..4]
            .iter()
            .filter(|v| v.active())
            .map(|v| (v.note, v.age))
            .collect();
        slot.chord_on(&[48, 53, 57]); // C stays, E->F, G->A
        let c_voice = slot.voices[..4].iter().find(|v| v.note == 48).unwrap();
        let before = ages_before.iter().find(|(n, _)| *n == 48).unwrap().1;
        assert_eq!(c_voice.age, before, "common tone must not retrigger");
        assert!(slot.voices[..4].iter().any(|v| v.note == 53 && v.age == 0));
        assert_eq!(slot.sounding(), &[48, 53, 57]);
    }

    #[test]
    fn theremin_and_metronome_render() {
        let mut s = Synth::new(48_000.0);
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        let p = params(0.0);
        let mut peak = 0.0;
        for _ in 0..100 {
            s.render(&mut l, &mut r, &p, Some((440.0, 0.8, 0.3, 0.7)));
            peak = rms(&l).max(peak);
        }
        assert!(peak > 0.02);
        let mut cue = [0.0f32; 128];
        s.metronome.click(true, 48_000.0);
        s.metronome.render(&mut cue, 0);
        assert!(rms(&cue) > 0.05);
    }

    #[test]
    fn arp_cycles_notes() {
        let mut slot = ChordSlot::new(Instrument::default());
        slot.chord_on(&[60, 64, 67]);
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        let mut rev = [0.0f32; 128];
        let mut dly = [0.0f32; 128];
        let p = SlotParams {
            volume: 1.0,
            arp: true,
            arp_period: 1024,
            ..Default::default()
        };
        let mut seen = std::collections::HashSet::new();
        for _ in 0..40 {
            slot.render(&mut l, &mut r, &mut rev, &mut dly, &p, 48_000.0);
            seen.insert(slot.sounding[slot.arp_idx]);
        }
        assert_eq!(seen.len(), 3);
    }
}
