//! Native audio backend (spec 3 "Threads"): cpal output stream running the
//! Rust engine on the audio thread. Live state arrives through a lock-free
//! triple buffer; UI commands through an SPSC ring; position/track state goes
//! back to the webview as a ~60 Hz Tauri event; MIDI bytes go to midir.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use gsyn_core::engine::{Engine, EngineCommand, EngineSettings};
use gsyn_core::rt::{SpscRing, TripleBuffer};
use gsyn_core::state::{Event, MusicalState, EVENT_FLOATS, STATE_FLOATS};
use gsyn_core::MAX_BLOCK;
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// Live payload published by the ipc side each camera frame.
#[derive(Clone, Copy)]
pub struct LivePacket {
    pub state: MusicalState,
    pub events: [Event; 16],
    pub n_events: u8,
    pub seq: u32,
}

impl Default for LivePacket {
    fn default() -> Self {
        Self {
            state: MusicalState::default(),
            events: [Event::ChordOff; 16],
            n_events: 0,
            seq: 0,
        }
    }
}

/// Requests that need the engine but are not `Copy` (session JSON etc.). The
/// audio thread drains this mutex only when it can take it without blocking.
pub enum Request {
    Call {
        method: String,
        args: Vec<serde_json::Value>,
        reply: std::sync::mpsc::Sender<Result<serde_json::Value, String>>,
    },
    SetLive(LivePacket),
}

pub struct Shared {
    pub live: TripleBuffer<LivePacket>,
    pub cmds: SpscRing<EngineCommand, 256>,
    pub requests: Mutex<Vec<Request>>,
}

pub struct AudioBackend {
    _stream: cpal::Stream,
    pub shared: Arc<Shared>,
    pub device_name: String,
    pub sample_rate: u32,
    pub latency_ms: u32,
    pub seq: std::sync::atomic::AtomicU32,
}

// cpal::Stream is !Send on some platforms; we only ever touch it from the main thread
// through the Tauri state mutex.
unsafe impl Send for AudioBackend {}
unsafe impl Sync for AudioBackend {}

#[derive(Serialize, Clone)]
pub struct PositionPayload {
    pub pos: Vec<f32>,
    pub tracks: Vec<f32>,
    pub events: Vec<f32>,
}

pub fn list_output_devices() -> Vec<(String, String)> {
    let host = cpal::default_host();
    host.output_devices()
        .map(|it| {
            it.filter_map(|d| d.name().ok())
                .map(|n| (n.clone(), n))
                .collect()
        })
        .unwrap_or_default()
}

pub fn start(
    app: AppHandle,
    device_id: Option<String>,
    buffer_size: u32,
    settings: Option<EngineSettings>,
    midi: Arc<Mutex<Option<midir::MidiOutputConnection>>>,
) -> Result<AudioBackend, String> {
    let host = cpal::default_host();
    let device = match device_id.as_deref().filter(|s| !s.is_empty()) {
        Some(name) => host
            .output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == name).unwrap_or(false))
            .or_else(|| host.default_output_device()),
        None => host.default_output_device(),
    }
    .ok_or("no output device")?;
    let device_name = device.name().unwrap_or_else(|_| "default".into());
    let default_cfg = device.default_output_config().map_err(|e| e.to_string())?;
    let sample_rate = default_cfg.sample_rate().0;
    let mut cfg: cpal::StreamConfig = default_cfg.into();
    cfg.channels = 2;
    cfg.buffer_size = cpal::BufferSize::Fixed(buffer_size.clamp(32, 2048));

    let shared = Arc::new(Shared {
        live: TripleBuffer::new(LivePacket::default()),
        cmds: SpscRing::new(),
        requests: Mutex::new(Vec::new()),
    });
    let mut engine = Engine::new(sample_rate as f32);
    if let Some(s) = settings {
        engine.settings = s;
        engine.synth.metronome.enabled = s.metronome_enabled;
        engine.synth.metronome.volume = s.metronome_volume;
    }
    let shared_cb = shared.clone();
    let app_cb = app.clone();
    let mut l = vec![0f32; MAX_BLOCK];
    let mut r = vec![0f32; MAX_BLOCK];
    let mut c = vec![0f32; MAX_BLOCK];
    let mut last_seq = u32::MAX;
    let mut since_post = 0usize;
    let post_every = (sample_rate as usize / 60).max(1);
    let mut pos_buf = [0f32; 21];
    let mut track_buf = [0f32; STATE_FLOATS * 4];
    let metronome_monitor = true;

    let err_fn = |e| eprintln!("[audio] stream error: {e}");

    let stream = device
        .build_output_stream(
            &cfg,
            move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                // 1) commands
                while let Some(cmd) = shared_cb.cmds.pop() {
                    engine.command(cmd);
                }
                // 2) live state (latest wins)
                let (_, mut reader) = shared_cb.live.split();
                let pkt = reader.read();
                if pkt.seq != last_seq {
                    last_seq = pkt.seq;
                    engine.set_live(pkt.state, &pkt.events[..pkt.n_events as usize]);
                }
                // 3) non-realtime requests, only if the lock is free
                if let Some(mut reqs) = shared_cb.requests.try_lock() {
                    for req in reqs.drain(..) {
                        match req {
                            Request::SetLive(p) => {
                                engine.set_live(p.state, &p.events[..p.n_events as usize])
                            }
                            Request::Call {
                                method,
                                args,
                                reply,
                            } => {
                                let _ = reply.send(call(&mut engine, &method, &args));
                            }
                        }
                    }
                }
                // 4) render in <= MAX_BLOCK chunks, interleave
                let frames = data.len() / 2;
                let mut done = 0;
                while done < frames {
                    let n = (frames - done).min(MAX_BLOCK);
                    engine.process(&mut l[..n], &mut r[..n], &mut c[..n]);
                    for i in 0..n {
                        let cue = if metronome_monitor { c[i] } else { 0.0 };
                        data[(done + i) * 2] = l[i] + cue;
                        data[(done + i) * 2 + 1] = r[i] + cue;
                    }
                    done += n;
                }
                // 5) MIDI
                if engine.settings.midi_enabled {
                    if let Some(mut m) = midi.try_lock() {
                        if let Some(conn) = m.as_mut() {
                            for msg in engine.drain_midi() {
                                let _ = conn.send(&msg);
                            }
                        }
                    }
                }
                // 6) position event ~60 Hz
                since_post += frames;
                if since_post >= post_every {
                    since_post = 0;
                    let p = engine.position();
                    pos_buf[0] = match p.state {
                        gsyn_core::transport::TransportState::Stopped => 0.0,
                        gsyn_core::transport::TransportState::CountIn => 1.0,
                        gsyn_core::transport::TransportState::Playing => 2.0,
                    };
                    pos_buf[1] = p.bar as f32;
                    pos_buf[2] = p.beat as f32;
                    pos_buf[3] = p.step as f32;
                    pos_buf[4] = p.phase;
                    pos_buf[5] = p.bpm;
                    pos_buf[6] = p.beats as f32;
                    pos_buf[7] = p.unit as f32;
                    pos_buf[8] = p.bars as f32;
                    pos_buf[9] = p.count_in.map(|c| c as f32).unwrap_or(-1.0);
                    pos_buf[10] = p.loop_count as f32;
                    pos_buf[11] = match p.recording {
                        gsyn_core::looper::RecordStatus::Idle => 0.0,
                        gsyn_core::looper::RecordStatus::Armed => 1.0,
                        gsyn_core::looper::RecordStatus::Recording => 2.0,
                    };
                    pos_buf[12] = p.rec_track.map(|t| t as f32).unwrap_or(-1.0);
                    pos_buf[13] = p.selected as f32;
                    pos_buf[14] = p.position as f32;
                    pos_buf[15] = p.loop_len as f32;
                    pos_buf[16] = (p.now % (1 << 24)) as f32;
                    pos_buf[17] = (p.now >> 24) as f32;
                    pos_buf[18] = p.last_beat as f32;
                    pos_buf[19] = if p.last_beat_was_bar_start { 1.0 } else { 0.0 };
                    pos_buf[20] = p.beat_seq as f32;
                    for t in 0..4 {
                        let mut b = [0f32; STATE_FLOATS];
                        engine.track_state(t).to_floats(&mut b);
                        track_buf[t * STATE_FLOATS..(t + 1) * STATE_FLOATS].copy_from_slice(&b);
                    }
                    let evs = engine.take_ui_events();
                    let mut ev_floats = Vec::with_capacity(evs.len() * EVENT_FLOATS);
                    for e in evs.as_slice() {
                        let mut b = [0f32; EVENT_FLOATS];
                        e.to_floats(&mut b);
                        ev_floats.extend_from_slice(&b);
                    }
                    // emit is cheap (channel send); allocation here is UI-rate, acceptable.
                    let _ = app_cb.emit(
                        "gsyn://position",
                        PositionPayload {
                            pos: pos_buf.to_vec(),
                            tracks: track_buf.to_vec(),
                            events: ev_floats,
                        },
                    );
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    let latency_ms = (buffer_size as f32 / sample_rate as f32 * 1000.0).round() as u32 + 2;
    Ok(AudioBackend {
        _stream: stream,
        shared,
        device_name,
        sample_rate,
        latency_ms,
        seq: std::sync::atomic::AtomicU32::new(1),
    })
}

impl AudioBackend {
    pub fn set_live(&self, state: &[f32], events: &[f32]) {
        let mut pkt = LivePacket {
            state: MusicalState::from_floats(state),
            ..Default::default()
        };
        for (i, chunk) in events.chunks_exact(EVENT_FLOATS).take(16).enumerate() {
            if let Some(e) = Event::from_floats(chunk) {
                pkt.events[i] = e;
                pkt.n_events = (i + 1) as u8;
            }
        }
        pkt.seq = self.seq.fetch_add(1, Ordering::Relaxed);
        if pkt.n_events > 0 {
            // events must not be lost to a later overwrite: go through the request queue
            self.shared.requests.lock().push(Request::SetLive(pkt));
        } else {
            let (mut w, _) = self.shared.live.split();
            w.write(pkt);
        }
    }

    pub fn command(&self, cmd: EngineCommand) {
        if !self.shared.cmds.push(cmd) {
            eprintln!("[audio] command ring full, dropped {cmd:?}");
        }
    }
}

/// Mirror of the WasmEngine method surface used by the frontend `call()` API.
fn call(
    engine: &mut Engine,
    method: &str,
    args: &[serde_json::Value],
) -> Result<serde_json::Value, String> {
    use gsyn_core::instruments::Instrument;
    use gsyn_core::music::{Quality, Shape, VoicingSettings};
    use gsyn_core::session::{SessionFile, SongFile};
    use serde_json::{json, Value};
    let s = |i: usize| {
        args.get(i)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("arg {i} must be a string"))
    };
    let n = |i: usize| {
        args.get(i)
            .and_then(|v| v.as_f64())
            .ok_or_else(|| format!("arg {i} must be a number"))
    };
    Ok(match method {
        "tracks_json" => {
            let v: Vec<Value> = engine
                .looper
                .tracks
                .iter()
                .map(|t| json!({ "name": t.name, "instrument": t.instrument.name, "volume": t.volume, "pan": t.pan, "mute": t.mute, "solo": t.solo, "midi_ch": t.midi_ch, "length_bars": t.length_bars, "empty": t.is_empty(), "events": t.events.len() }))
                .collect();
            Value::String(serde_json::to_string(&v).unwrap_or_default())
        }
        "grid_json" => {
            let g = engine.looper.grid(&engine.transport);
            let mutes: Vec<Vec<bool>> = engine
                .looper
                .tracks
                .iter()
                .map(|t| {
                    (0..t.steps(&engine.transport))
                        .map(|s| t.step_muted(s))
                        .collect()
                })
                .collect();
            Value::String(serde_json::to_string(&json!({ "cells": g, "mutes": mutes, "steps_per_bar": engine.transport.sig.steps_per_bar() })).unwrap_or_default())
        }
        "to_session_json" => Value::String(engine.to_session().to_json()),
        "load_session_json" => {
            let f = SessionFile::from_json(s(0)?)?;
            engine.load_session(&f);
            Value::Null
        }
        "set_track_instrument" => {
            let inst: Instrument = serde_json::from_str(s(1)?).map_err(|e| e.to_string())?;
            engine.set_track_instrument(n(0)? as usize, inst);
            Value::Null
        }
        "set_theremin_instrument" => {
            let inst: Instrument = serde_json::from_str(s(0)?).map_err(|e| e.to_string())?;
            engine.set_theremin_instrument(inst);
            Value::Null
        }
        "replace_chord" => {
            let quality = match n(3)? as i32 {
                1 => Quality::Minor,
                2 => Quality::Diminished,
                _ => Quality::Major,
            };
            let shape = match n(4)? as i32 {
                1 => Shape::Inv1,
                2 => Shape::Seventh,
                3 => Shape::DomOrDim7,
                _ => Shape::Root,
            };
            let mut st = MusicalState {
                key: engine.key,
                mode: engine.mode,
                degree: n(2)? as u8,
                quality,
                shape,
                octave: n(5).unwrap_or(0.0) as i8,
                ..Default::default()
            };
            st.derive_notes(VoicingSettings::default());
            let t = (n(0)? as usize).min(3);
            let transport = engine.transport;
            engine.looper.tracks[t].replace_chord_at_step(
                n(1)? as usize,
                &transport,
                Event::chord_on_from(&st),
            );
            engine.looper.mark_dirty(t);
            Value::Null
        }
        "load_song_into_track" => {
            let song = SongFile::from_json(s(0)?)?;
            let t = (n(1)? as usize).min(3);
            engine.command(EngineCommand::SetBpm { bpm: song.bpm });
            if let Some(sig) = gsyn_core::transport::TimeSig::parse(&song.time_sig) {
                engine.command(EngineCommand::SetTimeSig {
                    beats: sig.beats,
                    unit: sig.unit,
                });
            }
            engine.command(EngineCommand::SetBars { bars: song.bars });
            engine.command(EngineCommand::SetKey {
                key: song.key,
                mode: song.mode,
            });
            let mut tr = song.to_track(t, VoicingSettings::default());
            tr.midi_ch = engine.looper.tracks[t].midi_ch;
            let inst = tr.instrument.clone();
            engine.looper.tracks[t] = tr;
            engine.set_track_instrument(t, inst);
            engine.looper.mark_dirty(t);
            Value::Null
        }
        "set_track_landmarks_json" => {
            engine.looper.tracks[(n(0)? as usize).min(3)].landmarks15hz =
                serde_json::from_str(s(1)?).map_err(|e| e.to_string())?;
            Value::Null
        }
        "track_landmarks_json" => Value::String(
            serde_json::to_string(&engine.looper.tracks[(n(0)? as usize).min(3)].landmarks15hz)
                .unwrap_or_default(),
        ),
        "settings_json" => {
            Value::String(serde_json::to_string(&engine.settings).unwrap_or_default())
        }
        "set_settings" => {
            engine.settings = serde_json::from_str(s(0)?).map_err(|e| e.to_string())?;
            engine.synth.metronome.volume = engine.settings.metronome_volume;
            engine.synth.metronome.enabled = engine.settings.metronome_enabled;
            engine.synth.master.reverb_enabled = engine.settings.reverb_enabled;
            engine.synth.master.delay_enabled = engine.settings.delay_enabled;
            Value::Null
        }
        "position_json" => serde_json::to_value(engine.position()).unwrap_or(Value::Null),
        other => return Err(format!("unknown engine method {other}")),
    })
}
