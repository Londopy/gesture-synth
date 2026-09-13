//! `.gsyn.json` file formats (spec section 10). All JSON, UTF-8, ASCII-safe.
//! Serialization is deterministic (struct field order, shortest float repr),
//! so a session saved in the browser is byte-identical to one saved on desktop.

use crate::gesture::{Calibration, LeftScheme, RightScheme};
use crate::instruments::Instrument;
use crate::looper::{LoopSettings, TimedEvent, Track, TRACKS};
use crate::music::{Mode, PitchClass, Quality, Shape, VoicingSettings};
use crate::state::{Event, MusicalState};
use crate::transport::{TimeSig, Transport};
use crate::FORMAT_VERSION;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct TransportSettings {
    pub bpm: f32,
    /// "4/4", "6/8", ...
    pub time_sig: String,
    pub bars: u8,
}

impl TransportSettings {
    pub fn from_transport(t: &Transport) -> Self {
        Self { bpm: t.bpm, time_sig: t.sig.label(), bars: t.bars }
    }

    pub fn apply(&self, t: &mut Transport) {
        t.set_bpm(self.bpm);
        if let Some(sig) = TimeSig::parse(&self.time_sig) {
            t.set_sig(sig);
        }
        t.set_bars(self.bars);
    }
}

/// session.gsyn.json
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct SessionFile {
    pub version: u32,
    #[serde(default)]
    pub name: String,
    pub transport: TransportSettings,
    pub key: PitchClass,
    pub mode: Mode,
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub instrument_presets: Vec<Instrument>,
    pub theme: String,
    pub calibration: Calibration,
    #[serde(default)]
    pub loop_settings: LoopSettings,
    #[serde(default)]
    pub voicing: VoicingSettings,
}

impl SessionFile {
    pub fn new(transport: &Transport, key: PitchClass, mode: Mode, tracks: Vec<Track>) -> Self {
        Self {
            version: FORMAT_VERSION,
            name: "Untitled session".into(),
            transport: TransportSettings::from_transport(transport),
            key,
            mode,
            tracks,
            instrument_presets: Vec::new(),
            theme: "Neon".into(),
            calibration: Calibration::default(),
            loop_settings: LoopSettings::default(),
            voicing: VoicingSettings::default(),
        }
    }

    pub fn to_json(&self) -> String {
        to_json(self)
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        let mut f: SessionFile = serde_json::from_str(s).map_err(|e| e.to_string())?;
        if f.version > FORMAT_VERSION {
            return Err(format!("session version {} is newer than this app ({})", f.version, FORMAT_VERSION));
        }
        f.tracks.truncate(TRACKS);
        Ok(f)
    }
}

/// One chord in a song (spec 10, song.gsyn.json).
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct SongChord {
    /// 1-based bar
    pub bar: u32,
    /// 1-based beat within the bar (fractional allowed)
    pub beat: f32,
    pub degree: u8,
    pub quality: Quality,
    #[serde(default)]
    pub shape: Shape,
    #[serde(default)]
    pub octave: i8,
    pub dur_beats: f32,
}

#[derive(Clone, Copy, PartialEq, Debug, Default, Serialize, Deserialize)]
pub struct SongHints {
    #[serde(default)]
    pub left_scheme: LeftScheme,
    #[serde(default)]
    pub right_scheme: RightScheme,
}

/// song.gsyn.json
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct SongFile {
    #[serde(default = "default_version")]
    pub version: u32,
    pub name: String,
    pub author: String,
    pub bpm: f32,
    pub time_sig: String,
    pub key: PitchClass,
    pub mode: Mode,
    pub bars: u8,
    pub chords: Vec<SongChord>,
    #[serde(default)]
    pub hints: SongHints,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub instrument: Option<String>,
}

fn default_version() -> u32 {
    FORMAT_VERSION
}

impl SongFile {
    pub fn to_json(&self) -> String {
        to_json(self)
    }

    pub fn from_json(s: &str) -> Result<Self, String> {
        let f: SongFile = serde_json::from_str(s).map_err(|e| e.to_string())?;
        f.validate()?;
        Ok(f)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !(40.0..=240.0).contains(&self.bpm) {
            return Err("bpm must be 40..240".into());
        }
        if TimeSig::parse(&self.time_sig).is_none() {
            return Err("bad time_sig".into());
        }
        if !(1..=16).contains(&self.bars) {
            return Err("bars must be 1..16".into());
        }
        for c in &self.chords {
            if !(1..=7).contains(&c.degree) {
                return Err(format!("chord degree {} out of range", c.degree));
            }
            if c.bar == 0 || c.bar as u8 > self.bars {
                return Err(format!("chord bar {} out of range", c.bar));
            }
        }
        Ok(())
    }

    /// Configure a transport for this song.
    pub fn transport(&self, sample_rate: f32) -> Transport {
        let mut t = Transport::new(sample_rate);
        t.set_bpm(self.bpm);
        if let Some(sig) = TimeSig::parse(&self.time_sig) {
            t.set_sig(sig);
        }
        t.set_bars(self.bars);
        t
    }

    /// Render the chord sequence into a loop track (Song Builder "drop into tracks").
    pub fn to_track(&self, index: usize, voicing: VoicingSettings) -> Track {
        let t = self.transport(crate::DEFAULT_SAMPLE_RATE);
        let mut track = Track::new(index);
        track.name = self.name.clone();
        if let Some(inst) = self.instrument.as_deref().and_then(Instrument::builtin) {
            track.instrument = inst;
        }
        let spb = t.samples_per_beat();
        let mut evs: Vec<TimedEvent> = Vec::new();
        let mut chords = self.chords.clone();
        chords.sort_by(|a, b| (a.bar, a.beat).partial_cmp(&(b.bar, b.beat)).unwrap());
        for c in &chords {
            let start_beats = (c.bar as f64 - 1.0) * self.sig_beats() as f64 + (c.beat as f64 - 1.0);
            let t_on = (start_beats * spb).round() as u64;
            let t_off = ((start_beats + c.dur_beats as f64) * spb).round() as u64;
            let mut st = MusicalState { key: self.key, mode: self.mode, degree: c.degree, quality: c.quality, shape: c.shape, octave: c.octave, ..Default::default() };
            st.derive_notes(voicing);
            evs.push(TimedEvent { t: t_on, event: Event::chord_on_from(&st) });
            if t_off < t.loop_len() {
                evs.push(TimedEvent { t: t_off, event: Event::ChordOff });
            }
        }
        evs.sort_by_key(|e| e.t);
        // drop a ChordOff that coincides with the next ChordOn
        let mut cleaned: Vec<TimedEvent> = Vec::with_capacity(evs.len());
        for e in evs {
            if let Some(last) = cleaned.last() {
                if last.t == e.t && matches!(last.event, Event::ChordOff) && e.event.is_chord_on() {
                    cleaned.pop();
                }
            }
            cleaned.push(e);
        }
        track.events = cleaned;
        track
    }

    fn sig_beats(&self) -> u8 {
        TimeSig::parse(&self.time_sig).map(|s| s.beats).unwrap_or(4)
    }

    /// Parse a progression typed as roman numerals or absolute chords, one chord
    /// per bar by default ("I V vi IV", "C G Am F", "ii7 V7 Imaj7"). Returns chords.
    pub fn parse_progression(text: &str, key: PitchClass, mode: Mode, beats_per_bar: u8, chords_per_bar: u8) -> Result<Vec<SongChord>, String> {
        let cpb = chords_per_bar.max(1) as f32;
        let dur = beats_per_bar as f32 / cpb;
        let mut out = Vec::new();
        for (i, tok) in text.split(|c: char| c.is_whitespace() || c == '|' || c == ',' || c == '-').filter(|t| !t.is_empty()).enumerate() {
            let (degree, quality, shape) = parse_chord_token(tok, key, mode)?;
            let bar = (i as f32 / cpb).floor() as u32 + 1;
            let beat = (i as f32 % cpb) * dur + 1.0;
            out.push(SongChord { bar, beat, degree, quality, shape, octave: 0, dur_beats: dur });
        }
        Ok(out)
    }
}

/// Parse one chord token: roman ("IV", "ii", "V7", "IVmaj7", "vii°", "viio") or
/// absolute ("F", "Dm", "G7", "Cmaj7", "Bdim").
pub fn parse_chord_token(tok: &str, key: PitchClass, mode: Mode) -> Result<(u8, Quality, Shape), String> {
    let t = tok.trim();
    let romans = ["vii", "iii", "vi", "iv", "ii", "v", "i"];
    let lower = t.to_ascii_lowercase();
    for r in romans {
        if lower.starts_with(r) {
            let rest = &t[r.len()..];
            let is_upper = t[..r.len()].chars().all(|c| c.is_ascii_uppercase());
            let degree = match r {
                "i" => 1,
                "ii" => 2,
                "iii" => 3,
                "iv" => 4,
                "v" => 5,
                "vi" => 6,
                _ => 7,
            };
            let mut quality = if is_upper { Quality::Major } else { Quality::Minor };
            let (shape, q2) = parse_suffix(rest, quality)?;
            if let Some(q) = q2 {
                quality = q;
            }
            return Ok((degree, quality, shape));
        }
    }
    // absolute
    let root_len = if t.len() >= 2 && matches!(&t[1..2], "#" | "b") { 2 } else { 1 };
    let root = PitchClass::parse(&t[..root_len.min(t.len())]).ok_or_else(|| format!("bad chord '{tok}'"))?;
    let rest = &t[root_len.min(t.len())..];
    let (rest, mut quality) = if let Some(r) = rest.strip_prefix('m').filter(|r| !r.starts_with("aj")) {
        (r, Quality::Minor)
    } else {
        (rest, Quality::Major)
    };
    let (shape, q2) = parse_suffix(rest, quality)?;
    if let Some(q) = q2 {
        quality = q;
    }
    // degree from root relative to key
    let semis = (root.index() as i32 - key.index() as i32).rem_euclid(12);
    let degree = mode.scale().iter().position(|s| *s == semis).map(|d| d as u8 + 1).ok_or_else(|| format!("'{tok}' is not diatonic in {} {}", key.name(), mode.name()))?;
    Ok((degree, quality, shape))
}

fn parse_suffix(s: &str, q: Quality) -> Result<(Shape, Option<Quality>), String> {
    let s = s.trim().to_ascii_lowercase();
    Ok(match s.as_str() {
        "" => (Shape::Root, None),
        "maj7" | "ma7" | "m7" if q == Quality::Major && s != "m7" => (Shape::Seventh, None),
        "m7" if q == Quality::Minor => (Shape::Seventh, None),
        "m7" => (Shape::Seventh, Some(Quality::Minor)),
        "7" => (if q == Quality::Minor { Shape::Seventh } else { Shape::DomOrDim7 }, None),
        "dom7" => (Shape::DomOrDim7, None),
        "m7b5" | "ø" | "ø7" => (Shape::Seventh, Some(Quality::Diminished)),
        "dim" | "°" | "o" => (Shape::Root, Some(Quality::Diminished)),
        "dim7" | "°7" | "o7" => (Shape::DomOrDim7, Some(Quality::Diminished)),
        "/1" | "inv" | "/3" => (Shape::Inv1, None),
        other => return Err(format!("unknown chord suffix '{other}'")),
    })
}

/// theme.gsyn.json
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct ThemeFile {
    #[serde(default = "default_version")]
    pub version: u32,
    pub name: String,
    pub palette: BTreeMap<String, String>,
    pub particle_density: f32,
    pub bloom: bool,
    pub haze_strength: f32,
    pub ghost_opacity: f32,
    pub background_style: String,
}

impl ThemeFile {
    pub fn to_json(&self) -> String {
        to_json(self)
    }
}

/// Deterministic pretty JSON (2-space indent, struct order, shortest floats, ASCII only).
pub fn to_json<T: Serialize>(v: &T) -> String {
    let s = serde_json::to_string_pretty(v).unwrap_or_default();
    // escape any non-ASCII so the file is ASCII-safe (spec 10)
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut buf = [0u16; 2];
            for u in c.encode_utf16(&mut buf) {
                out.push_str(&format!("\\u{:04x}", u));
            }
        }
    }
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_roundtrip_is_byte_stable() {
        let t = Transport::new(48_000.0);
        let tracks: Vec<Track> = (0..4).map(Track::new).collect();
        let s = SessionFile::new(&t, PitchClass::D, Mode::Minor, tracks);
        let j1 = s.to_json();
        let back = SessionFile::from_json(&j1).unwrap();
        let j2 = back.to_json();
        assert_eq!(j1, j2);
        assert!(j1.is_ascii());
        assert_eq!(back.key, PitchClass::D);
    }

    #[test]
    fn song_to_track_and_parse() {
        let chords = SongFile::parse_progression("I V vi IV", PitchClass::C, Mode::Major, 4, 1).unwrap();
        assert_eq!(chords.len(), 4);
        assert_eq!(chords[2].degree, 6);
        assert_eq!(chords[2].quality, Quality::Minor);
        assert_eq!(chords[3].bar, 4);
        let song = SongFile { version: 1, name: "Test".into(), author: "me".into(), bpm: 120.0, time_sig: "4/4".into(), key: PitchClass::C, mode: Mode::Major, bars: 4, chords, hints: Default::default(), tags: vec![], instrument: Some("Pad".into()) };
        song.validate().unwrap();
        let track = song.to_track(0, VoicingSettings::default());
        assert_eq!(track.events.len(), 4, "consecutive chords: offs merged into ons");
        assert_eq!(track.events[1].t, 96_000);
        let j = song.to_json();
        let back = SongFile::from_json(&j).unwrap();
        assert_eq!(back.chords.len(), 4);
    }

    #[test]
    fn chord_tokens() {
        assert_eq!(parse_chord_token("IVmaj7", PitchClass::C, Mode::Major).unwrap(), (4, Quality::Major, Shape::Seventh));
        assert_eq!(parse_chord_token("V7", PitchClass::C, Mode::Major).unwrap(), (5, Quality::Major, Shape::DomOrDim7));
        assert_eq!(parse_chord_token("ii7", PitchClass::C, Mode::Major).unwrap(), (2, Quality::Minor, Shape::Seventh));
        assert_eq!(parse_chord_token("Am", PitchClass::C, Mode::Major).unwrap(), (6, Quality::Minor, Shape::Root));
        assert_eq!(parse_chord_token("G7", PitchClass::C, Mode::Major).unwrap(), (5, Quality::Major, Shape::DomOrDim7));
        assert_eq!(parse_chord_token("Bdim", PitchClass::C, Mode::Major).unwrap(), (7, Quality::Diminished, Shape::Root));
        assert_eq!(parse_chord_token("Bb", PitchClass::F, Mode::Major).unwrap(), (4, Quality::Major, Shape::Root));
        assert!(parse_chord_token("C#", PitchClass::C, Mode::Major).is_err());
    }
}
