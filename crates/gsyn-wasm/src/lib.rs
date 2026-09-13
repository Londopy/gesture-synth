//! wasm-bindgen surface of gsyn-core for the browser build.
//!
//! Two objects:
//! * [`WasmParser`] runs on the main thread next to MediaPipe. Landmarks in,
//!   flat `MusicalState` floats + flat events out (no strings per frame).
//! * [`WasmEngine`] runs inside the AudioWorkletProcessor. It receives the
//!   parser's flat floats, renders audio, and owns transport + loop engine.
//!
//! Everything crossing the boundary per frame/block is a typed array; JSON is
//! only used for UI-rate calls (sessions, grids, settings).

use gsyn_core::engine::{wav_from_f32, Engine, EngineCommand};
use gsyn_core::gesture::{synth_hand, GestureParser, HandFrame, Handedness, ParserConfig};
use gsyn_core::instruments::Instrument;
use gsyn_core::midi::tracks_to_smf;
use gsyn_core::music::{self, Mode, PitchClass, Quality, Shape, VoicingSettings};
use gsyn_core::session::{SessionFile, SongFile};
use gsyn_core::state::{Event, MusicalState, EVENT_FLOATS, STATE_FLOATS};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    // nothing: panics abort (profile), no console hook to keep the worklet lean
}

#[wasm_bindgen]
pub fn core_version() -> String {
    gsyn_core::version().to_string()
}

#[wasm_bindgen]
pub fn kernel_name() -> String {
    gsyn_core::synth::kernel::kernel_name().to_string()
}

#[wasm_bindgen]
pub fn state_floats_len() -> usize {
    STATE_FLOATS
}

#[wasm_bindgen]
pub fn event_floats_len() -> usize {
    EVENT_FLOATS
}

// ---------------------------------------------------------------------------
// Parser (main thread)
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct WasmParser {
    inner: GestureParser,
    hands: Vec<HandFrame>,
}

#[wasm_bindgen]
impl WasmParser {
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: Option<String>) -> Result<WasmParser, JsValue> {
        let cfg = match config_json {
            Some(j) => serde_json::from_str::<ParserConfig>(&j)
                .map_err(|e| JsValue::from_str(&e.to_string()))?,
            None => ParserConfig::default(),
        };
        Ok(Self {
            inner: GestureParser::new(cfg),
            hands: Vec::with_capacity(2),
        })
    }

    pub fn set_config(&mut self, config_json: &str) -> Result<(), JsValue> {
        let cfg: ParserConfig =
            serde_json::from_str(config_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.inner.set_config(cfg);
        Ok(())
    }

    pub fn config_json(&self) -> String {
        serde_json::to_string(&self.inner.cfg).unwrap_or_default()
    }

    /// Feed one frame. `landmarks`: hands*63 floats (x,y,z per landmark);
    /// `handedness`: per hand 0 = tracker says Left, 1 = Right; `confidence` per hand.
    pub fn feed(&mut self, landmarks: &[f32], handedness: &[u8], confidence: &[f32], t_ms: f64) {
        self.hands.clear();
        let n = (landmarks.len() / 63)
            .min(handedness.len())
            .min(confidence.len())
            .min(2);
        for h in 0..n {
            let mut lm = [[0f32; 3]; 21];
            for i in 0..21 {
                let b = h * 63 + i * 3;
                lm[i] = [landmarks[b], landmarks[b + 1], landmarks[b + 2]];
            }
            self.hands.push(HandFrame {
                landmarks: lm,
                handedness: if handedness[h] == 0 {
                    Handedness::Left
                } else {
                    Handedness::Right
                },
                confidence: confidence[h],
            });
        }
        let hands = core::mem::take(&mut self.hands);
        self.inner.feed(&hands, t_ms);
        self.hands = hands;
    }

    /// Write the current state into `out` (length >= STATE_FLOATS).
    pub fn state_into(&self, out: &mut [f32]) {
        if out.len() >= STATE_FLOATS {
            let mut buf = [0f32; STATE_FLOATS];
            self.inner.state().to_floats(&mut buf);
            out[..STATE_FLOATS].copy_from_slice(&buf);
        }
    }

    /// Write this frame's events into `out` (EVENT_FLOATS each). Returns the count.
    pub fn events_into(&self, out: &mut [f32]) -> usize {
        let evs = self.inner.events();
        let cap = out.len() / EVENT_FLOATS;
        let n = evs.len().min(cap);
        for (i, e) in evs.iter().take(n).enumerate() {
            e.to_floats(&mut out[i * EVENT_FLOATS..(i + 1) * EVENT_FLOATS]);
        }
        n
    }

    pub fn state_json(&self) -> String {
        serde_json::to_string(self.inner.state()).unwrap_or_default()
    }

    pub fn events_json(&self) -> String {
        serde_json::to_string(self.inner.events()).unwrap_or_default()
    }

    pub fn hands_json(&self) -> String {
        serde_json::to_string(&(self.inner.left_info(), self.inner.right_info()))
            .unwrap_or_default()
    }

    pub fn chord_name(&self) -> String {
        self.inner.state().chord_name(self.inner.cfg.voicing)
    }

    pub fn absolute_chord_name(&self) -> String {
        let s = self.inner.state();
        if s.has_chord() {
            music::absolute_chord_name(
                s.key,
                s.mode,
                s.degree,
                s.quality,
                s.shape,
                self.inner.cfg.voicing,
            )
        } else {
            String::new()
        }
    }

    pub fn set_key(&mut self, key_index: i32, minor: bool) {
        self.inner.set_key(
            PitchClass::from_index(key_index),
            if minor { Mode::Minor } else { Mode::Major },
        );
    }

    pub fn step_key(&mut self, n: i32) {
        self.inner.step_key_fifths(n);
    }

    pub fn set_fixed_degree(&mut self, degree: u8) {
        self.inner.set_fixed_degree(degree);
    }

    pub fn set_arp(&mut self, on: bool) {
        self.inner.set_arp(on);
    }

    pub fn all_off(&mut self) {
        self.inner.all_off();
    }
}

// ---------------------------------------------------------------------------
// Engine (AudioWorklet)
// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct WasmEngine {
    inner: Engine,
    events: Vec<Event>,
}

#[wasm_bindgen]
impl WasmEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> WasmEngine {
        Self {
            inner: Engine::new(sample_rate),
            events: Vec::with_capacity(32),
        }
    }

    /// Latest live state (STATE_FLOATS) and events (n * EVENT_FLOATS).
    pub fn set_live(&mut self, state: &[f32], events: &[f32]) {
        let st = MusicalState::from_floats(state);
        self.events.clear();
        for chunk in events.chunks_exact(EVENT_FLOATS) {
            if let Some(e) = Event::from_floats(chunk) {
                self.events.push(e);
            }
        }
        let evs = core::mem::take(&mut self.events);
        self.inner.set_live(st, &evs);
        self.events = evs;
    }

    /// Render a block. All three buffers must have the same length.
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32], cue: &mut [f32]) {
        self.inner.process(out_l, out_r, cue);
    }

    pub fn command(&mut self, cmd_json: &str) -> Result<(), JsValue> {
        let cmd: EngineCommand =
            serde_json::from_str(cmd_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.inner.command(cmd);
        Ok(())
    }

    /// Position info as flat floats (see `POSITION_FIELDS` in TS):
    /// [state, bar, beat, step, phase, bpm, beats, unit, bars, count_in(-1 none),
    ///  loop_count, recording(0 idle,1 armed,2 rec), rec_track(-1), selected,
    ///  position, loop_len, now_lo, now_hi, last_beat, last_beat_bar, beat_seq]
    pub fn position_into(&self, out: &mut [f32]) {
        let p = self.inner.position();
        if out.len() < 21 {
            return;
        }
        out[0] = match p.state {
            gsyn_core::transport::TransportState::Stopped => 0.0,
            gsyn_core::transport::TransportState::CountIn => 1.0,
            gsyn_core::transport::TransportState::Playing => 2.0,
        };
        out[1] = p.bar as f32;
        out[2] = p.beat as f32;
        out[3] = p.step as f32;
        out[4] = p.phase;
        out[5] = p.bpm;
        out[6] = p.beats as f32;
        out[7] = p.unit as f32;
        out[8] = p.bars as f32;
        out[9] = p.count_in.map(|c| c as f32).unwrap_or(-1.0);
        out[10] = p.loop_count as f32;
        out[11] = match p.recording {
            gsyn_core::looper::RecordStatus::Idle => 0.0,
            gsyn_core::looper::RecordStatus::Armed => 1.0,
            gsyn_core::looper::RecordStatus::Recording => 2.0,
        };
        out[12] = p.rec_track.map(|t| t as f32).unwrap_or(-1.0);
        out[13] = p.selected as f32;
        out[14] = p.position as f32;
        out[15] = p.loop_len as f32;
        out[16] = (p.now % (1 << 24)) as f32;
        out[17] = (p.now >> 24) as f32;
        out[18] = p.last_beat as f32;
        out[19] = if p.last_beat_was_bar_start { 1.0 } else { 0.0 };
        out[20] = p.beat_seq as f32;
    }

    pub fn position_json(&self) -> String {
        serde_json::to_string(&self.inner.position()).unwrap_or_default()
    }

    /// State of loop track `track` (what it is sounding right now) as STATE_FLOATS.
    pub fn track_state_into(&self, track: usize, out: &mut [f32]) {
        if out.len() >= STATE_FLOATS {
            let mut buf = [0f32; STATE_FLOATS];
            self.inner.track_state(track).to_floats(&mut buf);
            out[..STATE_FLOATS].copy_from_slice(&buf);
        }
    }

    /// Live-slot events applied since the last call (after quantization), flat.
    pub fn take_ui_events_into(&mut self, out: &mut [f32]) -> usize {
        let evs = self.inner.take_ui_events();
        let cap = out.len() / EVENT_FLOATS;
        let n = evs.len().min(cap);
        for (i, e) in evs.as_slice().iter().take(n).enumerate() {
            e.to_floats(&mut out[i * EVENT_FLOATS..(i + 1) * EVENT_FLOATS]);
        }
        n
    }

    /// Pending MIDI bytes (3 per message).
    pub fn drain_midi(&mut self) -> Vec<u8> {
        let mut v = Vec::new();
        for m in self.inner.drain_midi() {
            v.extend_from_slice(&m);
        }
        v
    }

    pub fn set_track_instrument(
        &mut self,
        track: usize,
        instrument_json: &str,
    ) -> Result<(), JsValue> {
        let inst: Instrument =
            serde_json::from_str(instrument_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.inner.set_track_instrument(track, inst);
        Ok(())
    }

    pub fn set_theremin_instrument(&mut self, instrument_json: &str) -> Result<(), JsValue> {
        let inst: Instrument =
            serde_json::from_str(instrument_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.inner.set_theremin_instrument(inst);
        Ok(())
    }

    pub fn settings_json(&self) -> String {
        serde_json::to_string(&self.inner.settings).unwrap_or_default()
    }

    pub fn set_settings(&mut self, json: &str) -> Result<(), JsValue> {
        let s = serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.inner.settings = s;
        self.inner.synth.metronome.volume = self.inner.settings.metronome_volume;
        self.inner.synth.metronome.enabled = self.inner.settings.metronome_enabled;
        self.inner.synth.master.reverb_enabled = self.inner.settings.reverb_enabled;
        self.inner.synth.master.delay_enabled = self.inner.settings.delay_enabled;
        Ok(())
    }

    /// Beat grid: rows = tracks, cells = chord or null; plus per-track mutes.
    pub fn grid_json(&self) -> String {
        let g = self.inner.looper.grid(&self.inner.transport);
        let mutes: Vec<Vec<bool>> = self
            .inner
            .looper
            .tracks
            .iter()
            .map(|t| {
                let steps = t.steps(&self.inner.transport);
                (0..steps).map(|s| t.step_muted(s)).collect()
            })
            .collect();
        serde_json::to_string(&serde_json::json!({ "cells": g, "mutes": mutes, "steps_per_bar": self.inner.transport.sig.steps_per_bar() })).unwrap_or_default()
    }

    /// Replace the chord at a grid cell.
    pub fn replace_chord(
        &mut self,
        track: usize,
        step: usize,
        degree: u8,
        quality: u8,
        shape: u8,
        octave: i8,
    ) {
        let quality = match quality {
            1 => Quality::Minor,
            2 => Quality::Diminished,
            _ => Quality::Major,
        };
        let shape = match shape {
            1 => Shape::Inv1,
            2 => Shape::Seventh,
            3 => Shape::DomOrDim7,
            _ => Shape::Root,
        };
        let mut st = MusicalState {
            key: self.inner.key,
            mode: self.inner.mode,
            degree,
            quality,
            shape,
            octave,
            ..Default::default()
        };
        st.derive_notes(VoicingSettings::default());
        let t = track.min(3);
        let transport = self.inner.transport;
        self.inner.looper.tracks[t].replace_chord_at_step(
            step,
            &transport,
            Event::chord_on_from(&st),
        );
        self.inner.looper.mark_dirty(t);
    }

    /// Tracks summary for the mixer (names, volume, pan, mute, solo, midi, length, empty).
    pub fn tracks_json(&self) -> String {
        let v: Vec<serde_json::Value> = self
            .inner
            .looper
            .tracks
            .iter()
            .map(|t| {
                serde_json::json!({
                    "name": t.name, "instrument": t.instrument.name, "volume": t.volume, "pan": t.pan,
                    "mute": t.mute, "solo": t.solo, "midi_ch": t.midi_ch, "length_bars": t.length_bars,
                    "empty": t.is_empty(), "events": t.events.len()
                })
            })
            .collect();
        serde_json::to_string(&v).unwrap_or_default()
    }

    pub fn to_session_json(&self) -> String {
        self.inner.to_session().to_json()
    }

    pub fn load_session_json(&mut self, json: &str) -> Result<(), JsValue> {
        let s = SessionFile::from_json(json).map_err(|e| JsValue::from_str(&e))?;
        self.inner.load_session(&s);
        Ok(())
    }

    /// Drop a song into a track as a backing loop (Song Builder).
    pub fn load_song_into_track(&mut self, song_json: &str, track: usize) -> Result<(), JsValue> {
        let song = SongFile::from_json(song_json).map_err(|e| JsValue::from_str(&e))?;
        let t = track.min(3);
        self.inner.command(EngineCommand::SetBpm { bpm: song.bpm });
        if let Some(sig) = gsyn_core::transport::TimeSig::parse(&song.time_sig) {
            self.inner.command(EngineCommand::SetTimeSig {
                beats: sig.beats,
                unit: sig.unit,
            });
        }
        self.inner
            .command(EngineCommand::SetBars { bars: song.bars });
        self.inner.command(EngineCommand::SetKey {
            key: song.key,
            mode: song.mode,
        });
        let mut tr = song.to_track(t, VoicingSettings::default());
        tr.midi_ch = self.inner.looper.tracks[t].midi_ch;
        let inst = tr.instrument.clone();
        self.inner.looper.tracks[t] = tr;
        self.inner.set_track_instrument(t, inst);
        self.inner.looper.mark_dirty(t);
        Ok(())
    }

    pub fn set_track_landmarks_json(&mut self, track: usize, json: &str) -> Result<(), JsValue> {
        let frames = serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.inner.looper.tracks[track.min(3)].landmarks15hz = frames;
        Ok(())
    }

    pub fn track_landmarks_json(&self, track: usize) -> String {
        serde_json::to_string(&self.inner.looper.tracks[track.min(3)].landmarks15hz)
            .unwrap_or_default()
    }

    pub fn key_index(&self) -> i32 {
        self.inner.key.index() as i32
    }

    pub fn is_minor(&self) -> bool {
        self.inner.mode == Mode::Minor
    }
}

// ---------------------------------------------------------------------------
// Stateless helpers (exports, song builder, tutorials)
// ---------------------------------------------------------------------------

/// Offline bounce to 16-bit WAV.
#[wasm_bindgen]
pub fn render_wav(session_json: &str, sample_rate: f32, passes: u32) -> Result<Vec<u8>, JsValue> {
    let s = SessionFile::from_json(session_json).map_err(|e| JsValue::from_str(&e))?;
    let audio = Engine::render_offline(&s, sample_rate, passes);
    Ok(wav_from_f32(&audio, sample_rate as u32))
}

/// Offline bounce as interleaved f32 (for ffmpeg.wasm / MediaRecorder muxing).
#[wasm_bindgen]
pub fn render_f32(session_json: &str, sample_rate: f32, passes: u32) -> Result<Vec<f32>, JsValue> {
    let s = SessionFile::from_json(session_json).map_err(|e| JsValue::from_str(&e))?;
    Ok(Engine::render_offline(&s, sample_rate, passes))
}

/// Standard MIDI File of the session's tracks.
#[wasm_bindgen]
pub fn render_midi(session_json: &str) -> Result<Vec<u8>, JsValue> {
    let s = SessionFile::from_json(session_json).map_err(|e| JsValue::from_str(&e))?;
    let mut t = gsyn_core::transport::Transport::new(48_000.0);
    s.transport.apply(&mut t);
    Ok(tracks_to_smf(&s.tracks, &t, s.key, s.mode, &s.name))
}

/// Parse a typed progression into song chords (JSON array).
#[wasm_bindgen]
pub fn parse_progression(
    text: &str,
    key_index: i32,
    minor: bool,
    beats_per_bar: u8,
    chords_per_bar: u8,
) -> Result<String, JsValue> {
    let chords = SongFile::parse_progression(
        text,
        PitchClass::from_index(key_index),
        if minor { Mode::Minor } else { Mode::Major },
        beats_per_bar,
        chords_per_bar,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_json::to_string(&chords).unwrap_or_default())
}

/// Validate a song file; returns an error message or empty string.
#[wasm_bindgen]
pub fn validate_song(song_json: &str) -> String {
    match SongFile::from_json(song_json) {
        Ok(_) => String::new(),
        Err(e) => e,
    }
}

/// Chord name helpers for the UI.
#[wasm_bindgen]
pub fn chord_name(degree: u8, quality: u8, shape: u8) -> String {
    let q = match quality {
        1 => Quality::Minor,
        2 => Quality::Diminished,
        _ => Quality::Major,
    };
    let s = match shape {
        1 => Shape::Inv1,
        2 => Shape::Seventh,
        3 => Shape::DomOrDim7,
        _ => Shape::Root,
    };
    music::chord_name(degree, q, s, VoicingSettings::default())
}

#[wasm_bindgen]
pub fn chord_notes(
    key_index: i32,
    minor: bool,
    degree: u8,
    quality: u8,
    shape: u8,
    octave: i8,
) -> Vec<u8> {
    let q = match quality {
        1 => Quality::Minor,
        2 => Quality::Diminished,
        _ => Quality::Major,
    };
    let s = match shape {
        1 => Shape::Inv1,
        2 => Shape::Seventh,
        3 => Shape::DomOrDim7,
        _ => Shape::Root,
    };
    let (n, c) = music::chord_notes(
        PitchClass::from_index(key_index),
        if minor { Mode::Minor } else { Mode::Major },
        degree,
        q,
        s,
        octave,
        VoicingSettings::default(),
    );
    n[..c as usize].to_vec()
}

#[wasm_bindgen]
pub fn diatonic_quality(degree: u8, minor: bool) -> u8 {
    match music::diatonic_quality(degree, if minor { Mode::Minor } else { Mode::Major }) {
        Quality::Major => 0,
        Quality::Minor => 1,
        Quality::Diminished => 2,
    }
}

#[wasm_bindgen]
pub fn pitch_class_name(index: i32) -> String {
    PitchClass::from_index(index).name().to_string()
}

#[wasm_bindgen]
pub fn pitch_class_hue(index: i32) -> f32 {
    PitchClass::from_index(index).hue()
}

#[wasm_bindgen]
pub fn note_name(midi: u8) -> String {
    music::note_name(midi)
}

#[wasm_bindgen]
pub fn builtin_instruments_json() -> String {
    serde_json::to_string(&gsyn_core::instruments::all_builtin()).unwrap_or_default()
}

#[wasm_bindgen]
pub fn default_parser_config_json() -> String {
    serde_json::to_string(&ParserConfig::default()).unwrap_or_default()
}

/// Synthetic hand landmarks (63 floats) for tutorial diagrams and the tour.
/// fingers bitmask: bit0 thumb .. bit4 pinky. `right` selects the hand.
#[wasm_bindgen]
pub fn synth_hand_landmarks(
    cx: f32,
    cy: f32,
    palm: f32,
    fingers: u8,
    tilt_deg: f32,
    right: bool,
) -> Vec<f32> {
    let f = [
        fingers & 1 != 0,
        fingers & 2 != 0,
        fingers & 4 != 0,
        fingers & 8 != 0,
        fingers & 16 != 0,
    ];
    let h = synth_hand(
        cx,
        cy,
        palm,
        f,
        tilt_deg,
        if right {
            Handedness::Right
        } else {
            Handedness::Left
        },
    );
    h.landmarks.iter().flat_map(|p| p.iter().copied()).collect()
}
