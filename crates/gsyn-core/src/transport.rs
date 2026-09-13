//! Sample-accurate transport clock (spec section 6, "Transport").
//!
//! Positions are in samples since loop start. The beat unit follows the time
//! signature denominator (x/4 -> quarter, x/8 -> eighth), BPM counts beat units.
//! The 16th-note grid ("steps") is the quantize/edit resolution everywhere.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, Hash)]
pub struct TimeSig {
    pub beats: u8,
    pub unit: u8,
}

impl Default for TimeSig {
    fn default() -> Self {
        Self { beats: 4, unit: 4 }
    }
}

impl TimeSig {
    pub const ALL: [TimeSig; 6] = [
        TimeSig { beats: 2, unit: 4 },
        TimeSig { beats: 3, unit: 4 },
        TimeSig { beats: 4, unit: 4 },
        TimeSig { beats: 5, unit: 4 },
        TimeSig { beats: 6, unit: 8 },
        TimeSig { beats: 7, unit: 8 },
    ];

    pub fn new(beats: u8, unit: u8) -> Self {
        Self { beats: beats.clamp(1, 16), unit: if unit == 8 { 8 } else { 4 } }
    }

    pub fn parse(s: &str) -> Option<Self> {
        let (a, b) = s.split_once('/')?;
        Some(Self::new(a.trim().parse().ok()?, b.trim().parse().ok()?))
    }

    /// 16th-note steps per beat unit.
    pub fn steps_per_beat(&self) -> u32 {
        match self.unit {
            8 => 2,
            _ => 4,
        }
    }

    pub fn steps_per_bar(&self) -> u32 {
        self.beats as u32 * self.steps_per_beat()
    }

    pub fn label(&self) -> String {
        format!("{}/{}", self.beats, self.unit)
    }
}

/// Quantize grid for chord onsets.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Quantize {
    Off,
    #[default]
    Sixteenth,
    Eighth,
    Triplet,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportState {
    #[default]
    Stopped,
    CountIn,
    Playing,
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct Transport {
    pub sample_rate: f32,
    pub bpm: f32,
    pub sig: TimeSig,
    pub bars: u8,
    pub state: TransportState,
    /// Samples since loop start (wraps at loop length while playing).
    pub position: u64,
    /// Remaining count-in samples when `state == CountIn`.
    pub count_in_remaining: u64,
    pub count_in_total: u64,
    /// Monotonic sample counter since engine start (never wraps) for timestamps.
    pub now: u64,
    /// Number of completed loops since play started.
    pub loop_count: u32,
}

/// A beat boundary crossed during a block.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct BeatTick {
    /// Sample offset within the processed block.
    pub offset: usize,
    /// 0-based beat within the bar.
    pub beat: u32,
    /// 0-based bar within the loop.
    pub bar: u32,
    pub is_bar_start: bool,
    pub is_count_in: bool,
    /// True when this tick is the first sample of bar 1 after a wrap.
    pub is_loop_start: bool,
}

/// Fixed-size tick list (a block never contains more than a handful of beats).
#[derive(Clone, Copy, Debug, Default)]
pub struct Ticks {
    items: [Option<BeatTick>; 8],
    len: usize,
}

impl Ticks {
    pub fn push(&mut self, t: BeatTick) {
        if self.len < 8 {
            self.items[self.len] = Some(t);
            self.len += 1;
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = BeatTick> + '_ {
        self.items[..self.len].iter().map(|t| t.unwrap())
    }
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl Default for Transport {
    fn default() -> Self {
        Self::new(crate::DEFAULT_SAMPLE_RATE)
    }
}

impl Transport {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            bpm: 100.0,
            sig: TimeSig::default(),
            bars: 4,
            state: TransportState::Stopped,
            position: 0,
            count_in_remaining: 0,
            count_in_total: 0,
            now: 0,
            loop_count: 0,
        }
    }

    pub fn set_bpm(&mut self, bpm: f32) {
        let old = self.bpm;
        self.bpm = bpm.clamp(40.0, 240.0);
        // keep musical position when tempo changes while running
        if self.state != TransportState::Stopped && old > 0.0 {
            self.position = (self.position as f64 * (old as f64 / self.bpm as f64)) as u64;
        }
    }

    pub fn set_sig(&mut self, sig: TimeSig) {
        self.sig = sig;
        self.position %= self.loop_len().max(1);
    }

    pub fn set_bars(&mut self, bars: u8) {
        self.bars = bars.clamp(1, 16);
        self.position %= self.loop_len().max(1);
    }

    /// Samples per beat unit (f64 for accuracy).
    #[inline]
    pub fn samples_per_beat(&self) -> f64 {
        self.sample_rate as f64 * 60.0 / self.bpm as f64
    }

    #[inline]
    pub fn samples_per_step(&self) -> f64 {
        self.samples_per_beat() / self.sig.steps_per_beat() as f64
    }

    #[inline]
    pub fn samples_per_bar(&self) -> f64 {
        self.samples_per_beat() * self.sig.beats as f64
    }

    /// Loop length in samples (integer, rounded).
    #[inline]
    pub fn loop_len(&self) -> u64 {
        (self.samples_per_bar() * self.bars as f64).round() as u64
    }

    pub fn total_steps(&self) -> u32 {
        self.sig.steps_per_bar() * self.bars as u32
    }

    pub fn is_running(&self) -> bool {
        self.state != TransportState::Stopped
    }

    /// Start playing from bar 1 immediately.
    pub fn play(&mut self) {
        self.state = TransportState::Playing;
        self.position = 0;
        self.loop_count = 0;
        self.count_in_remaining = 0;
    }

    /// Continue playing without resetting position (used after count-in / when
    /// already playing and a record is armed).
    pub fn resume(&mut self) {
        if self.state == TransportState::Stopped {
            self.play();
        }
    }

    /// Start a count-in of `bars` bars, then play from bar 1.
    pub fn count_in(&mut self, bars: u8) {
        let n = (self.samples_per_bar() * bars.max(1) as f64).round() as u64;
        self.state = TransportState::CountIn;
        self.count_in_remaining = n;
        self.count_in_total = n;
        self.position = 0;
        self.loop_count = 0;
    }

    pub fn stop(&mut self) {
        self.state = TransportState::Stopped;
        self.position = 0;
        self.count_in_remaining = 0;
        self.loop_count = 0;
    }

    /// Advance by `n` samples. Returns the beat ticks crossed and whether the
    /// loop wrapped (so callers can finish recordings etc.).
    pub fn advance(&mut self, n: usize) -> (Ticks, bool) {
        let mut ticks = Ticks::default();
        let mut wrapped = false;
        self.now = self.now.wrapping_add(n as u64);
        if self.state == TransportState::Stopped {
            return (ticks, false);
        }
        let spb = self.samples_per_beat();
        let mut offset = 0usize;
        let mut remaining = n;

        if self.state == TransportState::CountIn {
            // count-in runs on its own clock: position counts up from 0 over count_in_total
            let elapsed = self.count_in_total - self.count_in_remaining;
            let consume = remaining.min(self.count_in_remaining as usize);
            // beats crossed within [elapsed, elapsed+consume)
            let first_beat = (elapsed as f64 / spb).ceil() as u64;
            let last_beat = ((elapsed + consume as u64) as f64 / spb).ceil() as u64;
            for b in first_beat..last_beat {
                let at = (b as f64 * spb).round() as u64;
                if at >= elapsed && at < elapsed + consume as u64 {
                    let beat_in_bar = (b % self.sig.beats as u64) as u32;
                    ticks.push(BeatTick {
                        offset: (at - elapsed) as usize,
                        beat: beat_in_bar,
                        bar: (b / self.sig.beats as u64) as u32,
                        is_bar_start: beat_in_bar == 0,
                        is_count_in: true,
                        is_loop_start: false,
                    });
                }
            }
            self.count_in_remaining -= consume as u64;
            remaining -= consume;
            offset += consume;
            if self.count_in_remaining == 0 {
                self.state = TransportState::Playing;
                self.position = 0;
                self.loop_count = 0;
                if remaining == 0 {
                    // loop starts exactly at the next block boundary; emit the
                    // downbeat tick now at offset n (callers treat offset==n as "next sample")
                    ticks.push(BeatTick { offset: n, beat: 0, bar: 0, is_bar_start: true, is_count_in: false, is_loop_start: true });
                    return (ticks, false);
                }
            } else {
                return (ticks, false);
            }
        }

        // Playing
        let len = self.loop_len().max(1);
        while remaining > 0 {
            let to_wrap = (len - self.position) as usize;
            let chunk = remaining.min(to_wrap);
            let start = self.position;
            let end = self.position + chunk as u64;
            let first_beat = (start as f64 / spb).ceil() as u64;
            let last_beat = (end as f64 / spb).ceil() as u64;
            for b in first_beat..last_beat {
                let at = (b as f64 * spb).round() as u64;
                if at >= start && at < end {
                    let beat_in_bar = (b % self.sig.beats as u64) as u32;
                    ticks.push(BeatTick {
                        offset: offset + (at - start) as usize,
                        beat: beat_in_bar,
                        bar: (b / self.sig.beats as u64) as u32,
                        is_bar_start: beat_in_bar == 0,
                        is_count_in: false,
                        is_loop_start: at == 0,
                    });
                }
            }
            self.position = end;
            offset += chunk;
            remaining -= chunk;
            if self.position >= len {
                self.position = 0;
                self.loop_count += 1;
                wrapped = true;
            }
        }
        (ticks, wrapped)
    }

    /// 1-based bar, 1-based beat, 0-based step within loop, phase 0..1 within beat.
    pub fn position_info(&self) -> (u32, u32, u32, f32) {
        let spb = self.samples_per_beat();
        let beat_f = self.position as f64 / spb;
        let beat_idx = beat_f.floor() as u32;
        let bar = beat_idx / self.sig.beats as u32 + 1;
        let beat = beat_idx % self.sig.beats as u32 + 1;
        let step = (self.position as f64 / self.samples_per_step()).floor() as u32;
        (bar, beat, step.min(self.total_steps().saturating_sub(1)), (beat_f - beat_f.floor()) as f32)
    }

    /// Current count-in number to draw large (1..beats), if counting in.
    pub fn count_in_number(&self) -> Option<u32> {
        if self.state != TransportState::CountIn {
            return None;
        }
        let elapsed = self.count_in_total - self.count_in_remaining;
        let beat = (elapsed as f64 / self.samples_per_beat()).floor() as u32;
        Some(beat % self.sig.beats as u32 + 1)
    }

    /// Step index (0..total_steps) of a loop position.
    pub fn step_of(&self, pos: u64) -> u32 {
        ((pos as f64 / self.samples_per_step()).floor() as u32) % self.total_steps().max(1)
    }

    /// Quantize a loop position to the nearest grid point (wrapping at loop end).
    pub fn quantize_pos(&self, pos: u64, q: Quantize) -> u64 {
        let grid = match q {
            Quantize::Off => return pos,
            Quantize::Sixteenth => self.samples_per_step(),
            Quantize::Eighth => self.samples_per_step() * 2.0,
            Quantize::Triplet => self.samples_per_beat() / 3.0,
        };
        let len = self.loop_len().max(1);
        let q = ((pos as f64 / grid).round() * grid).round() as u64;
        q % len
    }

    /// Samples until the next grid point from `pos` (0 if on it), and whether the
    /// nearest grid point is behind us (so an input should apply immediately).
    pub fn grid_distance(&self, pos: u64, q: Quantize) -> (u64, bool) {
        let grid = match q {
            Quantize::Off => return (0, true),
            Quantize::Sixteenth => self.samples_per_step(),
            Quantize::Eighth => self.samples_per_step() * 2.0,
            Quantize::Triplet => self.samples_per_beat() / 3.0,
        };
        let k = pos as f64 / grid;
        let frac = k - k.floor();
        if frac < 0.5 {
            (0, true)
        } else {
            (((1.0 - frac) * grid).round() as u64, false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths() {
        let mut t = Transport::new(48_000.0);
        t.set_bpm(120.0);
        assert_eq!(t.samples_per_beat(), 24_000.0);
        assert_eq!(t.loop_len(), 24_000 * 16);
        t.set_sig(TimeSig::new(6, 8));
        assert_eq!(t.sig.steps_per_bar(), 12);
        assert_eq!(t.samples_per_step(), 12_000.0);
    }

    #[test]
    fn ticks_and_wrap() {
        let mut t = Transport::new(48_000.0);
        t.set_bpm(120.0);
        t.set_bars(1);
        t.play();
        let mut beats = 0;
        let mut wraps = 0;
        for _ in 0..(24_000 * 4 / 128 + 1) {
            let (ticks, wrapped) = t.advance(128);
            beats += ticks.len();
            if wrapped {
                wraps += 1;
            }
        }
        assert_eq!(wraps, 1);
        assert!(beats >= 4 && beats <= 5, "beats {beats}");
        let (bar, beat, _, _) = t.position_info();
        assert_eq!(bar, 1);
        assert_eq!(beat, 1);
    }

    #[test]
    fn count_in_then_play() {
        let mut t = Transport::new(48_000.0);
        t.set_bpm(120.0);
        t.count_in(1);
        assert_eq!(t.count_in_number(), Some(1));
        let mut count_in_ticks = 0;
        let mut play_ticks = 0;
        let mut loop_start_seen = false;
        for _ in 0..(24_000 * 5 / 128) {
            let (ticks, _) = t.advance(128);
            for tk in ticks.iter() {
                if tk.is_count_in {
                    count_in_ticks += 1;
                } else {
                    play_ticks += 1;
                    if tk.is_loop_start {
                        loop_start_seen = true;
                    }
                }
            }
        }
        assert_eq!(count_in_ticks, 4);
        assert!(play_ticks >= 1);
        assert!(loop_start_seen);
        assert_eq!(t.state, TransportState::Playing);
    }

    #[test]
    fn quantize() {
        let mut t = Transport::new(48_000.0);
        t.set_bpm(120.0); // step = 6000 samples
        assert_eq!(t.quantize_pos(2_900, Quantize::Sixteenth), 0);
        assert_eq!(t.quantize_pos(3_100, Quantize::Sixteenth), 6_000);
        assert_eq!(t.quantize_pos(11_000, Quantize::Eighth), 12_000);
        let (d, behind) = t.grid_distance(5_000, Quantize::Sixteenth);
        assert!(!behind);
        assert_eq!(d, 1_000);
        let (_, behind) = t.grid_distance(1_000, Quantize::Sixteenth);
        assert!(behind);
        // wrap: last step rounds to loop start
        let len = t.loop_len();
        assert_eq!(t.quantize_pos(len - 100, Quantize::Sixteenth), 0);
    }
}
