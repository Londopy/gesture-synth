//! Instrument presets (spec section 6): oscillator recipe + envelope + filter
//! defaults + fx send. These are the `instrument.gsyn.json` format (spec 10).

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Wave {
    #[default]
    Saw,
    Sine,
    Triangle,
    Square,
}

impl Wave {
    pub fn kernel_id(self) -> u32 {
        match self {
            Wave::Saw => 0,
            Wave::Sine => 1,
            Wave::Triangle => 2,
            Wave::Square => 3,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct OscSpec {
    pub wave: Wave,
    /// Detune in cents.
    pub detune: f32,
    /// Level 0..1.
    pub level: f32,
    /// Octave offset (-2..2).
    #[serde(default)]
    pub octave: i8,
}

impl Default for OscSpec {
    fn default() -> Self {
        Self { wave: Wave::Saw, detune: 0.0, level: 0.5, octave: 0 }
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct Envelope {
    /// Attack seconds
    pub a: f32,
    /// Decay seconds
    pub d: f32,
    /// Sustain level 0..1
    pub s: f32,
    /// Release seconds
    pub r: f32,
}

impl Default for Envelope {
    fn default() -> Self {
        Self { a: 0.01, d: 0.2, s: 0.8, r: 0.3 }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilterType {
    #[default]
    Lowpass,
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct FilterSpec {
    #[serde(rename = "type")]
    pub kind: FilterType,
    /// Resonance 0..1
    pub res: f32,
    /// Cutoff range in Hz [min, max]; the right-hand tilt (0..1) sweeps it exponentially.
    pub cutoff_range: [f32; 2],
}

impl Default for FilterSpec {
    fn default() -> Self {
        Self { kind: FilterType::Lowpass, res: 0.2, cutoff_range: [200.0, 12_000.0] }
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct FxSend {
    /// Reverb send 0..1
    pub reverb: f32,
    /// Delay send 0..1
    pub delay: f32,
}

impl Default for FxSend {
    fn default() -> Self {
        Self { reverb: 0.25, delay: 0.0 }
    }
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Instrument {
    pub name: String,
    pub osc: Vec<OscSpec>,
    pub env: Envelope,
    pub filter: FilterSpec,
    pub fx: FxSend,
    /// Overall gain trim (linear).
    #[serde(default = "one")]
    pub gain: f32,
    /// Portamento time in seconds for mono (theremin/bass) use.
    #[serde(default)]
    pub glide: f32,
}

fn one() -> f32 {
    1.0
}

impl Default for Instrument {
    fn default() -> Self {
        pad()
    }
}

impl Instrument {
    /// Two oscillator specs for the voice (pads the list if the preset has one).
    pub fn osc_pair(&self) -> [OscSpec; 2] {
        let a = self.osc.first().copied().unwrap_or_default();
        let b = self.osc.get(1).copied().unwrap_or(OscSpec { level: 0.0, ..a });
        [a, b]
    }

    /// Find a built-in preset by name (case-insensitive).
    pub fn builtin(name: &str) -> Option<Instrument> {
        let n = name.trim().to_ascii_lowercase();
        BUILTIN_NAMES.iter().position(|b| b.to_ascii_lowercase() == n).map(|i| builtin_by_index(i))
    }
}

pub const BUILTIN_NAMES: [&str; 7] = ["Pad", "Keys", "Organ", "Pluck", "Bass", "Lead", "Choir"];

pub fn builtin_by_index(i: usize) -> Instrument {
    match i {
        0 => pad(),
        1 => keys(),
        2 => organ(),
        3 => pluck(),
        4 => bass(),
        5 => lead(),
        _ => choir(),
    }
}

pub fn all_builtin() -> Vec<Instrument> {
    (0..BUILTIN_NAMES.len()).map(builtin_by_index).collect()
}

pub fn pad() -> Instrument {
    Instrument {
        name: "Pad".into(),
        osc: vec![
            OscSpec { wave: Wave::Saw, detune: -7.0, level: 0.45, octave: 0 },
            OscSpec { wave: Wave::Saw, detune: 7.0, level: 0.45, octave: 0 },
        ],
        env: Envelope { a: 0.35, d: 0.4, s: 0.85, r: 1.2 },
        filter: FilterSpec { kind: FilterType::Lowpass, res: 0.25, cutoff_range: [180.0, 9_000.0] },
        fx: FxSend { reverb: 0.45, delay: 0.12 },
        gain: 0.8,
        glide: 0.0,
    }
}

pub fn keys() -> Instrument {
    Instrument {
        name: "Keys".into(),
        osc: vec![
            OscSpec { wave: Wave::Sine, detune: 0.0, level: 0.7, octave: 0 },
            OscSpec { wave: Wave::Triangle, detune: 3.0, level: 0.35, octave: 1 },
        ],
        env: Envelope { a: 0.004, d: 1.4, s: 0.25, r: 0.5 },
        filter: FilterSpec { kind: FilterType::Lowpass, res: 0.1, cutoff_range: [400.0, 8_000.0] },
        fx: FxSend { reverb: 0.3, delay: 0.0 },
        gain: 0.9,
        glide: 0.0,
    }
}

pub fn organ() -> Instrument {
    Instrument {
        name: "Organ".into(),
        osc: vec![
            OscSpec { wave: Wave::Square, detune: 0.0, level: 0.4, octave: 0 },
            OscSpec { wave: Wave::Sine, detune: 0.0, level: 0.5, octave: 1 },
        ],
        env: Envelope { a: 0.01, d: 0.05, s: 1.0, r: 0.08 },
        filter: FilterSpec { kind: FilterType::Lowpass, res: 0.05, cutoff_range: [600.0, 10_000.0] },
        fx: FxSend { reverb: 0.2, delay: 0.0 },
        gain: 0.7,
        glide: 0.0,
    }
}

pub fn pluck() -> Instrument {
    Instrument {
        name: "Pluck".into(),
        osc: vec![
            OscSpec { wave: Wave::Saw, detune: 0.0, level: 0.6, octave: 0 },
            OscSpec { wave: Wave::Square, detune: -5.0, level: 0.25, octave: 0 },
        ],
        env: Envelope { a: 0.002, d: 0.35, s: 0.0, r: 0.25 },
        filter: FilterSpec { kind: FilterType::Lowpass, res: 0.35, cutoff_range: [300.0, 7_000.0] },
        fx: FxSend { reverb: 0.3, delay: 0.35 },
        gain: 0.9,
        glide: 0.0,
    }
}

pub fn bass() -> Instrument {
    Instrument {
        name: "Bass".into(),
        osc: vec![
            OscSpec { wave: Wave::Saw, detune: 0.0, level: 0.6, octave: -1 },
            OscSpec { wave: Wave::Sine, detune: 0.0, level: 0.5, octave: -1 },
        ],
        env: Envelope { a: 0.005, d: 0.3, s: 0.6, r: 0.15 },
        filter: FilterSpec { kind: FilterType::Lowpass, res: 0.3, cutoff_range: [80.0, 2_500.0] },
        fx: FxSend { reverb: 0.05, delay: 0.0 },
        gain: 0.9,
        glide: 0.03,
    }
}

pub fn lead() -> Instrument {
    Instrument {
        name: "Lead".into(),
        osc: vec![
            OscSpec { wave: Wave::Sine, detune: 0.0, level: 0.8, octave: 0 },
            OscSpec { wave: Wave::Triangle, detune: 0.0, level: 0.25, octave: 0 },
        ],
        env: Envelope { a: 0.06, d: 0.1, s: 1.0, r: 0.25 },
        filter: FilterSpec { kind: FilterType::Lowpass, res: 0.15, cutoff_range: [300.0, 9_000.0] },
        fx: FxSend { reverb: 0.35, delay: 0.2 },
        gain: 0.9,
        glide: 0.08,
    }
}

pub fn choir() -> Instrument {
    Instrument {
        name: "Choir".into(),
        osc: vec![
            OscSpec { wave: Wave::Triangle, detune: -9.0, level: 0.5, octave: 0 },
            OscSpec { wave: Wave::Saw, detune: 9.0, level: 0.2, octave: 0 },
        ],
        env: Envelope { a: 0.5, d: 0.5, s: 0.9, r: 1.5 },
        filter: FilterSpec { kind: FilterType::Lowpass, res: 0.4, cutoff_range: [250.0, 3_500.0] },
        fx: FxSend { reverb: 0.6, delay: 0.1 },
        gain: 0.85,
        glide: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_roundtrip_json() {
        for inst in all_builtin() {
            let s = serde_json::to_string(&inst).unwrap();
            let back: Instrument = serde_json::from_str(&s).unwrap();
            assert_eq!(inst, back);
        }
        assert!(Instrument::builtin("pad").is_some());
        assert!(Instrument::builtin("nope").is_none());
    }
}
