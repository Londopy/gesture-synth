//! The Engine ties parser output, transport, loop engine and synth together and
//! is driven from the audio thread via `process()`. It never allocates inside
//! `process` (except on rare edit commands, which are UI-rate).
//!
//! Ownership rule (spec 3): the live slot is fed ONLY by the parser (via
//! `set_live`), loop slots ONLY by the loop engine. The synth and renderer are
//! pure consumers.

use crate::instruments::Instrument;
use crate::looper::{LoopEngine, RecordMode, RecordStatus, TRACKS};
use crate::midi::{ChannelState, MidiQueue};
use crate::music::{Mode, PitchClass};
use crate::session::SessionFile;
use crate::state::{Event, EventList, MusicalState};
use crate::synth::{SlotParams, Synth, LIVE_SLOT, SLOTS};
use crate::transport::{Quantize, TimeSig, Transport, TransportState};
use crate::MAX_BLOCK;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantizeInput {
    Off,
    /// Default: quantize live chord changes only while recording.
    #[default]
    Recording,
    Always,
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct EngineSettings {
    pub quantize_input: QuantizeInput,
    pub metronome_volume: f32,
    pub metronome_enabled: bool,
    pub midi_enabled: bool,
    pub midi_live_channel: u8,
    pub midi_use_expression: bool,
    pub reverb_enabled: bool,
    pub delay_enabled: bool,
    /// Include the live slot in the export bounce.
    pub bounce_live: bool,
}

impl Default for EngineSettings {
    fn default() -> Self {
        Self {
            quantize_input: QuantizeInput::Recording,
            metronome_volume: 0.6,
            metronome_enabled: true,
            midi_enabled: false,
            midi_live_channel: 1,
            midi_use_expression: false,
            reverb_enabled: true,
            delay_enabled: true,
            bounce_live: false,
        }
    }
}

/// Commands from the UI thread (all `Copy` so they fit the SPSC ring).
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum EngineCommand {
    Play,
    Stop,
    TogglePlay,
    /// Arm + (count-in if stopped) record on the given track.
    Record {
        track: u8,
    },
    ToggleRecord,
    SelectTrack {
        track: u8,
    },
    SetMute {
        track: u8,
        on: bool,
    },
    SetSolo {
        track: u8,
        on: bool,
    },
    ToggleMute {
        track: u8,
    },
    ToggleSolo {
        track: u8,
    },
    SetTrackVolume {
        track: u8,
        volume: f32,
    },
    SetTrackPan {
        track: u8,
        pan: f32,
    },
    SetTrackLength {
        track: u8,
        bars: u8,
    },
    SetTrackMidiChannel {
        track: u8,
        channel: u8,
    },
    ClearTrack {
        track: u8,
    },
    ClearAll,
    ToggleStepMute {
        track: u8,
        step: u16,
    },
    SetBpm {
        bpm: f32,
    },
    NudgeBpm {
        delta: f32,
    },
    SetTimeSig {
        beats: u8,
        unit: u8,
    },
    SetBars {
        bars: u8,
    },
    Panic,
    SetMetronomeVolume {
        volume: f32,
    },
    SetMetronomeEnabled {
        on: bool,
    },
    SetQuantize {
        quantize: Quantize,
    },
    SetRecordMode {
        mode: RecordMode,
    },
    SetLoopRecord {
        on: bool,
    },
    SetWrapAtLoopEnd {
        on: bool,
    },
    SetQuantizeInput {
        mode: QuantizeInput,
    },
    SetCountInBars {
        bars: u8,
    },
    SetMidiEnabled {
        on: bool,
    },
    SetReverbEnabled {
        on: bool,
    },
    SetDelayEnabled {
        on: bool,
    },
    SetKey {
        key: PitchClass,
        mode: Mode,
    },
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct PositionInfo {
    pub state: TransportState,
    pub bar: u32,
    pub beat: u32,
    pub step: u32,
    pub phase: f32,
    pub bpm: f32,
    pub beats: u8,
    pub unit: u8,
    pub bars: u8,
    pub count_in: Option<u32>,
    pub loop_count: u32,
    pub recording: RecordStatus,
    pub rec_track: Option<u8>,
    pub selected: u8,
    pub position: u64,
    pub loop_len: u64,
    /// Monotonic sample clock.
    pub now: u64,
    /// Index of the last beat that started (for beat pulses), wraps per bar.
    pub last_beat: u32,
    pub last_beat_was_bar_start: bool,
    pub beat_seq: u32,
}

#[derive(Clone, Copy)]
struct Pending {
    event: Event,
    due: u64,
}

pub struct Engine {
    pub sr: f32,
    pub transport: Transport,
    pub looper: LoopEngine,
    pub synth: Synth,
    pub settings: EngineSettings,
    pub key: PitchClass,
    pub mode: Mode,
    live: MusicalState,
    live_events: EventList,
    pending: Option<Pending>,
    track_state: [MusicalState; TRACKS],
    ui_events: EventList,
    midi: MidiQueue,
    midi_ch: [ChannelState; SLOTS],
    bass_release_at: [u64; SLOTS],
    params: [SlotParams; SLOTS],
    scratch_events: EventList,
    beat_seq: u32,
    last_beat: u32,
    last_beat_bar: bool,
    was_recording: bool,
}

impl Engine {
    pub fn new(sr: f32) -> Self {
        let mut synth = Synth::new(sr);
        let looper = LoopEngine::new(sr);
        for (i, t) in looper.tracks.iter().enumerate() {
            synth.slots[i].set_instrument(t.instrument.clone());
        }
        Self {
            sr,
            transport: Transport::new(sr),
            looper,
            synth,
            settings: EngineSettings::default(),
            key: PitchClass::C,
            mode: Mode::Major,
            live: MusicalState::default(),
            live_events: EventList::new(),
            pending: None,
            track_state: [MusicalState::default(); TRACKS],
            ui_events: EventList::new(),
            midi: MidiQueue::new(),
            midi_ch: [ChannelState::new(); SLOTS],
            bass_release_at: [0; SLOTS],
            params: [SlotParams::default(); SLOTS],
            scratch_events: EventList::new(),
            beat_seq: 0,
            last_beat: 0,
            last_beat_bar: false,
            was_recording: false,
        }
    }

    // ------------------------------------------------------------------ inputs

    /// Latest parser output (called once per camera frame, from the ipc/main thread
    /// on wasm or after the triple buffer on desktop).
    pub fn set_live(&mut self, state: MusicalState, events: &[Event]) {
        self.live = state;
        for e in events {
            if let Event::KeyChange { key, mode } = e {
                self.key = *key;
                self.mode = *mode;
            }
            self.live_events.push(*e);
        }
    }

    pub fn live(&self) -> &MusicalState {
        &self.live
    }

    pub fn track_state(&self, track: usize) -> MusicalState {
        self.track_state[track.min(TRACKS - 1)]
    }

    pub fn take_ui_events(&mut self) -> EventList {
        let e = self.ui_events;
        self.ui_events.clear();
        e
    }

    pub fn drain_midi(&mut self) -> impl Iterator<Item = [u8; 3]> + '_ {
        self.midi.drain()
    }

    pub fn set_track_instrument(&mut self, track: usize, inst: Instrument) {
        if track < TRACKS {
            self.looper.tracks[track].instrument = inst.clone();
            self.synth.slots[track].set_instrument(inst);
        } else {
            self.synth.slots[LIVE_SLOT].set_instrument(inst);
        }
    }

    pub fn set_theremin_instrument(&mut self, inst: Instrument) {
        self.synth.theremin.set_instrument(inst);
    }

    pub fn live_instrument(&self) -> &Instrument {
        &self.synth.slots[LIVE_SLOT].inst
    }

    pub fn command(&mut self, cmd: EngineCommand) {
        use EngineCommand as C;
        match cmd {
            C::Play => self.play(),
            C::Stop => self.stop(),
            C::TogglePlay => {
                if self.transport.is_running() {
                    self.stop();
                } else {
                    self.play();
                }
            }
            C::Record { track } => self.record(track as usize),
            C::ToggleRecord => {
                if self.looper.status() != RecordStatus::Idle {
                    self.finish_or_cancel_recording();
                } else {
                    self.record(self.looper.selected);
                }
            }
            C::SelectTrack { track } => self.looper.selected = (track as usize).min(TRACKS - 1),
            C::SetMute { track, on } => self.track_mut(track).mute = on,
            C::SetSolo { track, on } => self.track_mut(track).solo = on,
            C::ToggleMute { track } => {
                let t = self.track_mut(track);
                t.mute = !t.mute;
            }
            C::ToggleSolo { track } => {
                let t = self.track_mut(track);
                t.solo = !t.solo;
            }
            C::SetTrackVolume { track, volume } => {
                self.track_mut(track).volume = volume.clamp(0.0, 1.0)
            }
            C::SetTrackPan { track, pan } => self.track_mut(track).pan = pan.clamp(-1.0, 1.0),
            C::SetTrackLength { track, bars } => {
                let max = self.transport.bars;
                let t = self.track_mut(track);
                t.length_bars = if bars == 0 || bars >= max { 0 } else { bars };
                self.looper.mark_dirty(track as usize);
            }
            C::SetTrackMidiChannel { track, channel } => {
                self.track_mut(track).midi_ch = channel.clamp(1, 16)
            }
            C::ClearTrack { track } => {
                let i = (track as usize).min(TRACKS - 1);
                self.looper.clear_track(i);
                self.synth.slots[i].chord_off();
                self.track_state[i] = MusicalState::default();
            }
            C::ClearAll => {
                self.looper.clear_all();
                for i in 0..TRACKS {
                    self.synth.slots[i].chord_off();
                    self.track_state[i] = MusicalState::default();
                }
            }
            C::ToggleStepMute { track, step } => {
                let i = (track as usize).min(TRACKS - 1);
                self.looper.toggle_step_mute(i, step as usize);
                self.looper.mark_dirty(i);
            }
            C::SetBpm { bpm } => self.set_bpm(bpm),
            C::NudgeBpm { delta } => self.set_bpm(self.transport.bpm + delta),
            C::SetTimeSig { beats, unit } => {
                self.transport.set_sig(TimeSig::new(beats, unit));
                self.looper.mark_all_dirty();
            }
            C::SetBars { bars } => {
                self.transport.set_bars(bars);
                self.looper.mark_all_dirty();
            }
            C::Panic => self.panic(),
            C::SetMetronomeVolume { volume } => {
                self.settings.metronome_volume = volume.clamp(0.0, 1.0);
                self.synth.metronome.volume = self.settings.metronome_volume;
            }
            C::SetMetronomeEnabled { on } => {
                self.settings.metronome_enabled = on;
                self.synth.metronome.enabled = on;
            }
            C::SetQuantize { quantize } => self.looper.settings.quantize = quantize,
            C::SetRecordMode { mode } => self.looper.settings.record_mode = mode,
            C::SetLoopRecord { on } => self.looper.settings.loop_record = on,
            C::SetWrapAtLoopEnd { on } => self.looper.settings.wrap_at_loop_end = on,
            C::SetQuantizeInput { mode } => self.settings.quantize_input = mode,
            C::SetCountInBars { bars } => self.looper.settings.count_in_bars = bars.clamp(0, 4),
            C::SetMidiEnabled { on } => self.settings.midi_enabled = on,
            C::SetReverbEnabled { on } => {
                self.settings.reverb_enabled = on;
                self.synth.master.reverb_enabled = on;
            }
            C::SetDelayEnabled { on } => {
                self.settings.delay_enabled = on;
                self.synth.master.delay_enabled = on;
            }
            C::SetKey { key, mode } => {
                self.key = key;
                self.mode = mode;
            }
        }
    }

    fn track_mut(&mut self, track: u8) -> &mut crate::looper::Track {
        &mut self.looper.tracks[(track as usize).min(TRACKS - 1)]
    }

    fn set_bpm(&mut self, bpm: f32) {
        self.transport.set_bpm(bpm);
        self.synth
            .master
            .delay
            .sync_to_beat(self.transport.samples_per_beat(), 0.75);
        self.looper.mark_all_dirty();
    }

    pub fn play(&mut self) {
        if self.transport.state == TransportState::Stopped {
            self.transport.play();
            self.looper.reset_playback();
        }
    }

    pub fn stop(&mut self) {
        if self.looper.status() != RecordStatus::Idle {
            self.finish_or_cancel_recording();
        }
        self.transport.stop();
        self.looper.reset_playback();
        for i in 0..TRACKS {
            if self.synth.slots[i].is_sounding() {
                self.synth.slots[i].chord_off();
                self.midi_ch[i].apply(
                    self.looper.tracks[i].midi_ch,
                    &Event::ChordOff,
                    false,
                    &mut self.midi,
                );
            }
            self.track_state[i].degree = 0;
            self.track_state[i].note_count = 0;
        }
    }

    /// Record flow (spec 7): select track, count-in (if stopped), record for the
    /// track length, auto-play. If already playing, recording starts at the next loop start.
    pub fn record(&mut self, track: usize) {
        let track = track.min(TRACKS - 1);
        self.looper.selected = track;
        self.looper.arm(track);
        if self.transport.state == TransportState::Stopped {
            let bars = self.looper.settings.count_in_bars;
            if bars == 0 {
                self.transport.play();
                self.looper.reset_playback();
                self.looper.begin_recording(&self.transport);
                self.looper.record_initial_chord(&self.live);
            } else {
                self.transport.count_in(bars);
                self.looper.reset_playback();
            }
        }
    }

    fn finish_or_cancel_recording(&mut self) {
        match self.looper.status() {
            RecordStatus::Recording => {
                self.looper.settings.loop_record = false;
                self.looper.finish_recording(&self.transport);
            }
            RecordStatus::Armed => self.looper.disarm(),
            RecordStatus::Idle => {}
        }
    }

    pub fn panic(&mut self) {
        self.synth.all_off();
        self.pending = None;
        for i in 0..SLOTS {
            let ch = if i < TRACKS {
                self.looper.tracks[i].midi_ch
            } else {
                self.settings.midi_live_channel
            };
            self.midi_ch[i].all_off(ch, &mut self.midi);
        }
        for s in self.track_state.iter_mut() {
            s.degree = 0;
            s.note_count = 0;
        }
        self.looper.reset_playback();
    }

    pub fn position(&self) -> PositionInfo {
        let (bar, beat, step, phase) = self.transport.position_info();
        PositionInfo {
            state: self.transport.state,
            bar,
            beat,
            step,
            phase,
            bpm: self.transport.bpm,
            beats: self.transport.sig.beats,
            unit: self.transport.sig.unit,
            bars: self.transport.bars,
            count_in: self.transport.count_in_number(),
            loop_count: self.transport.loop_count,
            recording: self.looper.status(),
            rec_track: self.looper.recording_track().map(|t| t as u8),
            selected: self.looper.selected as u8,
            position: self.transport.position,
            loop_len: self.transport.loop_len(),
            now: self.transport.now,
            last_beat: self.last_beat,
            last_beat_was_bar_start: self.last_beat_bar,
            beat_seq: self.beat_seq,
        }
    }

    // ----------------------------------------------------------------- process

    /// Render `out_l.len()` samples of stereo output plus the metronome cue bus
    /// (kept separate so recordings/exports can exclude it).
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32], cue: &mut [f32]) {
        let total = out_l.len().min(out_r.len()).min(cue.len());
        let mut done = 0;
        while done < total {
            let n = (total - done).min(MAX_BLOCK);
            self.process_block(
                &mut out_l[done..done + n],
                &mut out_r[done..done + n],
                &mut cue[done..done + n],
            );
            done += n;
        }
    }

    fn process_block(&mut self, out_l: &mut [f32], out_r: &mut [f32], cue: &mut [f32]) {
        let n = out_l.len();
        cue.iter_mut().for_each(|v| *v = 0.0);
        let pos_before = self.transport.position;
        let was_running = self.transport.is_running();
        let was_playing = self.transport.state == TransportState::Playing;
        let (ticks, wrapped) = self.transport.advance(n);
        let now = self.transport.now;

        // metronome + recording start at loop boundaries
        let mut loop_started = false;
        for t in ticks.iter() {
            if t.offset < n {
                self.synth.metronome.click(t.is_bar_start, self.sr);
                self.synth.metronome.render(cue, t.offset);
            }
            // count-in beats pulse the UI too
            self.beat_seq = self.beat_seq.wrapping_add(1);
            self.last_beat = t.beat;
            self.last_beat_bar = t.is_bar_start;
            if t.is_loop_start {
                loop_started = true;
            }
        }
        if self.synth.metronome.enabled && ticks.is_empty() {
            self.synth.metronome.render(cue, 0);
        }
        let count_in_finished = !was_playing && self.transport.state == TransportState::Playing;
        if (loop_started || wrapped || count_in_finished)
            && self.looper.status() == RecordStatus::Armed
        {
            self.looper.begin_recording(&self.transport);
            self.looper.record_initial_chord(&self.live);
        }

        // ----- live input: quantize chord onsets ---------------------------------
        self.scratch_events.clear();
        let recording = self.looper.status() == RecordStatus::Recording;
        let quantize_now = self.transport.state == TransportState::Playing
            && match self.settings.quantize_input {
                QuantizeInput::Off => false,
                QuantizeInput::Recording => recording,
                QuantizeInput::Always => true,
            };
        let live_pos = self.transport.position;
        for e in self
            .live_events
            .as_slice()
            .iter()
            .copied()
            .collect::<heapless_vec::Vec<Event, 32>>()
            .iter()
        {
            match e {
                Event::ChordOn { .. } if quantize_now => {
                    let (dist, behind) = self
                        .transport
                        .grid_distance(live_pos, self.looper.settings.quantize);
                    if behind || dist < n as u64 {
                        self.scratch_events.push(*e);
                        self.pending = None;
                    } else {
                        self.pending = Some(Pending {
                            event: *e,
                            due: now + dist,
                        });
                    }
                }
                Event::ChordOff if self.pending.is_some() => {
                    // a release before the pending onset fired: drop both
                    self.pending = None;
                    self.scratch_events.push(*e);
                }
                other => {
                    self.scratch_events.push(*other);
                }
            }
        }
        self.live_events.clear();
        if let Some(p) = self.pending {
            if now >= p.due {
                self.scratch_events.push(p.event);
                self.pending = None;
            }
        }
        // apply live events to the live slot + MIDI + UI
        let live_ch = self.settings.midi_live_channel;
        for e in self
            .scratch_events
            .as_slice()
            .iter()
            .copied()
            .collect::<heapless_vec::Vec<Event, 32>>()
            .iter()
        {
            self.apply_event(LIVE_SLOT, e, now);
            if self.settings.midi_enabled {
                self.midi_ch[LIVE_SLOT].apply(
                    live_ch,
                    e,
                    self.settings.midi_use_expression,
                    &mut self.midi,
                );
            }
            self.ui_events.push(*e);
        }
        // record
        if recording {
            let evs = self.scratch_events;
            let pos = self.transport.position;
            let live = self.live;
            self.looper
                .record(pos, &live, evs.as_slice(), &self.transport);
        } else if self.was_recording && wrapped {
            // recording ended exactly at the wrap
        }
        self.was_recording = recording;

        // ----- loop playback ----------------------------------------------------
        if self.transport.state == TransportState::Playing && was_running {
            let from = pos_before;
            let to = if wrapped {
                self.transport.loop_len()
            } else {
                self.transport.position
            };
            for tr in 0..TRACKS {
                let rec_here = self.looper.recording_track() == Some(tr)
                    && recording
                    && self.looper.settings.record_mode == RecordMode::Replace;
                if rec_here {
                    continue; // replace-recording: the old content is gone anyway
                }
                self.scratch_events.clear();
                self.looper
                    .playback(tr, from, to, &self.transport, &mut self.scratch_events);
                if wrapped && self.transport.position > 0 {
                    self.looper.playback(
                        tr,
                        0,
                        self.transport.position,
                        &self.transport,
                        &mut self.scratch_events,
                    );
                }
                let ch = self.looper.tracks[tr].midi_ch;
                for e in self
                    .scratch_events
                    .as_slice()
                    .iter()
                    .copied()
                    .collect::<heapless_vec::Vec<Event, 32>>()
                    .iter()
                {
                    self.apply_event(tr, e, now);
                    if self.settings.midi_enabled {
                        self.midi_ch[tr].apply(
                            ch,
                            e,
                            self.settings.midi_use_expression,
                            &mut self.midi,
                        );
                    }
                }
                let (c, v, p) =
                    self.looper
                        .curve_values(tr, self.transport.position, &self.transport);
                let ts = &mut self.track_state[tr];
                ts.cutoff = c;
                ts.volume = v;
                ts.pan = p;
                ts.key = self.key;
                ts.mode = self.mode;
                if self.settings.midi_enabled {
                    self.midi_ch[tr].apply(
                        ch,
                        &Event::ParamChange {
                            cutoff: c,
                            volume: v * self.looper.tracks[tr].volume,
                            pan: p,
                        },
                        self.settings.midi_use_expression,
                        &mut self.midi,
                    );
                }
            }
        }

        // ----- bass one-shot releases ---------------------------------------------
        for i in 0..SLOTS {
            if self.bass_release_at[i] != 0 && now >= self.bass_release_at[i] {
                self.synth.slots[i].bass_release();
                self.bass_release_at[i] = 0;
            }
        }

        // ----- slot params ------------------------------------------------------------
        let spb = self.transport.samples_per_beat();
        let arp_div = |rate: f32| -> f32 {
            let table = [1.0, 2.0, 3.0, 4.0, 6.0, 8.0];
            table[((rate.clamp(0.0, 0.999)) * table.len() as f32) as usize]
        };
        for tr in 0..TRACKS {
            let t = &self.looper.tracks[tr];
            let ts = self.track_state[tr];
            self.params[tr] = SlotParams {
                cutoff: ts.cutoff,
                volume: ts.volume,
                pan: ts.pan,
                arp: ts.arp,
                arp_period: (spb / arp_div(ts.arp_rate) as f64) as u32,
                gain: t.volume,
                track_pan: t.pan,
                audible: self.looper.audible(tr),
            };
        }
        let live = self.live;
        self.params[LIVE_SLOT] = SlotParams {
            cutoff: live.cutoff,
            volume: live.volume,
            pan: live.pan,
            arp: live.arp,
            arp_period: (spb / arp_div(live.arp_rate) as f64) as u32,
            gain: 1.0,
            track_pan: 0.0,
            audible: true,
        };
        let theremin = if live.theremin {
            Some((
                live.theremin_pitch_hz,
                live.theremin_volume,
                live.theremin_vibrato,
                live.cutoff,
            ))
        } else {
            None
        };
        let params = self.params;
        self.synth.render(out_l, out_r, &params, theremin);
    }

    fn apply_event(&mut self, slot: usize, e: &Event, now: u64) {
        match e {
            Event::ChordOn {
                notes,
                count,
                degree,
                quality,
                shape,
                octave,
            } => {
                self.synth.slots[slot].chord_on(&notes[..(*count as usize).min(4)]);
                if slot < TRACKS {
                    let ts = &mut self.track_state[slot];
                    ts.notes = *notes;
                    ts.note_count = *count;
                    ts.degree = *degree;
                    ts.quality = *quality;
                    ts.shape = *shape;
                    ts.octave = *octave;
                }
            }
            Event::ChordOff => {
                self.synth.slots[slot].chord_off();
                if slot < TRACKS {
                    self.track_state[slot].degree = 0;
                    self.track_state[slot].note_count = 0;
                }
            }
            Event::BassHit { note } => {
                self.synth.slots[slot].bass_hit(*note);
                self.bass_release_at[slot] = now + (self.sr * 0.25) as u64;
            }
            Event::ArpToggle { on } if slot < TRACKS => {
                self.track_state[slot].arp = *on;
            }
            _ => {}
        }
    }

    // ----------------------------------------------------------------- sessions

    pub fn to_session(&self) -> SessionFile {
        let mut s = SessionFile::new(
            &self.transport,
            self.key,
            self.mode,
            self.looper.tracks.clone(),
        );
        s.loop_settings = self.looper.settings;
        s.instrument_presets = vec![self.synth.slots[LIVE_SLOT].inst.clone()];
        s
    }

    pub fn load_session(&mut self, s: &SessionFile) {
        self.stop();
        s.transport.apply(&mut self.transport);
        self.key = s.key;
        self.mode = s.mode;
        self.looper.settings = s.loop_settings;
        self.looper.load_tracks(s.tracks.clone());
        for i in 0..TRACKS {
            let inst = self.looper.tracks[i].instrument.clone();
            self.synth.slots[i].set_instrument(inst);
        }
        if let Some(inst) = s.instrument_presets.first() {
            self.synth.slots[LIVE_SLOT].set_instrument(inst.clone());
        }
        self.synth
            .master
            .delay
            .sync_to_beat(self.transport.samples_per_beat(), 0.75);
    }

    /// Offline bounce of a session: `passes` loops, stereo interleaved f32, no metronome.
    pub fn render_offline(session: &SessionFile, sr: f32, passes: u32) -> Vec<f32> {
        let mut e = Engine::new(sr);
        e.load_session(session);
        e.settings.metronome_enabled = false;
        e.synth.metronome.enabled = false;
        e.play();
        let total = e.transport.loop_len() * passes.max(1) as u64 + (sr * 1.5) as u64; // tail for reverb
        let mut out = Vec::with_capacity(total as usize * 2);
        let mut l = [0f32; MAX_BLOCK];
        let mut r = [0f32; MAX_BLOCK];
        let mut c = [0f32; MAX_BLOCK];
        let mut done = 0u64;
        while done < total {
            let n = ((total - done) as usize).min(MAX_BLOCK);
            if done >= e.transport.loop_len() * passes.max(1) as u64 && e.transport.is_running() {
                e.stop();
            }
            e.process(&mut l[..n], &mut r[..n], &mut c[..n]);
            for i in 0..n {
                out.push(l[i]);
                out.push(r[i]);
            }
            done += n as u64;
        }
        out
    }
}

/// Tiny fixed-capacity vector used to copy event lists out of `self` before
/// mutating `self` (borrow checker friendly, no allocation).
mod heapless_vec {
    pub struct Vec<T: Copy, const N: usize> {
        items: [Option<T>; N],
        len: usize,
    }
    impl<T: Copy, const N: usize> Vec<T, N> {
        pub fn iter(&self) -> impl Iterator<Item = &T> {
            self.items[..self.len].iter().map(|i| i.as_ref().unwrap())
        }
    }
    impl<T: Copy, const N: usize> FromIterator<T> for Vec<T, N> {
        fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
            let mut v = Self {
                items: [None; N],
                len: 0,
            };
            for it in iter {
                if v.len < N {
                    v.items[v.len] = Some(it);
                    v.len += 1;
                }
            }
            v
        }
    }
}

/// Encode stereo interleaved f32 as a 16-bit PCM WAV file.
pub fn wav_from_f32(interleaved: &[f32], sr: u32) -> Vec<u8> {
    let data_len = interleaved.len() * 2;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&2u16.to_le_bytes()); // stereo
    out.extend_from_slice(&sr.to_le_bytes());
    out.extend_from_slice(&(sr * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for s in interleaved {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::music::VoicingSettings;

    fn chord_state(degree: u8) -> MusicalState {
        let mut s = MusicalState {
            degree,
            volume: 0.8,
            cutoff: 0.8,
            ..Default::default()
        };
        s.derive_notes(VoicingSettings::default());
        s
    }

    fn run(e: &mut Engine, blocks: usize) -> f32 {
        let mut l = [0f32; 128];
        let mut r = [0f32; 128];
        let mut c = [0f32; 128];
        let mut peak = 0.0f32;
        for _ in 0..blocks {
            e.process(&mut l, &mut r, &mut c);
            peak = peak.max(l.iter().fold(0.0f32, |a, v| a.max(v.abs())));
        }
        peak
    }

    #[test]
    fn live_chord_sounds_without_transport() {
        let mut e = Engine::new(48_000.0);
        let s = chord_state(1);
        e.set_live(s, &[Event::chord_on_from(&s)]);
        let peak = run(&mut e, 100);
        assert!(peak > 0.01, "peak {peak}");
        let mut off = s;
        off.degree = 0;
        off.note_count = 0;
        e.set_live(off, &[Event::ChordOff]);
        e.settings.reverb_enabled = false;
        e.synth.master.reverb_enabled = false;
        e.synth.master.delay_enabled = false;
        run(&mut e, 1500);
        let tail = run(&mut e, 10);
        assert!(tail < 1e-3, "tail {tail}");
    }

    #[test]
    fn full_record_and_playback_flow() {
        let mut e = Engine::new(48_000.0);
        e.command(EngineCommand::SetBpm { bpm: 120.0 });
        e.command(EngineCommand::SetBars { bars: 1 });
        e.settings.metronome_enabled = false;
        e.synth.metronome.enabled = false;
        // record on track 1 with a 1-bar count-in
        e.command(EngineCommand::Record { track: 0 });
        assert_eq!(e.position().state, TransportState::CountIn);
        assert_eq!(e.position().count_in, Some(1));
        // during count-in hold a I chord
        let s1 = chord_state(1);
        e.set_live(s1, &[Event::chord_on_from(&s1)]);
        let blocks_per_bar = 96_000 / 128;
        run(&mut e, blocks_per_bar + 2);
        assert_eq!(e.position().state, TransportState::Playing);
        assert_eq!(e.position().recording, RecordStatus::Recording);
        // half a bar later change to IV
        run(&mut e, blocks_per_bar / 2);
        let s4 = chord_state(4);
        e.set_live(s4, &[Event::chord_on_from(&s4)]);
        run(&mut e, blocks_per_bar / 2 + 4);
        // recording should have finished at loop end, transport still playing
        assert_eq!(e.position().recording, RecordStatus::Idle);
        assert_eq!(e.position().state, TransportState::Playing);
        let tr = &e.looper.tracks[0];
        assert!(tr.events.len() >= 2, "events {:?}", tr.events);
        assert_eq!(tr.events[0].t, 0);
        let iv = tr
            .events
            .iter()
            .find(|ev| matches!(ev.event, Event::ChordOn { degree: 4, .. }))
            .expect("IV recorded");
        assert_eq!(iv.t % 6000, 0, "quantized to a 16th");
        assert!(
            (iv.t as i64 - 48_000).abs() <= 6000,
            "IV near beat 3: {}",
            iv.t
        );
        // live hand goes silent; the track should play on its own
        let mut off = s4;
        off.degree = 0;
        off.note_count = 0;
        off.volume = 0.0;
        e.set_live(off, &[Event::ChordOff]);
        run(&mut e, 20);
        let peak = run(&mut e, 50);
        assert!(peak > 0.005, "loop playback should be audible, peak {peak}");
        assert!(e.track_state(0).has_chord());
        // grid
        let g = e.looper.grid(&e.transport);
        assert_eq!(g[0][0].unwrap().degree, 1);
        assert_eq!(g[0][15].unwrap().degree, 4);
        // session roundtrip
        let sess = e.to_session();
        let json = sess.to_json();
        let back = SessionFile::from_json(&json).unwrap();
        assert_eq!(back.tracks[0].events, e.looper.tracks[0].events);
        // stop silences loop
        e.command(EngineCommand::Stop);
        assert_eq!(e.position().state, TransportState::Stopped);
        assert!(!e.track_state(0).has_chord());
    }

    #[test]
    fn offline_render_produces_audio_and_wav() {
        let mut e = Engine::new(48_000.0);
        e.command(EngineCommand::SetBpm { bpm: 120.0 });
        e.command(EngineCommand::SetBars { bars: 1 });
        let s = chord_state(5);
        e.looper.tracks[0].events.push(crate::looper::TimedEvent {
            t: 0,
            event: Event::chord_on_from(&s),
        });
        let sess = e.to_session();
        let audio = Engine::render_offline(&sess, 48_000.0, 1);
        assert_eq!(audio.len() as u64, (96_000 + 72_000) * 2);
        let peak = audio.iter().fold(0.0f32, |a, v| a.max(v.abs()));
        assert!(peak > 0.01, "peak {peak}");
        let wav = wav_from_f32(&audio, 48_000);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(wav.len(), 44 + audio.len() * 2);
    }

    #[test]
    fn commands_and_panic() {
        let mut e = Engine::new(48_000.0);
        e.command(EngineCommand::SetTimeSig { beats: 6, unit: 8 });
        e.command(EngineCommand::ToggleMute { track: 2 });
        e.command(EngineCommand::SetTrackVolume {
            track: 1,
            volume: 2.0,
        });
        assert!(e.looper.tracks[2].mute);
        assert_eq!(e.looper.tracks[1].volume, 1.0);
        assert_eq!(e.position().beats, 6);
        e.command(EngineCommand::Play);
        assert_eq!(e.position().state, TransportState::Playing);
        e.command(EngineCommand::Panic);
        e.command(EngineCommand::TogglePlay);
        assert_eq!(e.position().state, TransportState::Stopped);
    }
}
