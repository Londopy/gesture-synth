//! # gsyn-core
//!
//! The whole musical brain of Gesture Synth, platform independent:
//!
//! * [`gesture`]   – turns MediaPipe hand landmarks into a [`state::MusicalState`] (+ one-shot [`state::Event`]s)
//! * [`music`]     – keys, scale degrees, chord derivation, chord names, circle of fifths
//! * [`transport`] – sample-accurate beat clock (BPM, time signature, bars, count-in, quantize grid)
//! * [`synth`]     – voices, chord legato engine, instruments, master FX, metronome, theremin
//! * [`looper`]    – event-stream loop pedal (4 tracks, overdub/replace, step mutes, curves)
//! * [`session`]   – the `.gsyn.json` file formats (song, session, instrument, theme)
//! * [`midi`]      – MIDI message generation and Standard MIDI File export
//! * [`engine`]    – glues all of the above into one object driven by `process()` from the audio thread
//! * [`rt`]        – lock-free triple buffer and SPSC ring used between threads on desktop
//!
//! The same crate compiles natively (Tauri / cpal) and to `wasm32-unknown-unknown`
//! (AudioWorklet + main thread) via `gsyn-wasm`. Nothing in the audio path allocates.

#![forbid(unsafe_op_in_unsafe_fn)]
#![allow(clippy::too_many_arguments, clippy::needless_range_loop)]

pub mod curve;
pub mod engine;
pub mod gesture;
pub mod instruments;
pub mod looper;
pub mod math;
pub mod midi;
pub mod music;
pub mod rt;
pub mod session;
pub mod state;
pub mod synth;
pub mod transport;

pub use engine::{Engine, EngineCommand, EngineSettings, PositionInfo};
pub use gesture::{GestureParser, HandFrame, Handedness, ParserConfig};
pub use music::{Midi, Mode, PitchClass, Quality, Shape};
pub use state::{Event, MusicalState};

/// Default sample rate the engine is tuned for. Any rate works; this is what the
/// desktop build requests and what Web Audio usually gives.
pub const DEFAULT_SAMPLE_RATE: f32 = 48_000.0;
/// Largest block the engine renders in one go. cpal may hand us more; the engine
/// chops it into sub-blocks of at most this size.
pub const MAX_BLOCK: usize = 128;
/// Format version written into every `.gsyn.json` file.
pub const FORMAT_VERSION: u32 = 1;

/// Crate version string for the HUD / about dialog.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
