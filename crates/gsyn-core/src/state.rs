//! The musical state model (spec section 5) and one-shot events.
//!
//! `MusicalState` is `Copy` and allocation free so it can travel through the
//! lock-free triple buffer to the audio thread and across the WASM boundary as
//! a flat `[f32; STATE_FLOATS]`. Derived strings (chord name) are computed on
//! demand by the UI side.

use crate::music::{self, Midi, Mode, PitchClass, Quality, Shape, VoicingSettings};
use serde::{Deserialize, Serialize};

/// Number of f32 slots in the flat encoding.
pub const STATE_FLOATS: usize = 24;

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct MusicalState {
    pub key: PitchClass,
    pub mode: Mode,
    /// 1..7, or 0 for "no chord" (mute / released).
    pub degree: u8,
    pub quality: Quality,
    pub shape: Shape,
    /// -1, 0, +1
    pub octave: i8,
    pub cutoff: f32,
    pub volume: f32,
    pub pan: f32,
    pub arp: bool,
    pub arp_rate: f32,
    pub latched: bool,
    pub theremin: bool,
    pub theremin_pitch_hz: f32,
    pub theremin_volume: f32,
    pub theremin_vibrato: f32,
    /// Derived sounding notes (ascending), valid for `note_count` entries.
    pub notes: [Midi; 4],
    pub note_count: u8,
    /// Tracking confidence 0..1 (for the HUD meter).
    pub confidence: f32,
}

impl Default for MusicalState {
    fn default() -> Self {
        Self {
            key: PitchClass::C,
            mode: Mode::Major,
            degree: 0,
            quality: Quality::Major,
            shape: Shape::Root,
            octave: 0,
            cutoff: 0.7,
            volume: 0.0,
            pan: 0.0,
            arp: false,
            arp_rate: 0.5,
            latched: false,
            theremin: false,
            theremin_pitch_hz: 220.0,
            theremin_volume: 0.0,
            theremin_vibrato: 0.0,
            notes: [0; 4],
            note_count: 0,
            confidence: 0.0,
        }
    }
}

impl MusicalState {
    /// Currently sounding notes.
    #[inline]
    pub fn notes(&self) -> &[Midi] {
        &self.notes[..self.note_count as usize]
    }

    /// True when a chord is selected (degree 1..7) and not muted.
    #[inline]
    pub fn has_chord(&self) -> bool {
        self.degree >= 1 && self.degree <= 7 && self.note_count > 0
    }

    /// Recompute `notes`/`note_count` from the discrete fields.
    pub fn derive_notes(&mut self, voicing: VoicingSettings) {
        if (1..=7).contains(&self.degree) {
            let (n, c) = music::chord_notes(
                self.key,
                self.mode,
                self.degree,
                self.quality,
                self.shape,
                self.octave,
                voicing,
            );
            self.notes = n;
            self.note_count = c;
        } else {
            self.notes = [0; 4];
            self.note_count = 0;
        }
    }

    /// "IV maj7 / 1st inv" or "" when no chord.
    pub fn chord_name(&self, voicing: VoicingSettings) -> String {
        if (1..=7).contains(&self.degree) {
            music::chord_name(self.degree, self.quality, self.shape, voicing)
        } else {
            String::new()
        }
    }

    /// Bass note of the current chord (root, one octave below the lowest voice).
    pub fn bass_note(&self) -> Option<Midi> {
        if !self.has_chord() {
            return None;
        }
        let root = music::root_midi(self.key, self.mode, self.degree, self.octave);
        Some((root - 12).clamp(0, 127) as Midi)
    }

    /// Whether the discrete (debounced) part differs from `other`.
    pub fn discrete_differs(&self, other: &MusicalState) -> bool {
        self.key != other.key
            || self.mode != other.mode
            || self.degree != other.degree
            || self.quality != other.quality
            || self.shape != other.shape
            || self.octave != other.octave
    }

    /// Flat encoding for SharedArrayBuffer / postMessage transport.
    pub fn to_floats(&self, out: &mut [f32; STATE_FLOATS]) {
        out[0] = self.key.index() as f32;
        out[1] = if self.mode == Mode::Minor { 1.0 } else { 0.0 };
        out[2] = self.degree as f32;
        out[3] = match self.quality {
            Quality::Major => 0.0,
            Quality::Minor => 1.0,
            Quality::Diminished => 2.0,
        };
        out[4] = match self.shape {
            Shape::Root => 0.0,
            Shape::Inv1 => 1.0,
            Shape::Seventh => 2.0,
            Shape::DomOrDim7 => 3.0,
        };
        out[5] = self.octave as f32;
        out[6] = self.cutoff;
        out[7] = self.volume;
        out[8] = self.pan;
        out[9] = if self.arp { 1.0 } else { 0.0 };
        out[10] = self.arp_rate;
        out[11] = if self.latched { 1.0 } else { 0.0 };
        out[12] = if self.theremin { 1.0 } else { 0.0 };
        out[13] = self.theremin_pitch_hz;
        out[14] = self.theremin_volume;
        out[15] = self.theremin_vibrato;
        out[16] = self.note_count as f32;
        out[17] = self.notes[0] as f32;
        out[18] = self.notes[1] as f32;
        out[19] = self.notes[2] as f32;
        out[20] = self.notes[3] as f32;
        out[21] = self.confidence;
        out[22] = 0.0;
        out[23] = 0.0;
    }

    pub fn from_floats(f: &[f32]) -> Self {
        let g = |i: usize| f.get(i).copied().unwrap_or(0.0);
        let mut s = MusicalState {
            key: PitchClass::from_index(g(0) as i32),
            mode: if g(1) >= 0.5 {
                Mode::Minor
            } else {
                Mode::Major
            },
            degree: g(2).clamp(0.0, 7.0) as u8,
            quality: match g(3) as i32 {
                1 => Quality::Minor,
                2 => Quality::Diminished,
                _ => Quality::Major,
            },
            shape: match g(4) as i32 {
                1 => Shape::Inv1,
                2 => Shape::Seventh,
                3 => Shape::DomOrDim7,
                _ => Shape::Root,
            },
            octave: g(5).clamp(-1.0, 1.0) as i8,
            cutoff: g(6).clamp(0.0, 1.0),
            volume: g(7).clamp(0.0, 1.0),
            pan: g(8).clamp(-1.0, 1.0),
            arp: g(9) >= 0.5,
            arp_rate: g(10).clamp(0.0, 1.0),
            latched: g(11) >= 0.5,
            theremin: g(12) >= 0.5,
            theremin_pitch_hz: g(13),
            theremin_volume: g(14).clamp(0.0, 1.0),
            theremin_vibrato: g(15).clamp(0.0, 1.0),
            notes: [0; 4],
            note_count: g(16).clamp(0.0, 4.0) as u8,
            confidence: g(21).clamp(0.0, 1.0),
        };
        for i in 0..4 {
            s.notes[i] = g(17 + i).clamp(0.0, 127.0) as u8;
        }
        s
    }
}

/// One-shot events emitted by the parser / loop engine, consumed by the synth,
/// the loop recorder, MIDI out and the renderer.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    ChordOn {
        notes: [Midi; 4],
        count: u8,
        degree: u8,
        quality: Quality,
        shape: Shape,
        octave: i8,
    },
    ChordOff,
    ParamChange {
        cutoff: f32,
        volume: f32,
        pan: f32,
    },
    ArpToggle {
        on: bool,
    },
    KeyChange {
        key: PitchClass,
        mode: Mode,
    },
    BassHit {
        note: Midi,
    },
    Latch {
        on: bool,
    },
}

/// Number of f32 slots in the flat event encoding.
pub const EVENT_FLOATS: usize = 8;

impl Event {
    /// Flat encoding: [type, a, b, c, d, e, f, g].
    pub fn to_floats(&self, out: &mut [f32]) {
        out[..EVENT_FLOATS].iter_mut().for_each(|v| *v = 0.0);
        match self {
            Event::ChordOn {
                notes,
                count,
                degree,
                quality,
                shape,
                octave,
            } => {
                out[0] = 1.0;
                out[1] = *count as f32;
                out[2] = notes[0] as f32 + 128.0 * notes[1] as f32;
                out[3] = notes[2] as f32 + 128.0 * notes[3] as f32;
                out[4] = *degree as f32;
                out[5] = match quality {
                    Quality::Major => 0.0,
                    Quality::Minor => 1.0,
                    Quality::Diminished => 2.0,
                };
                out[6] = match shape {
                    Shape::Root => 0.0,
                    Shape::Inv1 => 1.0,
                    Shape::Seventh => 2.0,
                    Shape::DomOrDim7 => 3.0,
                };
                out[7] = *octave as f32;
            }
            Event::ChordOff => out[0] = 2.0,
            Event::ParamChange {
                cutoff,
                volume,
                pan,
            } => {
                out[0] = 3.0;
                out[1] = *cutoff;
                out[2] = *volume;
                out[3] = *pan;
            }
            Event::ArpToggle { on } => {
                out[0] = 4.0;
                out[1] = if *on { 1.0 } else { 0.0 };
            }
            Event::KeyChange { key, mode } => {
                out[0] = 5.0;
                out[1] = key.index() as f32;
                out[2] = if *mode == Mode::Minor { 1.0 } else { 0.0 };
            }
            Event::BassHit { note } => {
                out[0] = 6.0;
                out[1] = *note as f32;
            }
            Event::Latch { on } => {
                out[0] = 7.0;
                out[1] = if *on { 1.0 } else { 0.0 };
            }
        }
    }

    pub fn from_floats(f: &[f32]) -> Option<Event> {
        let g = |i: usize| f.get(i).copied().unwrap_or(0.0);
        Some(match g(0) as i32 {
            1 => {
                let n01 = g(2) as u32;
                let n23 = g(3) as u32;
                Event::ChordOn {
                    notes: [
                        (n01 % 128) as u8,
                        (n01 / 128) as u8,
                        (n23 % 128) as u8,
                        (n23 / 128) as u8,
                    ],
                    count: g(1).clamp(0.0, 4.0) as u8,
                    degree: g(4).clamp(0.0, 7.0) as u8,
                    quality: match g(5) as i32 {
                        1 => Quality::Minor,
                        2 => Quality::Diminished,
                        _ => Quality::Major,
                    },
                    shape: match g(6) as i32 {
                        1 => Shape::Inv1,
                        2 => Shape::Seventh,
                        3 => Shape::DomOrDim7,
                        _ => Shape::Root,
                    },
                    octave: g(7).clamp(-1.0, 1.0) as i8,
                }
            }
            2 => Event::ChordOff,
            3 => Event::ParamChange {
                cutoff: g(1),
                volume: g(2),
                pan: g(3),
            },
            4 => Event::ArpToggle { on: g(1) >= 0.5 },
            5 => Event::KeyChange {
                key: PitchClass::from_index(g(1) as i32),
                mode: if g(2) >= 0.5 {
                    Mode::Minor
                } else {
                    Mode::Major
                },
            },
            6 => Event::BassHit {
                note: g(1).clamp(0.0, 127.0) as u8,
            },
            7 => Event::Latch { on: g(1) >= 0.5 },
            _ => return None,
        })
    }

    pub fn chord_on_from(state: &MusicalState) -> Event {
        Event::ChordOn {
            notes: state.notes,
            count: state.note_count,
            degree: state.degree,
            quality: state.quality,
            shape: state.shape,
            octave: state.octave,
        }
    }

    pub fn is_chord_on(&self) -> bool {
        matches!(self, Event::ChordOn { .. })
    }
}

/// Fixed-capacity event list for the audio thread (no allocation).
#[derive(Clone, Copy, Debug)]
pub struct EventList {
    items: [Event; 32],
    len: usize,
}

impl Default for EventList {
    fn default() -> Self {
        Self {
            items: [Event::ChordOff; 32],
            len: 0,
        }
    }
}

impl EventList {
    pub fn new() -> Self {
        Self::default()
    }

    #[inline]
    pub fn push(&mut self, e: Event) -> bool {
        if self.len < self.items.len() {
            self.items[self.len] = e;
            self.len += 1;
            true
        } else {
            false
        }
    }

    #[inline]
    pub fn as_slice(&self) -> &[Event] {
        &self.items[..self.len]
    }

    #[inline]
    pub fn clear(&mut self) {
        self.len = 0;
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_roundtrip() {
        let mut s = MusicalState {
            degree: 4,
            quality: Quality::Minor,
            shape: Shape::Seventh,
            octave: -1,
            cutoff: 0.3,
            volume: 0.9,
            ..Default::default()
        };
        s.derive_notes(VoicingSettings::default());
        let mut f = [0f32; STATE_FLOATS];
        s.to_floats(&mut f);
        let back = MusicalState::from_floats(&f);
        assert_eq!(s, back);
        assert_eq!(s.chord_name(VoicingSettings::default()), "iv m7");
        assert_eq!(s.bass_note(), Some(48 + 5 - 12 - 12));
    }

    #[test]
    fn event_list_caps() {
        let mut l = EventList::new();
        for _ in 0..40 {
            l.push(Event::ChordOff);
        }
        assert_eq!(l.len(), 32);
        l.clear();
        assert!(l.is_empty());
    }
}
