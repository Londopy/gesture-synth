//! Loop pedal (spec section 7). Loops are EVENT streams with timestamps, not
//! audio: playback re-synthesizes them, so instruments can change after the
//! fact, steps can be muted, and files stay tiny.

use crate::curve::{Curve, CurveRecorder};
use crate::instruments::Instrument;
use crate::music::{Quality, Shape};
use crate::state::{Event, EventList, MusicalState};
use crate::transport::{Quantize, Transport};
use serde::{Deserialize, Serialize};

pub const TRACKS: usize = 4;
/// 16 bars x 16 steps is the largest grid (7/8 x 16 bars = 224).
pub const MAX_STEPS: usize = 256;

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct TimedEvent {
    /// Loop position in samples.
    pub t: u64,
    pub event: Event,
}

/// Landmarks stored at 15 Hz for ghost playback (spec 8 "Loop visuals").
/// Each hand is 63 floats (21 x xyz) in frame coordinates, or absent.
#[derive(Clone, PartialEq, Debug, Default, Serialize, Deserialize)]
pub struct LandmarkFrame {
    pub t: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<Vec<f32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<Vec<f32>>,
}

#[derive(Clone, PartialEq, Debug, Default, Serialize, Deserialize)]
pub struct Curves {
    pub cutoff: Curve,
    pub volume: Curve,
    pub pan: Curve,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Track {
    pub name: String,
    pub instrument: Instrument,
    pub volume: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    /// MIDI channel 1..16.
    pub midi_ch: u8,
    /// Track length in bars (0 = same as the global loop). Must divide the global length.
    #[serde(default)]
    pub length_bars: u8,
    pub events: Vec<TimedEvent>,
    pub curves: Curves,
    #[serde(default)]
    pub landmarks15hz: Vec<LandmarkFrame>,
    pub step_mutes: Vec<bool>,
}

impl Track {
    pub fn new(index: usize) -> Self {
        let inst = crate::instruments::builtin_by_index([0, 1, 3, 4][index % 4]);
        Self {
            name: format!("Track {}", index + 1),
            instrument: inst,
            volume: 0.8,
            pan: 0.0,
            mute: false,
            solo: false,
            midi_ch: (index as u8 % 16) + 1,
            length_bars: 0,
            events: Vec::new(),
            curves: Curves::default(),
            landmarks15hz: Vec::new(),
            step_mutes: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn clear(&mut self) {
        self.events.clear();
        self.curves = Curves::default();
        self.landmarks15hz.clear();
        self.step_mutes.clear();
    }

    /// Track length in samples given the transport.
    pub fn len_samples(&self, t: &Transport) -> u64 {
        if self.length_bars == 0 || self.length_bars >= t.bars {
            t.loop_len()
        } else {
            (t.samples_per_bar() * self.length_bars as f64).round() as u64
        }
    }

    pub fn steps(&self, t: &Transport) -> usize {
        let bars = if self.length_bars == 0 || self.length_bars >= t.bars {
            t.bars
        } else {
            self.length_bars
        };
        (t.sig.steps_per_bar() as usize * bars as usize).min(MAX_STEPS)
    }

    /// The chord that is active at each 16th step (before mutes are applied).
    pub fn step_chords(&self, t: &Transport) -> Vec<Option<ChordCell>> {
        let steps = self.steps(t);
        let sps = t.samples_per_step();
        let mut out = vec![None; steps];
        // Find the chord active at the start of each step: the last ChordOn/Off before (or at) step start.
        // Because chords may wrap, start from the last event in the loop.
        let mut current: Option<ChordCell> = None;
        if self.wraps_chord() {
            current = self.last_chord_event().map(ChordCell::from_event);
        }
        let mut ei = 0;
        let len = self.len_samples(t);
        for s in 0..steps {
            let start = (s as f64 * sps).round() as u64;
            let end = (((s + 1) as f64) * sps).round().min(len as f64) as u64;
            // apply events in [start, end) ... but the cell should reflect the chord for most of the
            // step: use events up to the step midpoint so quantized ChordOns land on their step.
            let mid = start + (end.saturating_sub(start)) / 2;
            while ei < self.events.len() && self.events[ei].t <= mid {
                match self.events[ei].event {
                    e @ Event::ChordOn { .. } => current = Some(ChordCell::from_event(e)),
                    Event::ChordOff => current = None,
                    _ => {}
                }
                ei += 1;
            }
            if let Some(mut c) = current {
                c.volume = self.curves.volume.value_at(start, len, 0.8);
                out[s] = Some(c);
            }
        }
        out
    }

    fn last_chord_event(&self) -> Option<Event> {
        self.events.iter().rev().find_map(|e| match e.event {
            Event::ChordOn { .. } => Some(e.event),
            Event::ChordOff => Some(Event::ChordOff),
            _ => None,
        })
    }

    /// True when a chord is still sounding at loop end (no ChordOff after the last ChordOn).
    pub fn wraps_chord(&self) -> bool {
        matches!(self.last_chord_event(), Some(Event::ChordOn { .. }))
    }

    pub fn step_muted(&self, step: usize) -> bool {
        self.step_mutes.get(step).copied().unwrap_or(false)
    }

    pub fn set_step_mute(&mut self, step: usize, muted: bool) {
        if step >= MAX_STEPS {
            return;
        }
        if self.step_mutes.len() <= step {
            self.step_mutes.resize(step + 1, false);
        }
        self.step_mutes[step] = muted;
    }

    /// Replace the chord covering `step` (or insert one there) with the given chord.
    pub fn replace_chord_at_step(&mut self, step: usize, t: &Transport, chord: Event) {
        let Event::ChordOn { .. } = chord else { return };
        let sps = t.samples_per_step();
        let start = (step as f64 * sps).round() as u64;
        let next = ((step + 1) as f64 * sps).round() as u64;
        // find the ChordOn active at this step
        let mut idx: Option<usize> = None;
        for (i, e) in self.events.iter().enumerate() {
            if e.t > start + (sps / 2.0) as u64 {
                break;
            }
            match e.event {
                Event::ChordOn { .. } => idx = Some(i),
                Event::ChordOff => idx = None,
                _ => {}
            }
        }
        match idx {
            Some(i) => self.events[i].event = chord,
            None => {
                // insert a one-step chord
                self.events.push(TimedEvent {
                    t: start,
                    event: chord,
                });
                let has_event_in_step = self.events.iter().any(|e| {
                    e.t > start
                        && e.t < next
                        && matches!(e.event, Event::ChordOn { .. } | Event::ChordOff)
                });
                if !has_event_in_step {
                    self.events.push(TimedEvent {
                        t: next.saturating_sub(1),
                        event: Event::ChordOff,
                    });
                }
                self.events.sort_by_key(|e| e.t);
            }
        }
    }

    /// Merge a finished recording into this track.
    fn merge(&mut self, rec: Recording, mode: RecordMode) {
        match mode {
            RecordMode::Replace => {
                self.events = rec.events;
                self.curves = rec.curves;
            }
            RecordMode::Overdub => {
                if self.events.is_empty() {
                    self.events = rec.events;
                    self.curves = rec.curves;
                } else {
                    self.events.extend(rec.events);
                    self.events.sort_by_key(|e| e.t);
                    self.curves.cutoff.overdub(&rec.curves.cutoff);
                    self.curves.volume.overdub(&rec.curves.volume);
                    self.curves.pan.overdub(&rec.curves.pan);
                }
            }
        }
    }
}

/// Grid cell for the beat-grid panel: what chord is active on a step.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct ChordCell {
    pub degree: u8,
    pub quality: Quality,
    pub shape: Shape,
    pub octave: i8,
    pub notes: [u8; 4],
    pub count: u8,
    pub volume: f32,
}

impl ChordCell {
    fn from_event(e: Event) -> Self {
        match e {
            Event::ChordOn {
                notes,
                count,
                degree,
                quality,
                shape,
                octave,
            } => Self {
                degree,
                quality,
                shape,
                octave,
                notes,
                count,
                volume: 0.8,
            },
            _ => Self {
                degree: 0,
                quality: Quality::Major,
                shape: Shape::Root,
                octave: 0,
                notes: [0; 4],
                count: 0,
                volume: 0.0,
            },
        }
    }

    pub fn to_event(&self) -> Event {
        Event::ChordOn {
            notes: self.notes,
            count: self.count,
            degree: self.degree,
            quality: self.quality,
            shape: self.shape,
            octave: self.octave,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordMode {
    #[default]
    Overdub,
    Replace,
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct LoopSettings {
    pub quantize: Quantize,
    /// A chord still sounding at loop end continues from bar 1 (true) or is cut (false).
    pub wrap_at_loop_end: bool,
    pub record_mode: RecordMode,
    /// Keep recording (overdubbing) into the same track after the loop ends.
    pub loop_record: bool,
    pub count_in_bars: u8,
    /// RDP tolerance for curves (value units).
    pub curve_eps: f32,
}

impl Default for LoopSettings {
    fn default() -> Self {
        Self {
            quantize: Quantize::Sixteenth,
            wrap_at_loop_end: true,
            record_mode: RecordMode::Overdub,
            loop_record: false,
            count_in_bars: 1,
            curve_eps: 0.01,
        }
    }
}

/// Finished recording ready to merge.
struct Recording {
    events: Vec<TimedEvent>,
    curves: Curves,
}

struct RecordSession {
    track: usize,
    events: Vec<TimedEvent>,
    cutoff: CurveRecorder,
    volume: CurveRecorder,
    pan: CurveRecorder,
    len: u64,
    last_pos: u64,
    started: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordStatus {
    Idle,
    Armed,
    Recording,
}

/// Runtime per-track playback state (audio thread, fixed size).
#[derive(Clone, Copy)]
struct TrackRuntime {
    playing: Option<Event>,
    last_step: i64,
    /// Cached chord-per-step table, rebuilt on edits.
    step_chord: [Option<ChordCell>; MAX_STEPS],
    steps: usize,
    dirty: bool,
}

impl Default for TrackRuntime {
    fn default() -> Self {
        Self {
            playing: None,
            last_step: -1,
            step_chord: [None; MAX_STEPS],
            steps: 0,
            dirty: true,
        }
    }
}

pub struct LoopEngine {
    pub tracks: Vec<Track>,
    pub selected: usize,
    pub settings: LoopSettings,
    rt: [TrackRuntime; TRACKS],
    rec: Option<RecordSession>,
    armed: Option<usize>,
    sample_rate: f32,
}

impl LoopEngine {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            tracks: (0..TRACKS).map(Track::new).collect(),
            selected: 0,
            settings: LoopSettings::default(),
            rt: [TrackRuntime::default(); TRACKS],
            rec: None,
            armed: None,
            sample_rate,
        }
    }

    pub fn set_sample_rate(&mut self, sr: f32) {
        self.sample_rate = sr;
    }

    pub fn status(&self) -> RecordStatus {
        if self.rec.as_ref().map(|r| r.started).unwrap_or(false) {
            RecordStatus::Recording
        } else if self.armed.is_some() || self.rec.is_some() {
            RecordStatus::Armed
        } else {
            RecordStatus::Idle
        }
    }

    pub fn recording_track(&self) -> Option<usize> {
        self.rec.as_ref().map(|r| r.track).or(self.armed)
    }

    pub fn mark_dirty(&mut self, track: usize) {
        if track < TRACKS {
            self.rt[track].dirty = true;
        }
    }

    pub fn mark_all_dirty(&mut self) {
        for r in self.rt.iter_mut() {
            r.dirty = true;
        }
    }

    /// Whether a track should be heard given mute/solo.
    pub fn audible(&self, track: usize) -> bool {
        let any_solo = self.tracks.iter().any(|t| t.solo);
        let t = &self.tracks[track];
        !t.mute && (!any_solo || t.solo)
    }

    /// Arm a track: recording begins at the next loop start (after count-in).
    pub fn arm(&mut self, track: usize) {
        self.armed = Some(track.min(TRACKS - 1));
        self.rec = None;
    }

    pub fn disarm(&mut self) {
        self.armed = None;
        self.rec = None;
    }

    /// Called by the engine at loop start (bar 1 beat 1) while armed.
    pub fn begin_recording(&mut self, transport: &Transport) {
        let Some(track) = self.armed.take() else {
            return;
        };
        let len = self.tracks[track].len_samples(transport);
        if self.settings.record_mode == RecordMode::Replace {
            self.tracks[track].clear();
            self.rt[track] = TrackRuntime::default();
        }
        self.rec = Some(RecordSession {
            track,
            events: Vec::with_capacity(1024),
            cutoff: CurveRecorder::new(self.sample_rate),
            volume: CurveRecorder::new(self.sample_rate),
            pan: CurveRecorder::new(self.sample_rate),
            len,
            last_pos: 0,
            started: true,
        });
    }

    /// Record the live state + events at loop position `pos`. Returns true if the
    /// recording just completed (track length reached).
    pub fn record(
        &mut self,
        pos: u64,
        state: &MusicalState,
        events: &[Event],
        transport: &Transport,
    ) -> bool {
        let Some(rec) = self.rec.as_mut() else {
            return false;
        };
        if !rec.started {
            return false;
        }
        let wrapped = pos < rec.last_pos;
        rec.last_pos = pos;
        if wrapped || pos >= rec.len {
            // finished one pass of the track
            let done = self.finish_recording(transport);
            return done;
        }
        for e in events {
            match e {
                Event::ChordOn { .. }
                | Event::ChordOff
                | Event::BassHit { .. }
                | Event::ArpToggle { .. } => {
                    rec.events.push(TimedEvent { t: pos, event: *e });
                }
                _ => {}
            }
        }
        rec.cutoff.offer(pos, state.cutoff);
        rec.volume.offer(pos, state.volume);
        rec.pan.offer(pos, state.pan);
        false
    }

    /// If a chord is sounding when recording starts, capture it at t=0.
    pub fn record_initial_chord(&mut self, state: &MusicalState) {
        if let Some(rec) = self.rec.as_mut() {
            if rec.started && rec.events.is_empty() && state.has_chord() {
                rec.events.push(TimedEvent {
                    t: 0,
                    event: Event::chord_on_from(state),
                });
            }
        }
    }

    /// Finalize: quantize, simplify, wrap/cut, merge. Returns true.
    pub fn finish_recording(&mut self, transport: &Transport) -> bool {
        let Some(mut rec) = self.rec.take() else {
            return false;
        };
        let q = self.settings.quantize;
        let len = rec.len.max(1);
        for e in rec.events.iter_mut() {
            if matches!(e.event, Event::ChordOn { .. }) {
                e.t = transport.quantize_pos(e.t, q);
                if e.t >= len {
                    e.t = 0;
                }
            }
        }
        rec.events.sort_by_key(|e| e.t);
        // collapse duplicates that quantized onto the same instant: keep the last ChordOn
        let mut cleaned: Vec<TimedEvent> = Vec::with_capacity(rec.events.len());
        for e in rec.events.drain(..) {
            if let Some(last) = cleaned.last_mut() {
                if last.t == e.t
                    && matches!(e.event, Event::ChordOn { .. })
                    && matches!(last.event, Event::ChordOn { .. } | Event::ChordOff)
                {
                    *last = e;
                    continue;
                }
            }
            cleaned.push(e);
        }
        // a ChordOff that precedes a ChordOn quantized to the same/earlier time is noise
        let mut i = 0;
        while i + 1 < cleaned.len() {
            if matches!(cleaned[i].event, Event::ChordOff)
                && matches!(cleaned[i + 1].event, Event::ChordOn { .. })
                && cleaned[i + 1].t <= cleaned[i].t
            {
                cleaned.remove(i);
            } else {
                i += 1;
            }
        }
        let still_sounding = matches!(
            cleaned
                .iter()
                .rev()
                .find(|e| matches!(e.event, Event::ChordOn { .. } | Event::ChordOff))
                .map(|e| e.event),
            Some(Event::ChordOn { .. })
        );
        if still_sounding && !self.settings.wrap_at_loop_end {
            cleaned.push(TimedEvent {
                t: len - 1,
                event: Event::ChordOff,
            });
        }
        let eps = self.settings.curve_eps;
        let mut curves = Curves {
            cutoff: rec.cutoff.finish(eps),
            volume: rec.volume.finish(eps),
            pan: rec.pan.finish(eps),
        };
        curves.cutoff.truncate_to(len);
        curves.volume.truncate_to(len);
        curves.pan.truncate_to(len);
        let track = rec.track;
        self.tracks[track].merge(
            Recording {
                events: cleaned,
                curves,
            },
            self.settings.record_mode,
        );
        self.rt[track].dirty = true;
        if self.settings.loop_record {
            // keep going: a fresh overdub pass on the same track
            self.armed = Some(track);
            self.begin_recording(transport);
        }
        true
    }

    pub fn cancel_recording(&mut self) {
        self.rec = None;
        self.armed = None;
    }

    fn rebuild(&mut self, track: usize, transport: &Transport) {
        let cells = self.tracks[track].step_chords(transport);
        let rt = &mut self.rt[track];
        rt.steps = cells.len();
        for (i, c) in rt.step_chord.iter_mut().enumerate() {
            *c = cells.get(i).copied().flatten();
        }
        rt.dirty = false;
    }

    /// Produce the playback events for `track` over the global position range
    /// [from, to) (no wrap inside the range). Step mutes are applied here.
    pub fn playback(
        &mut self,
        track: usize,
        from: u64,
        to: u64,
        transport: &Transport,
        out: &mut EventList,
    ) {
        if self.rt[track].dirty {
            self.rebuild(track, transport);
        }
        let tlen = self.tracks[track].len_samples(transport).max(1);
        let sps = transport.samples_per_step();
        // split at track wrap boundaries
        let mut a = from;
        while a < to {
            let ta = a % tlen;
            let room = tlen - ta;
            let chunk = (to - a).min(room);
            let tb = ta + chunk;
            self.playback_chunk(track, ta, tb, sps, out);
            a += chunk;
        }
    }

    fn playback_chunk(&mut self, track: usize, ta: u64, tb: u64, sps: f64, out: &mut EventList) {
        let steps = self.rt[track].steps.max(1);
        let cur_step = |t: u64| ((t as f64 / sps).floor() as usize) % steps;
        // 1) explicit events in range (events are sorted; tracks hold tens to hundreds of events)
        let n = self.tracks[track].events.len();
        for i in 0..n {
            let e = self.tracks[track].events[i];
            if e.t < ta || e.t >= tb {
                continue;
            }
            match e.event {
                Event::ChordOn { .. } => {
                    if self.tracks[track].step_muted(cur_step(e.t)) {
                        if self.rt[track].playing.is_some() {
                            out.push(Event::ChordOff);
                            self.rt[track].playing = None;
                        }
                    } else if self.rt[track].playing != Some(e.event) {
                        out.push(e.event);
                        self.rt[track].playing = Some(e.event);
                    }
                }
                Event::ChordOff => {
                    if self.rt[track].playing.is_some() {
                        out.push(Event::ChordOff);
                        self.rt[track].playing = None;
                    }
                }
                other => {
                    out.push(other);
                }
            }
        }
        // 2) step boundaries crossed in [ta, tb): mute gating. A chord is cut when
        //    its step is muted and restored when leaving a muted step (or when
        //    playback starts fresh inside a chord that has no event at this point,
        //    e.g. one that wrapped around the loop end).
        let first_step = (ta as f64 / sps).ceil() as i64;
        let last_step = (tb as f64 / sps).ceil() as i64;
        let mut s = first_step;
        while s < last_step {
            let step = (s as usize) % steps;
            let prev_step = (step + steps - 1) % steps;
            let muted = self.tracks[track].step_muted(step);
            let should = self.rt[track].step_chord[step];
            let fresh = self.rt[track].last_step < 0;
            match (muted, self.rt[track].playing, should) {
                (true, Some(_), _) => {
                    out.push(Event::ChordOff);
                    self.rt[track].playing = None;
                }
                (false, None, Some(cell)) if fresh || self.tracks[track].step_muted(prev_step) => {
                    let e = cell.to_event();
                    out.push(e);
                    self.rt[track].playing = Some(e);
                }
                _ => {}
            }
            self.rt[track].last_step = s;
            s += 1;
        }
    }

    /// Current curve values for a track at global position `pos`.
    pub fn curve_values(&self, track: usize, pos: u64, transport: &Transport) -> (f32, f32, f32) {
        let t = &self.tracks[track];
        let tlen = t.len_samples(transport).max(1);
        let p = pos % tlen;
        (
            t.curves.cutoff.value_at(p, tlen, 0.7),
            t.curves.volume.value_at(p, tlen, 0.8),
            t.curves.pan.value_at(p, tlen, 0.0),
        )
    }

    /// What the track is currently sounding (for ghosts / HUD).
    pub fn playing(&self, track: usize) -> Option<Event> {
        self.rt[track].playing
    }

    /// Reset playback cursors (transport stopped or jumped).
    pub fn reset_playback(&mut self) {
        for r in self.rt.iter_mut() {
            r.playing = None;
            r.last_step = -1;
        }
    }

    pub fn clear_track(&mut self, track: usize) {
        self.tracks[track].clear();
        self.rt[track] = TrackRuntime::default();
    }

    pub fn clear_all(&mut self) {
        for i in 0..TRACKS {
            self.clear_track(i);
        }
        self.rec = None;
        self.armed = None;
    }

    pub fn toggle_step_mute(&mut self, track: usize, step: usize) -> bool {
        let m = !self.tracks[track].step_muted(step);
        self.tracks[track].set_step_mute(step, m);
        m
    }

    /// Grid for the UI: rows = tracks, cells = chord or None (mute flag separate).
    pub fn grid(&self, transport: &Transport) -> Vec<Vec<Option<ChordCell>>> {
        self.tracks
            .iter()
            .map(|t| t.step_chords(transport))
            .collect()
    }

    /// Replace tracks wholesale (session load).
    pub fn load_tracks(&mut self, tracks: Vec<Track>) {
        let mut tracks = tracks;
        tracks.truncate(TRACKS);
        while tracks.len() < TRACKS {
            tracks.push(Track::new(tracks.len()));
        }
        self.tracks = tracks;
        self.rt = [TrackRuntime::default(); TRACKS];
        self.rec = None;
        self.armed = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::music::VoicingSettings;

    fn transport() -> Transport {
        let mut t = Transport::new(48_000.0);
        t.set_bpm(120.0); // beat 24000, step 6000, bar 96000
        t.set_bars(1);
        t
    }

    fn chord(degree: u8) -> MusicalState {
        let mut s = MusicalState {
            degree,
            volume: 0.8,
            ..Default::default()
        };
        s.derive_notes(VoicingSettings::default());
        s
    }

    #[test]
    fn record_quantize_and_playback() {
        let t = transport();
        let mut lp = LoopEngine::new(48_000.0);
        lp.arm(0);
        lp.begin_recording(&t);
        assert_eq!(lp.status(), RecordStatus::Recording);
        let c1 = chord(1);
        let c4 = chord(4);
        // I at 700 samples (should quantize to 0), IV at 47_500 (-> 48_000 = beat 3)
        let mut done = false;
        let mut pos = 0u64;
        while pos < t.loop_len() {
            let mut evs: Vec<Event> = Vec::new();
            let st = if pos < 47_500 { c1 } else { c4 };
            if pos == 640 {
                evs.push(Event::chord_on_from(&c1));
            }
            if pos == 47_488 {
                evs.push(Event::chord_on_from(&c4));
            }
            done |= lp.record(pos, &st, &evs, &t);
            pos += 128;
        }
        done |= lp.record(0, &c4, &[], &t); // wrap
        assert!(done);
        let tr = &lp.tracks[0];
        assert_eq!(tr.events.len(), 2);
        assert_eq!(tr.events[0].t, 0);
        assert_eq!(tr.events[1].t, 48_000);
        assert!(tr.wraps_chord());
        assert!(!tr.curves.volume.is_empty());

        // playback over the loop should emit both ChordOns
        let mut out = EventList::new();
        let mut pos = 0u64;
        let mut ons = 0;
        while pos < t.loop_len() {
            out.clear();
            lp.playback(0, pos, pos + 128, &t, &mut out);
            ons += out.as_slice().iter().filter(|e| e.is_chord_on()).count();
            pos += 128;
        }
        assert_eq!(ons, 2);
        // grid: steps 0..8 = I, 8..16 = IV
        let g = lp.grid(&t);
        assert_eq!(g[0].len(), 16);
        assert_eq!(g[0][0].unwrap().degree, 1);
        assert_eq!(g[0][7].unwrap().degree, 1);
        assert_eq!(g[0][8].unwrap().degree, 4);
    }

    #[test]
    fn step_mute_silences_and_restores() {
        let t = transport();
        let mut lp = LoopEngine::new(48_000.0);
        lp.tracks[0].events.push(TimedEvent {
            t: 0,
            event: Event::chord_on_from(&chord(1)),
        });
        lp.mark_dirty(0);
        lp.tracks[0].set_step_mute(2, true);
        let mut out = EventList::new();
        let mut log = Vec::new();
        let mut pos = 0u64;
        while pos < t.loop_len() {
            out.clear();
            lp.playback(0, pos, pos + 128, &t, &mut out);
            for e in out.as_slice() {
                log.push((pos, *e));
            }
            pos += 128;
        }
        // ChordOn at 0, ChordOff at step 2 (12_000), ChordOn again at step 3 (18_000)
        assert!(matches!(log[0], (0, Event::ChordOn { .. })));
        let off = log
            .iter()
            .find(|(_, e)| matches!(e, Event::ChordOff))
            .unwrap();
        assert!(off.0 >= 11_900 && off.0 <= 12_100, "{}", off.0);
        let on2 = log.iter().filter(|(_, e)| e.is_chord_on()).nth(1).unwrap();
        assert!(on2.0 >= 17_900 && on2.0 <= 18_100, "{}", on2.0);
    }

    #[test]
    fn replace_mode_and_cut_at_loop_end() {
        let t = transport();
        let mut lp = LoopEngine::new(48_000.0);
        lp.settings.record_mode = RecordMode::Replace;
        lp.settings.wrap_at_loop_end = false;
        lp.tracks[0].events.push(TimedEvent {
            t: 5,
            event: Event::ChordOff,
        });
        lp.arm(0);
        lp.begin_recording(&t);
        assert!(
            lp.tracks[0].events.is_empty(),
            "replace wipes the track first"
        );
        let c = chord(2);
        lp.record(0, &c, &[Event::chord_on_from(&c)], &t);
        lp.record(t.loop_len(), &c, &[], &t);
        let ev = &lp.tracks[0].events;
        assert_eq!(ev.len(), 2);
        assert!(matches!(ev[1].event, Event::ChordOff));
        assert_eq!(ev[1].t, t.loop_len() - 1);
    }

    #[test]
    fn replace_chord_at_step_edits_grid() {
        let t = transport();
        let mut lp = LoopEngine::new(48_000.0);
        lp.tracks[0].events.push(TimedEvent {
            t: 0,
            event: Event::chord_on_from(&chord(1)),
        });
        lp.tracks[0].replace_chord_at_step(0, &t, Event::chord_on_from(&chord(5)));
        assert_eq!(lp.tracks[0].step_chords(&t)[3].unwrap().degree, 5);
        // insert into an empty track
        lp.tracks[1].replace_chord_at_step(4, &t, Event::chord_on_from(&chord(6)));
        let g = lp.tracks[1].step_chords(&t);
        assert_eq!(g[4].unwrap().degree, 6);
        assert!(g[5].is_none());
        assert!(g[3].is_none());
    }

    #[test]
    fn shorter_track_repeats() {
        let mut t = transport();
        t.set_bars(2);
        let mut lp = LoopEngine::new(48_000.0);
        lp.tracks[0].length_bars = 1;
        lp.tracks[0].events.push(TimedEvent {
            t: 0,
            event: Event::chord_on_from(&chord(1)),
        });
        lp.tracks[0].events.push(TimedEvent {
            t: 48_000,
            event: Event::ChordOff,
        });
        lp.mark_dirty(0);
        let mut out = EventList::new();
        let mut ons = 0;
        let mut pos = 0u64;
        while pos < t.loop_len() {
            out.clear();
            lp.playback(0, pos, pos + 128, &t, &mut out);
            ons += out.as_slice().iter().filter(|e| e.is_chord_on()).count();
            pos += 128;
        }
        assert_eq!(ons, 2, "1-bar track plays twice in a 2-bar loop");
    }

    #[test]
    fn solo_and_mute() {
        let mut lp = LoopEngine::new(48_000.0);
        assert!(lp.audible(0));
        lp.tracks[1].solo = true;
        assert!(!lp.audible(0));
        assert!(lp.audible(1));
        lp.tracks[1].mute = true;
        assert!(!lp.audible(1));
    }
}
