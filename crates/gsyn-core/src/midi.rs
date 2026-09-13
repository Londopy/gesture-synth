//! MIDI out messages and Standard MIDI File export (spec 6 "MIDI out", spec 7 file format).
//!
//! Mapping: ChordOn/Off -> note on/off, cutoff -> CC74, volume -> CC7 (or CC11), pan -> CC10.

use crate::looper::Track;
use crate::music::{Mode, PitchClass};
use crate::state::Event;
use crate::transport::Transport;

pub const CC_CUTOFF: u8 = 74;
pub const CC_VOLUME: u8 = 7;
pub const CC_EXPRESSION: u8 = 11;
pub const CC_PAN: u8 = 10;

#[inline]
pub fn note_on(ch: u8, note: u8, vel: u8) -> [u8; 3] {
    [0x90 | (ch.saturating_sub(1) & 0x0f), note & 0x7f, vel & 0x7f]
}

#[inline]
pub fn note_off(ch: u8, note: u8) -> [u8; 3] {
    [0x80 | (ch.saturating_sub(1) & 0x0f), note & 0x7f, 0]
}

#[inline]
pub fn cc(ch: u8, controller: u8, value: f32) -> [u8; 3] {
    [0xB0 | (ch.saturating_sub(1) & 0x0f), controller & 0x7f, (value.clamp(0.0, 1.0) * 127.0).round() as u8]
}

/// Fixed-size outgoing MIDI queue filled on the audio thread, drained by the host.
pub struct MidiQueue {
    buf: [[u8; 3]; 512],
    len: usize,
}

impl Default for MidiQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl MidiQueue {
    pub fn new() -> Self {
        Self { buf: [[0; 3]; 512], len: 0 }
    }
    #[inline]
    pub fn push(&mut self, m: [u8; 3]) {
        if self.len < self.buf.len() {
            self.buf[self.len] = m;
            self.len += 1;
        }
    }
    pub fn drain(&mut self) -> impl Iterator<Item = [u8; 3]> + '_ {
        let n = self.len;
        self.len = 0;
        self.buf[..n].iter().copied()
    }
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

/// Tracks which notes are held per channel so chord changes produce clean
/// note-off / note-on pairs (legato: common tones are not retriggered).
#[derive(Clone, Copy, Default)]
pub struct ChannelState {
    held: [u8; 8],
    count: u8,
    last_cc: [i16; 3],
}

impl ChannelState {
    pub fn new() -> Self {
        Self { held: [0; 8], count: 0, last_cc: [-1; 3] }
    }

    pub fn apply(&mut self, ch: u8, e: &Event, use_expression: bool, q: &mut MidiQueue) {
        match e {
            Event::ChordOn { notes, count, .. } => {
                let new = &notes[..(*count as usize).min(4)];
                // offs for notes not in the new chord
                let mut keep = [0u8; 8];
                let mut kc = 0;
                for i in 0..self.count as usize {
                    let n = self.held[i];
                    if new.contains(&n) {
                        keep[kc] = n;
                        kc += 1;
                    } else {
                        q.push(note_off(ch, n));
                    }
                }
                // ons for new notes
                for &n in new {
                    if !keep[..kc].contains(&n) {
                        q.push(note_on(ch, n, 100));
                        if kc < 8 {
                            keep[kc] = n;
                            kc += 1;
                        }
                    }
                }
                self.held = keep;
                self.count = kc as u8;
            }
            Event::ChordOff => {
                for i in 0..self.count as usize {
                    q.push(note_off(ch, self.held[i]));
                }
                self.count = 0;
            }
            Event::BassHit { note } => {
                q.push(note_on(ch, *note, 110));
            }
            Event::ParamChange { cutoff, volume, pan } => {
                let vals = [*cutoff, *volume, (*pan + 1.0) * 0.5];
                let ctrls = [CC_CUTOFF, if use_expression { CC_EXPRESSION } else { CC_VOLUME }, CC_PAN];
                for i in 0..3 {
                    let v = (vals[i].clamp(0.0, 1.0) * 127.0).round() as i16;
                    if v != self.last_cc[i] {
                        self.last_cc[i] = v;
                        q.push(cc(ch, ctrls[i], vals[i]));
                    }
                }
            }
            _ => {}
        }
    }

    pub fn all_off(&mut self, ch: u8, q: &mut MidiQueue) {
        for i in 0..self.count as usize {
            q.push(note_off(ch, self.held[i]));
        }
        self.count = 0;
        q.push([0xB0 | (ch.saturating_sub(1) & 0x0f), 123, 0]); // all notes off
    }
}

// ---------------------------------------------------------------------------
// Standard MIDI File export
// ---------------------------------------------------------------------------

const PPQ: u32 = 480;

fn vlq(mut v: u32, out: &mut Vec<u8>) {
    let mut buf = [0u8; 5];
    let mut i = 4;
    buf[i] = (v & 0x7f) as u8;
    v >>= 7;
    while v > 0 {
        i -= 1;
        buf[i] = ((v & 0x7f) as u8) | 0x80;
        v >>= 7;
    }
    out.extend_from_slice(&buf[i..]);
}

struct SmfTrack {
    events: Vec<(u32, Vec<u8>)>, // (abs tick, bytes)
}

impl SmfTrack {
    fn new() -> Self {
        Self { events: Vec::new() }
    }
    fn push(&mut self, tick: u32, bytes: Vec<u8>) {
        self.events.push((tick, bytes));
    }
    fn bytes(mut self) -> Vec<u8> {
        self.events.sort_by_key(|(t, b)| (*t, if b[0] & 0xf0 == 0x80 { 0 } else { 1 }));
        let mut data = Vec::new();
        let mut last = 0u32;
        for (t, b) in &self.events {
            vlq(t - last, &mut data);
            data.extend_from_slice(b);
            last = *t;
        }
        // end of track
        vlq(0, &mut data);
        data.extend_from_slice(&[0xFF, 0x2F, 0x00]);
        let mut out = b"MTrk".to_vec();
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend(data);
        out
    }
}

fn text_meta(kind: u8, s: &str) -> Vec<u8> {
    let mut v = vec![0xFF, kind];
    vlq(s.len() as u32, &mut v);
    v.extend_from_slice(s.as_bytes());
    v
}

/// Export loop tracks as a format-1 SMF: one MIDI track per non-empty loop track,
/// chord steps quantized to the 16th grid (mutes applied), CCs per 16th.
pub fn tracks_to_smf(tracks: &[Track], transport: &Transport, key: PitchClass, mode: Mode, name: &str) -> Vec<u8> {
    let sig = transport.sig;
    let ticks_per_step = PPQ * 4 / sig.unit as u32 / sig.steps_per_beat();
    let mut smf_tracks: Vec<Vec<u8>> = Vec::new();

    // tempo / meta track
    let mut meta = SmfTrack::new();
    meta.push(0, text_meta(0x03, name));
    let usec_per_quarter = (60_000_000.0 / (transport.bpm as f64 * (4.0 / sig.unit as f64))) as u32;
    meta.push(0, vec![0xFF, 0x51, 0x03, (usec_per_quarter >> 16) as u8, (usec_per_quarter >> 8) as u8, usec_per_quarter as u8]);
    let denom_pow = match sig.unit {
        8 => 3,
        _ => 2,
    };
    meta.push(0, vec![0xFF, 0x58, 0x04, sig.beats, denom_pow, 24, 8]);
    // key signature: sharps/flats count from circle of fifths, minor flag
    let fifths = key.fifths_index() as i8;
    let sf = if fifths > 6 { fifths - 12 } else { fifths };
    let sf = if mode == Mode::Minor { sf - 3 } else { sf };
    meta.push(0, vec![0xFF, 0x59, 0x02, sf as u8, if mode == Mode::Minor { 1 } else { 0 }]);
    smf_tracks.push(meta.bytes());

    let global_steps = transport.total_steps() as usize;
    for tr in tracks.iter().filter(|t| !t.is_empty()) {
        let mut st = SmfTrack::new();
        st.push(0, text_meta(0x03, &tr.name));
        let ch = tr.midi_ch.clamp(1, 16);
        let cells = tr.step_chords(transport);
        let tsteps = cells.len().max(1);
        let tlen = tr.len_samples(transport);
        let mut held: Vec<u8> = Vec::new();
        let mut last_cc = [-1i16; 3];
        for gs in 0..global_steps {
            let s = gs % tsteps;
            let tick = gs as u32 * ticks_per_step;
            let cell = if tr.step_muted(s) { None } else { cells[s] };
            let want: Vec<u8> = cell.map(|c| c.notes[..c.count as usize].to_vec()).unwrap_or_default();
            for &n in held.iter().filter(|n| !want.contains(n)) {
                st.push(tick, note_off(ch, n).to_vec());
            }
            for &n in want.iter().filter(|n| !held.contains(n)) {
                let vel = (40.0 + 80.0 * cell.map(|c| c.volume).unwrap_or(0.8)).clamp(1.0, 127.0) as u8;
                st.push(tick, note_on(ch, n, vel).to_vec());
            }
            held = want;
            // CCs
            let pos = (s as f64 * transport.samples_per_step()) as u64 % tlen.max(1);
            let cut = tr.curves.cutoff.value_at(pos, tlen, 0.7);
            let vol = tr.curves.volume.value_at(pos, tlen, 0.8) * tr.volume;
            let pan = (tr.curves.pan.value_at(pos, tlen, 0.0) + tr.pan + 1.0) * 0.5;
            for (i, (ctrl, v)) in [(CC_CUTOFF, cut), (CC_VOLUME, vol), (CC_PAN, pan)].iter().enumerate() {
                let q = (v.clamp(0.0, 1.0) * 127.0).round() as i16;
                if q != last_cc[i] {
                    last_cc[i] = q;
                    st.push(tick, cc(ch, *ctrl, *v).to_vec());
                }
            }
        }
        let end = global_steps as u32 * ticks_per_step;
        for n in held {
            st.push(end, note_off(ch, n).to_vec());
        }
        smf_tracks.push(st.bytes());
    }

    let mut out = b"MThd".to_vec();
    out.extend_from_slice(&6u32.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&(smf_tracks.len() as u16).to_be_bytes());
    out.extend_from_slice(&(PPQ as u16).to_be_bytes());
    for t in smf_tracks {
        out.extend(t);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::looper::TimedEvent;
    use crate::music::{Quality, Shape};

    #[test]
    fn channel_state_legato() {
        let mut cs = ChannelState::new();
        let mut q = MidiQueue::new();
        cs.apply(1, &Event::ChordOn { notes: [48, 52, 55, 0], count: 3, degree: 1, quality: Quality::Major, shape: Shape::Root, octave: 0 }, false, &mut q);
        assert_eq!(q.len(), 3);
        q.drain().for_each(drop);
        cs.apply(1, &Event::ChordOn { notes: [48, 53, 57, 0], count: 3, degree: 4, quality: Quality::Major, shape: Shape::Root, octave: 0 }, false, &mut q);
        let msgs: Vec<[u8; 3]> = q.drain().collect();
        assert_eq!(msgs.len(), 4); // 2 offs + 2 ons, C held
        assert!(msgs.iter().any(|m| *m == note_off(1, 52)));
        assert!(msgs.iter().any(|m| *m == note_on(1, 53, 100)));
        cs.apply(1, &Event::ChordOff, false, &mut q);
        assert_eq!(q.len(), 3);
    }

    #[test]
    fn smf_has_header_and_tracks() {
        let mut t = Transport::new(48_000.0);
        t.set_bpm(120.0);
        t.set_bars(1);
        let mut tr = Track::new(0);
        tr.events.push(TimedEvent { t: 0, event: Event::ChordOn { notes: [48, 52, 55, 0], count: 3, degree: 1, quality: Quality::Major, shape: Shape::Root, octave: 0 } });
        tr.events.push(TimedEvent { t: 48_000, event: Event::ChordOff });
        let bytes = tracks_to_smf(&[tr], &t, PitchClass::C, Mode::Major, "test");
        assert_eq!(&bytes[..4], b"MThd");
        assert_eq!(bytes[11], 2); // 2 tracks
        let mtrk_count = bytes.windows(4).filter(|w| *w == b"MTrk").count();
        assert_eq!(mtrk_count, 2);
        assert!(bytes.windows(3).any(|w| w == [0x90, 48, 104]));
        assert!(bytes.windows(3).any(|w| w == [0x80, 48, 0]));
    }

    #[test]
    fn vlq_encoding() {
        let mut v = Vec::new();
        vlq(0x7f, &mut v);
        assert_eq!(v, [0x7f]);
        v.clear();
        vlq(0x80, &mut v);
        assert_eq!(v, [0x81, 0x00]);
        v.clear();
        vlq(0x3fff, &mut v);
        assert_eq!(v, [0xff, 0x7f]);
    }
}
