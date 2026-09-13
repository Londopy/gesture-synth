//! Keys, modes, scale degrees, chord shapes and chord derivation (spec section 5).

use serde::{Deserialize, Serialize};

pub type Midi = u8;

/// The twelve pitch classes.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize, Hash)]
#[serde(rename_all = "UPPERCASE")]
pub enum PitchClass {
    #[default]
    C,
    #[serde(rename = "C#")]
    Cs,
    D,
    #[serde(rename = "D#")]
    Ds,
    E,
    F,
    #[serde(rename = "F#")]
    Fs,
    G,
    #[serde(rename = "G#")]
    Gs,
    A,
    #[serde(rename = "A#")]
    As,
    B,
}

pub const ALL_PITCH_CLASSES: [PitchClass; 12] = [
    PitchClass::C,
    PitchClass::Cs,
    PitchClass::D,
    PitchClass::Ds,
    PitchClass::E,
    PitchClass::F,
    PitchClass::Fs,
    PitchClass::G,
    PitchClass::Gs,
    PitchClass::A,
    PitchClass::As,
    PitchClass::B,
];

/// Circle of fifths order starting at C, clockwise.
pub const CIRCLE_OF_FIFTHS: [PitchClass; 12] = [
    PitchClass::C,
    PitchClass::G,
    PitchClass::D,
    PitchClass::A,
    PitchClass::E,
    PitchClass::B,
    PitchClass::Fs,
    PitchClass::Cs,
    PitchClass::Gs,
    PitchClass::Ds,
    PitchClass::As,
    PitchClass::F,
];

impl PitchClass {
    /// 0..11, C = 0.
    #[inline]
    pub fn index(self) -> u8 {
        self as u8
    }

    /// From any integer (wraps modulo 12).
    #[inline]
    pub fn from_index(i: i32) -> Self {
        ALL_PITCH_CLASSES[i.rem_euclid(12) as usize]
    }

    pub fn name(self) -> &'static str {
        match self {
            PitchClass::C => "C",
            PitchClass::Cs => "C#",
            PitchClass::D => "D",
            PitchClass::Ds => "D#",
            PitchClass::E => "E",
            PitchClass::F => "F",
            PitchClass::Fs => "F#",
            PitchClass::G => "G",
            PitchClass::Gs => "G#",
            PitchClass::A => "A",
            PitchClass::As => "A#",
            PitchClass::B => "B",
        }
    }

    /// Flat spelling (for minor keys and the HUD when preferred).
    pub fn flat_name(self) -> &'static str {
        match self {
            PitchClass::Cs => "Db",
            PitchClass::Ds => "Eb",
            PitchClass::Fs => "Gb",
            PitchClass::Gs => "Ab",
            PitchClass::As => "Bb",
            other => other.name(),
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let base = s.chars().next()?.to_ascii_uppercase();
        let mut idx: i32 = match base {
            'C' => 0,
            'D' => 2,
            'E' => 4,
            'F' => 5,
            'G' => 7,
            'A' => 9,
            'B' => 11,
            _ => return None,
        };
        for c in s.chars().skip(1) {
            match c {
                '#' => idx += 1,
                'b' | 'B' if s.len() > 1 => idx -= 1,
                _ => return None,
            }
        }
        Some(Self::from_index(idx))
    }

    /// Position on the circle of fifths, 0..11 (C = 0, G = 1, ...).
    pub fn fifths_index(self) -> u8 {
        (self.index() as u32 * 7 % 12) as u8
    }

    /// Step `n` places around the circle of fifths (positive = clockwise / sharp-wards).
    pub fn step_fifths(self, n: i32) -> Self {
        let pos = self.fifths_index() as i32 + n;
        CIRCLE_OF_FIFTHS[pos.rem_euclid(12) as usize]
    }

    /// Hue (degrees) for this pitch class on a 12-hue wheel, used by the renderer/chrome.
    pub fn hue(self) -> f32 {
        // Circle-of-fifths ordering gives smooth colour walks for I->V motion.
        self.fifths_index() as f32 * 30.0
    }
}

/// Global mode (natural minor).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Major,
    Minor,
}

impl Mode {
    /// Scale degree semitone offsets from the key root.
    pub fn scale(self) -> [i32; 7] {
        match self {
            Mode::Major => [0, 2, 4, 5, 7, 9, 11],
            Mode::Minor => [0, 2, 3, 5, 7, 8, 10],
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Mode::Major => "major",
            Mode::Minor => "minor",
        }
    }
}

/// Triad quality. `Diminished` only appears from the Scale-only left-hand
/// scheme (diatonic vii in major / ii in minor); the tilt gesture latches Major/Minor.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    #[default]
    Major,
    Minor,
    Diminished,
}

impl Quality {
    pub fn triad(self) -> [i32; 3] {
        match self {
            Quality::Major => [0, 4, 7],
            Quality::Minor => [0, 3, 7],
            Quality::Diminished => [0, 3, 6],
        }
    }
}

/// Right-hand chord shape.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Shape {
    #[default]
    Root,
    Inv1,
    Seventh,
    DomOrDim7,
}

impl Shape {
    pub fn from_finger_count(n: u8) -> Option<Shape> {
        match n {
            1 => Some(Shape::Root),
            2 => Some(Shape::Inv1),
            3 => Some(Shape::Seventh),
            4 => Some(Shape::DomOrDim7),
            _ => None,
        }
    }
}

/// What "4 fingers on a minor chord" means (spec open question; m7b5 default).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum MinorFourFinger {
    #[default]
    HalfDim7,
    Dim7,
}

/// Chord derivation settings that live in user settings.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct VoicingSettings {
    pub minor_four_finger: MinorFourFinger,
    /// Spread 3rd and 7th up an octave.
    pub open_voicing: bool,
}

/// Semitone offset of scale degree (1..7) in the given mode.
pub fn scale_degree_offset(degree: u8, mode: Mode) -> i32 {
    let d = degree.clamp(1, 7) as usize - 1;
    mode.scale()[d]
}

/// Diatonic triad quality of a degree in the given mode.
pub fn diatonic_quality(degree: u8, mode: Mode) -> Quality {
    let d = degree.clamp(1, 7);
    match mode {
        Mode::Major => match d {
            1 | 4 | 5 => Quality::Major,
            2 | 3 | 6 => Quality::Minor,
            _ => Quality::Diminished,
        },
        Mode::Minor => match d {
            1 | 4 | 5 => Quality::Minor,
            3 | 6 | 7 => Quality::Major,
            _ => Quality::Diminished,
        },
    }
}

/// Root MIDI note for a degree. Key roots sit in octave 3 (C3 = 48) so pads
/// sound full without mud; octave shifts move from there.
pub fn root_midi(key: PitchClass, mode: Mode, degree: u8, octave: i8) -> i32 {
    48 + key.index() as i32 + scale_degree_offset(degree, mode) + 12 * octave as i32
}

/// Interval pattern (semitones above root) for a quality + shape, before inversion.
fn base_intervals(quality: Quality, shape: Shape, settings: VoicingSettings) -> ([i32; 4], usize) {
    let t = quality.triad();
    match shape {
        Shape::Root | Shape::Inv1 => ([t[0], t[1], t[2], 0], 3),
        Shape::Seventh => {
            let seventh = match quality {
                Quality::Major => 11,
                Quality::Minor => 10,
                Quality::Diminished => 10, // half-diminished
            };
            ([t[0], t[1], t[2], seventh], 4)
        }
        Shape::DomOrDim7 => match quality {
            Quality::Major => ([0, 4, 7, 10], 4),
            Quality::Minor => match settings.minor_four_finger {
                MinorFourFinger::HalfDim7 => ([0, 3, 6, 10], 4),
                MinorFourFinger::Dim7 => ([0, 3, 6, 9], 4),
            },
            Quality::Diminished => ([0, 3, 6, 9], 4),
        },
    }
}

/// Derive the sounding notes (up to 4, ascending) of a chord.
///
/// * `Inv1` moves the root up an octave (first inversion).
/// * Open voicing spreads the 3rd and 7th up an octave.
/// * `octave` shifts everything by 12 per step.
pub fn chord_notes(
    key: PitchClass,
    mode: Mode,
    degree: u8,
    quality: Quality,
    shape: Shape,
    octave: i8,
    settings: VoicingSettings,
) -> ([Midi; 4], u8) {
    let root = root_midi(key, mode, degree, octave);
    let (iv, n) = base_intervals(quality, shape, settings);
    let mut notes = [0i32; 4];
    for i in 0..n {
        notes[i] = root + iv[i];
    }
    if shape == Shape::Inv1 {
        notes[0] += 12; // root up an octave
    }
    if settings.open_voicing {
        notes[1] += 12; // third
        if n == 4 {
            notes[3] += 12; // seventh
        }
    }
    let mut out = [0u8; 4];
    for i in 0..n {
        out[i] = notes[i].clamp(0, 127) as u8;
    }
    // ascending order keeps voice assignment stable across shapes
    out[..n].sort_unstable();
    (out, n as u8)
}

/// Roman numeral for a degree with quality casing: "IV", "ii", "vii°".
pub fn roman(degree: u8, quality: Quality) -> String {
    const R: [&str; 7] = ["I", "II", "III", "IV", "V", "VI", "VII"];
    let d = degree.clamp(1, 7) as usize - 1;
    match quality {
        Quality::Major => R[d].to_string(),
        Quality::Minor => R[d].to_ascii_lowercase(),
        Quality::Diminished => format!("{}\u{00B0}", R[d].to_ascii_lowercase()),
    }
}

/// Human chord name, e.g. "IV maj7 / 1st inv", "ii m7", "V dom7", "vii° m7b5".
pub fn chord_name(degree: u8, quality: Quality, shape: Shape, settings: VoicingSettings) -> String {
    let numeral = roman(degree, quality);
    let suffix = match (quality, shape) {
        (Quality::Major, Shape::Root) => "",
        (Quality::Major, Shape::Inv1) => " / 1st inv",
        (Quality::Major, Shape::Seventh) => " maj7",
        (Quality::Major, Shape::DomOrDim7) => " dom7",
        (Quality::Minor, Shape::Root) => " m",
        (Quality::Minor, Shape::Inv1) => " m / 1st inv",
        (Quality::Minor, Shape::Seventh) => " m7",
        (Quality::Minor, Shape::DomOrDim7) => match settings.minor_four_finger {
            MinorFourFinger::HalfDim7 => " m7b5",
            MinorFourFinger::Dim7 => " dim7",
        },
        (Quality::Diminished, Shape::Root) => " dim",
        (Quality::Diminished, Shape::Inv1) => " dim / 1st inv",
        (Quality::Diminished, Shape::Seventh) => " m7b5",
        (Quality::Diminished, Shape::DomOrDim7) => " dim7",
    };
    format!("{numeral}{suffix}")
}

/// Absolute chord label like "F maj7" for the given key.
pub fn absolute_chord_name(key: PitchClass, mode: Mode, degree: u8, quality: Quality, shape: Shape, settings: VoicingSettings) -> String {
    let root = PitchClass::from_index(key.index() as i32 + scale_degree_offset(degree, mode));
    let generic = chord_name(degree, quality, shape, settings);
    // strip the roman numeral, keep suffix
    let suffix = generic.trim_start_matches(|c: char| c.is_ascii_alphabetic() || c == '\u{00B0}');
    format!("{}{}", root.name(), suffix)
}

/// MIDI note -> frequency in Hz (A4 = 440).
#[inline]
pub fn midi_to_hz(midi: f32) -> f32 {
    440.0 * libm::exp2f((midi - 69.0) / 12.0)
}

/// Frequency -> fractional MIDI note.
#[inline]
pub fn hz_to_midi(hz: f32) -> f32 {
    69.0 + 12.0 * libm::log2f(hz.max(1e-3) / 440.0)
}

/// Note name with octave, e.g. 60 -> "C4".
pub fn note_name(midi: Midi) -> String {
    let pc = PitchClass::from_index(midi as i32 % 12);
    let oct = midi as i32 / 12 - 1;
    format!("{}{}", pc.name(), oct)
}

/// Snap a fractional MIDI value to the nearest scale tone of key/mode.
pub fn snap_to_scale(midi: f32, key: PitchClass, mode: Mode) -> f32 {
    let scale = mode.scale();
    let rel = midi - key.index() as f32;
    let oct = libm::floorf(rel / 12.0);
    let within = rel - oct * 12.0;
    let mut best = scale[0] as f32;
    let mut best_d = f32::MAX;
    for s in scale.iter().map(|s| *s as f32).chain(core::iter::once(12.0)) {
        let d = (s - within).abs();
        if d < best_d {
            best_d = d;
            best = s;
        }
    }
    key.index() as f32 + oct * 12.0 + best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c_major_triads() {
        let s = VoicingSettings::default();
        let (n, c) = chord_notes(PitchClass::C, Mode::Major, 1, Quality::Major, Shape::Root, 0, s);
        assert_eq!((&n[..c as usize], c), (&[48u8, 52, 55][..], 3));
        let (n, c) = chord_notes(PitchClass::C, Mode::Major, 4, Quality::Major, Shape::Seventh, 0, s);
        assert_eq!(&n[..c as usize], &[53, 57, 60, 64]); // F A C E
        let (n, _) = chord_notes(PitchClass::C, Mode::Major, 5, Quality::Major, Shape::DomOrDim7, 0, s);
        assert_eq!(&n[..4], &[55, 59, 62, 65]); // G B D F
    }

    #[test]
    fn inversion_moves_root_up() {
        let s = VoicingSettings::default();
        let (n, c) = chord_notes(PitchClass::C, Mode::Major, 1, Quality::Major, Shape::Inv1, 0, s);
        assert_eq!(&n[..c as usize], &[52, 55, 60]); // E G C
    }

    #[test]
    fn minor_four_finger_setting() {
        let mut s = VoicingSettings::default();
        let (n, _) = chord_notes(PitchClass::A, Mode::Minor, 1, Quality::Minor, Shape::DomOrDim7, 0, s);
        assert_eq!(&n[..4], &[57, 60, 63, 67]); // A C Eb G (m7b5)
        s.minor_four_finger = MinorFourFinger::Dim7;
        let (n, _) = chord_notes(PitchClass::A, Mode::Minor, 1, Quality::Minor, Shape::DomOrDim7, 0, s);
        assert_eq!(&n[..4], &[57, 60, 63, 66]); // dim7
    }

    #[test]
    fn octave_and_open_voicing() {
        let s = VoicingSettings { open_voicing: true, ..Default::default() };
        let (n, c) = chord_notes(PitchClass::C, Mode::Major, 1, Quality::Major, Shape::Root, 1, s);
        assert_eq!(&n[..c as usize], &[60, 67, 76]); // C4 G4 E5
    }

    #[test]
    fn names() {
        let s = VoicingSettings::default();
        assert_eq!(chord_name(4, Quality::Major, Shape::Seventh, s), "IV maj7");
        assert_eq!(chord_name(4, Quality::Major, Shape::Inv1, s), "IV / 1st inv");
        assert_eq!(chord_name(2, Quality::Minor, Shape::Seventh, s), "ii m7");
        assert_eq!(chord_name(7, Quality::Diminished, Shape::Root, s), "vii\u{00B0} dim");
        assert_eq!(absolute_chord_name(PitchClass::C, Mode::Major, 5, Quality::Major, Shape::DomOrDim7, s), "G dom7");
        assert_eq!(note_name(60), "C4");
    }

    #[test]
    fn circle_of_fifths_steps() {
        assert_eq!(PitchClass::C.step_fifths(1), PitchClass::G);
        assert_eq!(PitchClass::C.step_fifths(-1), PitchClass::F);
        assert_eq!(PitchClass::C.step_fifths(12), PitchClass::C);
        assert_eq!(PitchClass::parse("Bb"), Some(PitchClass::As));
        assert_eq!(PitchClass::parse("f#"), Some(PitchClass::Fs));
    }

    #[test]
    fn diatonic() {
        assert_eq!(diatonic_quality(7, Mode::Major), Quality::Diminished);
        assert_eq!(diatonic_quality(2, Mode::Major), Quality::Minor);
        assert_eq!(diatonic_quality(3, Mode::Minor), Quality::Major);
    }

    #[test]
    fn snap() {
        // 61.4 (C#-ish) in C major snaps to 61? no: nearest scale tone is 62 (D) or 60 (C); 61.4 -> 62
        assert_eq!(snap_to_scale(61.4, PitchClass::C, Mode::Major), 62.0);
        assert_eq!(snap_to_scale(60.6, PitchClass::C, Mode::Major), 60.0);
        assert!((midi_to_hz(69.0) - 440.0).abs() < 1e-3);
    }
}
