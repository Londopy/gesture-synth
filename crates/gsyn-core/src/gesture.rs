//! Gesture parser (spec section 4): MediaPipe landmarks -> MusicalState + events.
//!
//! Pure math on landmark arrays; no allocation per frame. Runs on the ipc
//! thread on desktop and on the main thread (WASM) in the browser.

use crate::math::{self, Vec3};
use crate::music::{self, Mode, PitchClass, Quality, Shape, VoicingSettings};
use crate::state::{Event, EventList, MusicalState};
use serde::{Deserialize, Serialize};

/// MediaPipe landmark indices.
pub mod lm {
    pub const WRIST: usize = 0;
    pub const THUMB_CMC: usize = 1;
    pub const THUMB_MCP: usize = 2;
    pub const THUMB_IP: usize = 3;
    pub const THUMB_TIP: usize = 4;
    pub const INDEX_MCP: usize = 5;
    pub const INDEX_PIP: usize = 6;
    pub const INDEX_DIP: usize = 7;
    pub const INDEX_TIP: usize = 8;
    pub const MIDDLE_MCP: usize = 9;
    pub const MIDDLE_PIP: usize = 10;
    pub const MIDDLE_TIP: usize = 12;
    pub const RING_MCP: usize = 13;
    pub const RING_PIP: usize = 14;
    pub const RING_TIP: usize = 16;
    pub const PINKY_MCP: usize = 17;
    pub const PINKY_PIP: usize = 18;
    pub const PINKY_TIP: usize = 20;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Handedness {
    Left,
    Right,
}

impl Handedness {
    pub fn swapped(self) -> Self {
        match self {
            Handedness::Left => Handedness::Right,
            Handedness::Right => Handedness::Left,
        }
    }
}

/// One detected hand in image-normalized coordinates (x right, y down, 0..1; z relative depth, smaller = closer).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct HandFrame {
    pub landmarks: [Vec3; 21],
    /// Label as reported by the tracker (before any mirror correction).
    pub handedness: Handedness,
    pub confidence: f32,
}

/// Left-hand control scheme (spec 4.10).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LeftScheme {
    #[default]
    Full,
    ScaleOnly,
    FixedDegree {
        degree: u8,
    },
}

/// Right-hand control scheme (spec 4.10).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RightScheme {
    #[default]
    Full,
    FixedStyle {
        shape: Shape,
    },
    DynamicsOnly,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayMode {
    #[default]
    Gesture,
    Theremin,
}

/// Camera calibration (spec 4.5 + 9.5 first-run flow).
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct Calibration {
    /// Wrist y (0 = top of frame) that maps to full volume.
    pub top_y: f32,
    /// Wrist y that maps to silence.
    pub bottom_y: f32,
    /// Frames fed to the parser are already mirrored (selfie view).
    pub mirror_frame: bool,
    /// Swap the tracker's handedness labels (some cameras/drivers report them reversed).
    pub swap_hands: bool,
    /// Flip the tilt sign (if inward/outward feel reversed on this setup).
    pub invert_tilt: bool,
}

impl Default for Calibration {
    fn default() -> Self {
        Self {
            top_y: 0.15,
            bottom_y: 0.85,
            mirror_frame: false,
            swap_hands: false,
            invert_tilt: false,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct ParserConfig {
    /// A discrete state must be observed this long before it is accepted (spec 4.8).
    pub stable_ms: f32,
    pub left: LeftScheme,
    pub right: RightScheme,
    pub mode: PlayMode,
    /// Quality override for FixedDegree (None = diatonic).
    pub fixed_quality: Option<Quality>,
    pub voicing: VoicingSettings,
    pub calibration: Calibration,
    /// Theremin: snap pitch to the key's scale.
    pub theremin_snap: bool,
    /// Theremin lowest note (MIDI) and range in semitones.
    pub theremin_base_midi: f32,
    pub theremin_range: f32,
    /// Wrist z velocity (palm units / s, toward camera) that counts as a flick.
    pub flick_threshold: f32,
    /// Hold still this long to latch.
    pub latch_hold_ms: f32,
    /// Below this confidence tracking is "lost".
    pub confidence_floor: f32,
    /// Filter smoothing time constant (s).
    pub cutoff_tc: f32,
    /// Volume smoothing time constant (s).
    pub volume_tc: f32,
}

impl Default for ParserConfig {
    fn default() -> Self {
        Self {
            stable_ms: 90.0,
            left: LeftScheme::Full,
            right: RightScheme::Full,
            mode: PlayMode::Gesture,
            fixed_quality: None,
            voicing: VoicingSettings::default(),
            calibration: Calibration::default(),
            theremin_snap: false,
            theremin_base_midi: 48.0,
            theremin_range: 24.0,
            flick_threshold: 2.5,
            latch_hold_ms: 2000.0,
            confidence_floor: 0.6,
            cutoff_tc: 0.08,
            volume_tc: 0.06,
        }
    }
}

/// Debounced discrete value (spec 4.8).
#[derive(Clone, Copy, Debug)]
struct Debounce<T: Copy + PartialEq> {
    current: T,
    candidate: T,
    since_ms: f64,
}

impl<T: Copy + PartialEq> Debounce<T> {
    fn new(v: T) -> Self {
        Self {
            current: v,
            candidate: v,
            since_ms: 0.0,
        }
    }

    /// Observe a candidate at time `now`. Returns true when `current` changed.
    fn feed(&mut self, cand: T, now: f64, stable_ms: f32) -> bool {
        if cand != self.candidate {
            self.candidate = cand;
            self.since_ms = now;
            return false;
        }
        if cand != self.current && now - self.since_ms >= stable_ms as f64 {
            self.current = cand;
            return true;
        }
        false
    }

    /// Force a value (UI override), no debounce.
    fn set(&mut self, v: T) {
        self.current = v;
        self.candidate = v;
    }
}

/// Per-hand derived features, exposed for the HUD / tutorial checks.
#[derive(Clone, Copy, PartialEq, Debug, Default, Serialize, Deserialize)]
pub struct HandInfo {
    pub present: bool,
    pub confidence: f32,
    /// thumb, index, middle, ring, pinky
    pub fingers: [bool; 5],
    /// Signed tilt in degrees (+ = inward).
    pub tilt: f32,
    /// Wrist position in frame coords.
    pub wrist: [f32; 3],
    pub palm_size: f32,
    /// Thumb state for octave: -1 folded, 0 relaxed, +1 out.
    pub thumb: i8,
    pub pinch: bool,
    pub fist: bool,
    /// Wrist z velocity in palm units per second (positive = toward camera).
    pub z_velocity: f32,
}

#[derive(Clone, Copy, Debug, Default)]
struct HandTrack {
    info: HandInfo,
    last_seen_ms: f64,
    prev_wrist: Vec3,
    prev_ms: f64,
    /// Rolling motion magnitude (frame units per second) for stillness detection.
    motion: f32,
    ever_seen: bool,
}

#[derive(Clone, Copy, Debug)]
struct KeyGesture {
    last_angle: f32,
    accum: f32,
}

pub struct GestureParser {
    pub cfg: ParserConfig,
    state: MusicalState,
    left: HandTrack,
    right: HandTrack,
    degree: Debounce<u8>,
    quality: Debounce<Quality>,
    shape: Debounce<Shape>,
    octave: Debounce<i8>,
    cutoff_raw: f32,
    volume_raw: f32,
    pan_raw: f32,
    low_conf_since: Option<f64>,
    fade_gain: f32,
    last_flick_ms: f64,
    pinch_prev: bool,
    pinch_since: f64,
    key_gesture: Option<KeyGesture>,
    still_since: f64,
    last_ms: f64,
    theremin_midi: f32,
    theremin_vel: f32,
    events: EventList,
    last_notes: [u8; 4],
    last_count: u8,
    last_params: (f32, f32, f32),
}

impl Default for GestureParser {
    fn default() -> Self {
        Self::new(ParserConfig::default())
    }
}

impl GestureParser {
    pub fn new(cfg: ParserConfig) -> Self {
        let mut state = MusicalState::default();
        if let LeftScheme::FixedDegree { degree } = cfg.left {
            state.degree = degree;
        }
        Self {
            cfg,
            state,
            left: HandTrack::default(),
            right: HandTrack::default(),
            degree: Debounce::new(state.degree),
            quality: Debounce::new(Quality::Major),
            shape: Debounce::new(Shape::Root),
            octave: Debounce::new(0),
            cutoff_raw: 0.7,
            volume_raw: 0.0,
            pan_raw: 0.0,
            low_conf_since: None,
            fade_gain: 1.0,
            last_flick_ms: -1e9,
            pinch_prev: false,
            pinch_since: 0.0,
            key_gesture: None,
            still_since: 0.0,
            last_ms: 0.0,
            theremin_midi: 60.0,
            theremin_vel: 0.0,
            events: EventList::new(),
            last_notes: [0; 4],
            last_count: 0,
            last_params: (-1.0, -1.0, -9.0),
        }
    }

    pub fn state(&self) -> &MusicalState {
        &self.state
    }

    pub fn events(&self) -> &[Event] {
        self.events.as_slice()
    }

    pub fn left_info(&self) -> HandInfo {
        self.left.info
    }

    pub fn right_info(&self) -> HandInfo {
        self.right.info
    }

    pub fn set_config(&mut self, cfg: ParserConfig) {
        let mode_changed = cfg.mode != self.cfg.mode;
        self.cfg = cfg;
        if let LeftScheme::FixedDegree { degree } = cfg.left {
            self.degree.set(degree);
        }
        if let RightScheme::FixedStyle { shape } = cfg.right {
            self.shape.set(shape);
        }
        if mode_changed {
            self.state.theremin = cfg.mode == PlayMode::Theremin;
            if self.state.theremin {
                // leaving chord mode: release chord
                self.degree.set(0);
            }
        }
        self.rederive(self.last_ms);
    }

    /// Set key and mode (from UI, keyboard, or the circle-of-fifths gesture).
    pub fn set_key(&mut self, key: PitchClass, mode: Mode) {
        if self.state.key != key || self.state.mode != mode {
            self.state.key = key;
            self.state.mode = mode;
            self.events.push(Event::KeyChange { key, mode });
            self.rederive(self.last_ms);
        }
    }

    pub fn step_key_fifths(&mut self, n: i32) {
        let k = self.state.key.step_fifths(n);
        let m = self.state.mode;
        self.set_key(k, m);
    }

    /// UI override of the degree (Fixed degree scheme).
    pub fn set_fixed_degree(&mut self, degree: u8) {
        self.cfg.left = LeftScheme::FixedDegree { degree };
        self.degree.set(degree);
        self.rederive(self.last_ms);
    }

    pub fn set_arp(&mut self, on: bool) {
        if self.state.arp != on {
            self.state.arp = on;
            self.events.push(Event::ArpToggle { on });
        }
    }

    /// Panic: release everything.
    pub fn all_off(&mut self) {
        self.degree.set(0);
        self.state.latched = false;
        self.rederive(self.last_ms);
    }

    /// Feed one camera frame. `t_ms` is a monotonic clock in milliseconds.
    pub fn feed(&mut self, hands: &[HandFrame], t_ms: f64) {
        self.events.clear();
        let dt = ((t_ms - self.last_ms) / 1000.0).clamp(0.001, 0.25) as f32;
        self.last_ms = t_ms;

        // ---- 1. assign hands -------------------------------------------------
        let (lf, rf) = self.assign_hands(hands);
        self.update_track(Handedness::Left, lf, t_ms, dt);
        self.update_track(Handedness::Right, rf, t_ms, dt);

        // ---- 2. confidence / loss handling -------------------------------------
        let need_left = self.cfg.mode == PlayMode::Theremin
            || matches!(self.cfg.left, LeftScheme::Full | LeftScheme::ScaleOnly);
        let conf_l = if self.left.info.present {
            self.left.info.confidence
        } else {
            0.0
        };
        let conf_r = if self.right.info.present {
            self.right.info.confidence
        } else {
            0.0
        };
        let conf = if need_left {
            conf_l.min(conf_r)
        } else {
            conf_r
        };
        self.state.confidence = conf.max(conf_l.max(conf_r) * 0.5);
        let lost = conf < self.cfg.confidence_floor;
        if lost {
            if self.low_conf_since.is_none() {
                self.low_conf_since = Some(t_ms);
            }
        } else {
            self.low_conf_since = None;
        }
        let lost_for = self.low_conf_since.map(|s| t_ms - s).unwrap_or(0.0);
        let hold = lost && lost_for > 250.0;
        if lost && lost_for > 1000.0 && !self.state.latched {
            // fade to silence over 300 ms
            self.fade_gain = (self.fade_gain - dt / 0.3).max(0.0);
        } else if !lost {
            self.fade_gain = (self.fade_gain + dt / 0.1).min(1.0);
        }

        // ---- 3. gestures -------------------------------------------------------
        let mut discrete_changed = false;
        if !hold {
            match self.cfg.mode {
                PlayMode::Gesture => {
                    discrete_changed |= self.process_left(t_ms);
                    discrete_changed |= self.process_right(t_ms, dt);
                    self.process_key_gesture();
                }
                PlayMode::Theremin => {
                    self.process_theremin(dt);
                }
            }
        }

        // ---- 4. latch (spec 4.9) --------------------------------------------------
        if discrete_changed {
            self.still_since = t_ms;
            if self.state.latched {
                self.state.latched = false;
                self.events.push(Event::Latch { on: false });
            }
        }
        let still = self.left.motion < 0.15 && self.right.motion < 0.15;
        if !still || !(self.left.info.present || self.right.info.present) {
            if !self.state.latched {
                self.still_since = t_ms;
            }
        } else if !self.state.latched
            && self.state.degree > 0
            && t_ms - self.still_since >= self.cfg.latch_hold_ms as f64
        {
            self.state.latched = true;
            self.events.push(Event::Latch { on: true });
        }

        // ---- 5. derive + emit -------------------------------------------------------
        self.rederive(t_ms);
    }

    /// Decide which detected hand is the user's left and right.
    fn assign_hands(&self, hands: &[HandFrame]) -> (Option<HandFrame>, Option<HandFrame>) {
        let cal = self.cfg.calibration;
        let fix = |h: HandFrame| -> HandFrame {
            // MediaPipe labels assume a mirrored (selfie) image. Raw webcam frames are not mirrored.
            let mut hd = if cal.mirror_frame {
                h.handedness
            } else {
                h.handedness.swapped()
            };
            if cal.swap_hands {
                hd = hd.swapped();
            }
            HandFrame {
                handedness: hd,
                ..h
            }
        };
        match hands.len() {
            0 => (None, None),
            1 => {
                let h = fix(hands[0]);
                // continuity: if the other hand was seen very recently near this wrist, keep it.
                let w = h.landmarks[lm::WRIST];
                let near = |t: &HandTrack| {
                    t.ever_seen
                        && self.last_ms - t.last_seen_ms < 400.0
                        && math::dist2(t.info.wrist, w) < 0.12
                };
                let other_near = match h.handedness {
                    Handedness::Left => near(&self.right) && !near(&self.left),
                    Handedness::Right => near(&self.left) && !near(&self.right),
                };
                let hd = if other_near {
                    h.handedness.swapped()
                } else {
                    h.handedness
                };
                match hd {
                    Handedness::Left => (Some(h), None),
                    Handedness::Right => (None, Some(h)),
                }
            }
            _ => {
                // two (or more) hands: use x position, it is far more reliable than labels.
                let mut a = hands[0];
                let mut b = hands[1];
                if a.confidence < b.confidence && hands.len() > 2 {
                    a = hands[1];
                    b = hands[2];
                }
                let ax = a.landmarks[lm::WRIST][0];
                let bx = b.landmarks[lm::WRIST][0];
                // raw frame: the user's right hand appears at smaller x.
                let (right, left) = if (ax < bx) != cal.mirror_frame {
                    (a, b)
                } else {
                    (b, a)
                };
                (
                    Some(HandFrame {
                        handedness: Handedness::Left,
                        ..left
                    }),
                    Some(HandFrame {
                        handedness: Handedness::Right,
                        ..right
                    }),
                )
            }
        }
    }

    fn update_track(&mut self, which: Handedness, frame: Option<HandFrame>, t_ms: f64, dt: f32) {
        let cal = self.cfg.calibration;
        let track = match which {
            Handedness::Left => &mut self.left,
            Handedness::Right => &mut self.right,
        };
        let Some(f) = frame else {
            track.info.present = false;
            track.motion = 0.0;
            return;
        };
        let p = &f.landmarks;
        let wrist = p[lm::WRIST];
        let palm = math::dist(p[lm::WRIST], p[lm::MIDDLE_MCP]).max(1e-4);

        // finger extended tests (spec 4.2)
        let ext = |mcp: usize, pip: usize, tip: usize| -> bool {
            math::dist(p[tip], wrist) > math::dist(p[pip], wrist) * 1.25
                && math::angle_deg(p[mcp], p[pip], p[tip]) > 150.0
        };
        let thumb_ext = math::dist(p[lm::THUMB_TIP], p[lm::PINKY_MCP]) > 1.1 * palm;
        let fingers = [
            thumb_ext,
            ext(lm::INDEX_MCP, lm::INDEX_PIP, lm::INDEX_TIP),
            ext(lm::MIDDLE_MCP, lm::MIDDLE_PIP, lm::MIDDLE_TIP),
            ext(lm::RING_MCP, lm::RING_PIP, lm::RING_TIP),
            ext(lm::PINKY_MCP, lm::PINKY_PIP, lm::PINKY_TIP),
        ];

        // thumb in/out with hysteresis (spec 4.3)
        let thumb_to_middle = math::dist(p[lm::THUMB_TIP], p[lm::MIDDLE_MCP]) / palm;
        let thumb = if thumb_to_middle < 0.55 {
            -1
        } else if thumb_ext {
            1
        } else if thumb_to_middle > 0.85 {
            0
        } else {
            track.info.thumb
        };

        // tilt (spec 4.4): palm normal vs camera axis, projected on the horizontal plane
        let mut n = math::normalize(math::cross(
            math::sub(p[lm::INDEX_MCP], wrist),
            math::sub(p[lm::PINKY_MCP], wrist),
        ));
        if which == Handedness::Left {
            n = math::scale(n, -1.0);
        }
        let mut s = if which == Handedness::Right {
            1.0
        } else {
            -1.0
        };
        if cal.mirror_frame {
            s = -s;
        }
        if cal.invert_tilt {
            s = -s;
        }
        let mut tilt = libm::atan2f(s * n[0], -n[2]).to_degrees();
        tilt = tilt.clamp(-90.0, 90.0);

        // pinch + fist
        let pinch = math::dist(p[lm::THUMB_TIP], p[lm::INDEX_TIP]) < 0.3 * palm;
        let fist = !fingers[1] && !fingers[2] && !fingers[3] && !fingers[4];

        // velocities
        let mut zv = 0.0;
        let mut motion = track.motion;
        if track.info.present && t_ms > track.prev_ms {
            let dts = ((t_ms - track.prev_ms) / 1000.0).max(0.001) as f32;
            // z decreases toward the camera
            zv = (track.prev_wrist[2] - wrist[2]) / palm / dts;
            let m = math::dist2(track.prev_wrist, wrist) / dts;
            motion += (m - motion) * (dt / 0.15).min(1.0);
        } else {
            motion = 0.0;
        }

        track.info = HandInfo {
            present: true,
            confidence: f.confidence,
            fingers,
            tilt,
            wrist,
            palm_size: palm,
            thumb,
            pinch,
            fist,
            z_velocity: zv,
        };
        track.prev_wrist = wrist;
        track.prev_ms = t_ms;
        track.last_seen_ms = t_ms;
        track.motion = motion;
        track.ever_seen = true;
    }

    /// Left hand: chord degree + quality (+ flick). Returns true if a discrete value changed.
    fn process_left(&mut self, t_ms: f64) -> bool {
        let mut changed = false;
        let info = self.left.info;
        let stable = self.cfg.stable_ms;
        match self.cfg.left {
            LeftScheme::FixedDegree { degree } => {
                if self.degree.current != degree {
                    self.degree.set(degree);
                    changed = true;
                }
                let q = self
                    .cfg
                    .fixed_quality
                    .unwrap_or_else(|| music::diatonic_quality(degree, self.state.mode));
                if self.quality.current != q {
                    self.quality.set(q);
                    changed = true;
                }
            }
            scheme => {
                if info.present {
                    let f = info.fingers; // [thumb, index, middle, ring, pinky]
                    let cand = match (f[0], f[1], f[2], f[3], f[4]) {
                        (false, true, false, false, false) => Some(1),
                        (false, true, true, false, false) => Some(2),
                        (false, true, true, true, false) => Some(3),
                        (false, true, true, true, true) => Some(4),
                        (true, true, true, true, true) => Some(5),
                        (false, true, false, false, true) => Some(6),
                        (true, true, false, false, true) => Some(7),
                        (_, false, false, false, false) => Some(0), // fist = mute
                        _ => None,                                  // hold previous
                    };
                    if let Some(c) = cand {
                        changed |= self.degree.feed(c, t_ms, stable);
                    }
                    match scheme {
                        LeftScheme::Full => {
                            // tilt latched, dead zone +-8 degrees
                            if info.tilt > 8.0 {
                                changed |= self.quality.feed(Quality::Major, t_ms, stable);
                            } else if info.tilt < -8.0 {
                                changed |= self.quality.feed(Quality::Minor, t_ms, stable);
                            }
                        }
                        _ => {
                            let d = self.degree.current.max(1);
                            let q = music::diatonic_quality(d, self.state.mode);
                            if self.quality.current != q {
                                self.quality.set(q);
                                changed = true;
                            }
                        }
                    }
                    // flick toward camera -> bass hit (spec 4.9)
                    if info.z_velocity > self.cfg.flick_threshold
                        && t_ms - self.last_flick_ms > 300.0
                    {
                        if let Some(note) = self.state.bass_note() {
                            self.events.push(Event::BassHit { note });
                            self.last_flick_ms = t_ms;
                        }
                    }
                }
            }
        }
        changed
    }

    /// Right hand: shape, octave, filter, volume, pan, pinch/arp. Returns true on discrete change.
    fn process_right(&mut self, t_ms: f64, dt: f32) -> bool {
        let mut changed = false;
        let info = self.right.info;
        let stable = self.cfg.stable_ms;
        match self.cfg.right {
            RightScheme::FixedStyle { shape } => {
                if self.shape.current != shape {
                    self.shape.set(shape);
                    changed = true;
                }
            }
            RightScheme::DynamicsOnly => {}
            RightScheme::Full => {}
        }
        if !info.present {
            return changed;
        }
        let f = info.fingers;
        let count = f[1..].iter().filter(|b| **b).count() as u8;
        if self.cfg.right == RightScheme::Full {
            if let Some(sh) = Shape::from_finger_count(count) {
                changed |= self.shape.feed(sh, t_ms, stable);
            }
            changed |= self.octave.feed(info.thumb, t_ms, stable);
        }

        // continuous: filter from tilt, volume from height, pan from x
        let cal = self.cfg.calibration;
        let cutoff = ((info.tilt + 45.0) / 90.0).clamp(0.0, 1.0);
        let span = (cal.bottom_y - cal.top_y).max(0.05);
        let height = ((cal.bottom_y - info.wrist[1]) / span).clamp(0.0, 1.0);
        let vol = libm::powf(height, 1.6);
        let pan_x = if cal.mirror_frame {
            info.wrist[0]
        } else {
            1.0 - info.wrist[0]
        };
        let pan = ((pan_x - 0.5) * 1.6).clamp(-1.0, 1.0);

        self.cutoff_raw +=
            (cutoff - self.cutoff_raw) * math::one_pole_coeff(self.cfg.cutoff_tc, dt);
        self.pan_raw += (pan - self.pan_raw) * math::one_pole_coeff(0.12, dt);

        // pinch toggles arp (edge triggered, 150 ms debounce); while arp, height = rate
        if info.pinch && !self.pinch_prev {
            self.pinch_since = t_ms;
        }
        if info.pinch
            && self.pinch_prev
            && t_ms - self.pinch_since > 150.0
            && self.pinch_since > 0.0
        {
            self.state.arp = !self.state.arp;
            self.events.push(Event::ArpToggle { on: self.state.arp });
            self.pinch_since = -1.0; // consumed until release
        }
        if !info.pinch {
            self.pinch_since = 0.0;
        }
        self.pinch_prev = info.pinch;

        if self.state.arp {
            self.state.arp_rate += (height - self.state.arp_rate) * math::one_pole_coeff(0.1, dt);
        } else {
            self.volume_raw +=
                (vol - self.volume_raw) * math::one_pole_coeff(self.cfg.volume_tc, dt);
        }
        changed
    }

    /// Both fists touching then rotating -> key change around the circle of fifths.
    fn process_key_gesture(&mut self) {
        let l = self.left.info;
        let r = self.right.info;
        let active = l.present
            && r.present
            && l.fist
            && r.fist
            && math::dist2(l.wrist, r.wrist) < 1.6 * l.palm_size.max(r.palm_size);
        if !active {
            self.key_gesture = None;
            return;
        }
        let dx = r.wrist[0] - l.wrist[0];
        let dy = r.wrist[1] - l.wrist[1];
        let angle = libm::atan2f(dy, dx).to_degrees();
        match &mut self.key_gesture {
            None => {
                self.key_gesture = Some(KeyGesture {
                    last_angle: angle,
                    accum: 0.0,
                })
            }
            Some(kg) => {
                let mut d = angle - kg.last_angle;
                if d > 180.0 {
                    d -= 360.0;
                } else if d < -180.0 {
                    d += 360.0;
                }
                kg.last_angle = angle;
                kg.accum += d;
                let mut steps = 0;
                while kg.accum >= 30.0 {
                    kg.accum -= 30.0;
                    steps += 1;
                }
                while kg.accum <= -30.0 {
                    kg.accum += 30.0;
                    steps -= 1;
                }
                if steps != 0 {
                    let s = if self.cfg.calibration.mirror_frame {
                        steps
                    } else {
                        -steps
                    };
                    self.step_key_fifths(s);
                }
            }
        }
    }

    fn process_theremin(&mut self, dt: f32) {
        let cal = self.cfg.calibration;
        let span = (cal.bottom_y - cal.top_y).max(0.05);
        let r = self.right.info;
        let l = self.left.info;
        if r.present {
            let h = ((cal.bottom_y - r.wrist[1]) / span).clamp(0.0, 1.0);
            let mut target = self.cfg.theremin_base_midi + h * self.cfg.theremin_range;
            // predict one camera frame ahead (spec 11), then heavy smoothing
            let vel = (target - self.theremin_midi) / dt.max(1e-3);
            self.theremin_vel += (vel - self.theremin_vel) * 0.3;
            target += self.theremin_vel * 0.033;
            if self.cfg.theremin_snap {
                target = music::snap_to_scale(target, self.state.key, self.state.mode);
            }
            self.theremin_midi += (target - self.theremin_midi) * math::one_pole_coeff(0.045, dt);
            self.state.theremin_pitch_hz = music::midi_to_hz(self.theremin_midi);
            let cutoff = ((r.tilt + 45.0) / 90.0).clamp(0.0, 1.0);
            self.cutoff_raw +=
                (cutoff - self.cutoff_raw) * math::one_pole_coeff(self.cfg.cutoff_tc, dt);
        }
        if l.present {
            let h = ((cal.bottom_y - l.wrist[1]) / span).clamp(0.0, 1.0);
            let vol = libm::powf(h, 1.6);
            self.volume_raw +=
                (vol - self.volume_raw) * math::one_pole_coeff(self.cfg.volume_tc, dt);
            let vib = (l.tilt.abs() / 45.0).clamp(0.0, 1.0);
            self.state.theremin_vibrato +=
                (vib - self.state.theremin_vibrato) * math::one_pole_coeff(0.1, dt);
        } else {
            // one-handed theremin: right hand only, volume follows filter hand height too
            if r.present {
                let h = ((cal.bottom_y - r.wrist[1]) / span).clamp(0.0, 1.0);
                let vol = libm::powf(h.max(0.35), 1.2);
                self.volume_raw +=
                    (vol - self.volume_raw) * math::one_pole_coeff(self.cfg.volume_tc, dt);
            }
        }
        self.state.theremin = true;
    }

    /// Write debounced + smoothed values into the state, derive notes, emit events.
    fn rederive(&mut self, _t_ms: f64) {
        let s = &mut self.state;
        s.theremin = self.cfg.mode == PlayMode::Theremin;
        if s.theremin {
            s.degree = 0;
            s.theremin_volume = self.volume_raw * self.fade_gain;
            s.volume = s.theremin_volume;
            s.cutoff = self.cutoff_raw;
            s.derive_notes(self.cfg.voicing);
        } else {
            s.degree = self.degree.current;
            s.quality = self.quality.current;
            s.shape = self.shape.current;
            s.octave = self.octave.current;
            s.cutoff = self.cutoff_raw;
            s.pan = self.pan_raw;
            s.volume = self.volume_raw * self.fade_gain;
            s.derive_notes(self.cfg.voicing);
        }

        // chord events
        let notes_changed = s.note_count != self.last_count || s.notes != self.last_notes;
        if notes_changed {
            if s.note_count > 0 {
                self.events.push(Event::chord_on_from(s));
            } else {
                self.events.push(Event::ChordOff);
            }
            self.last_notes = s.notes;
            self.last_count = s.note_count;
        }
        // param events (for MIDI CC / renderer), only on meaningful change
        let (c, v, p) = self.last_params;
        if (s.cutoff - c).abs() > 0.005 || (s.volume - v).abs() > 0.005 || (s.pan - p).abs() > 0.01
        {
            self.events.push(Event::ParamChange {
                cutoff: s.cutoff,
                volume: s.volume,
                pan: s.pan,
            });
            self.last_params = (s.cutoff, s.volume, s.pan);
        }
    }
}

/// Synthetic hand poses for tests and the tutorial/onboarding diagrams.
/// Produces a plausible 21-landmark right hand in frame coordinates, palm facing
/// the camera, wrist at (cx, cy). `fingers` = [thumb, index, middle, ring, pinky].
pub fn synth_hand(
    cx: f32,
    cy: f32,
    palm: f32,
    fingers: [bool; 5],
    tilt_deg: f32,
    handedness: Handedness,
) -> HandFrame {
    let mut p = [[0.0f32; 3]; 21];
    // side multiplier: thumb side. In a raw (non-mirrored) frame the user's right
    // hand shows its thumb toward +x (toward the body centre on the image's right).
    let side = if handedness == Handedness::Right {
        1.0
    } else {
        -1.0
    };
    p[0] = [cx, cy, 0.0];
    // MCP row (index..pinky), fanned from thumb side to pinky side, one palm up
    let mcp_x = [0.35, 0.12, -0.12, -0.35];
    let mcp_idx = [5usize, 9, 13, 17];
    for (k, &i) in mcp_idx.iter().enumerate() {
        p[i] = [
            cx + side * mcp_x[k] * palm,
            cy - palm * (1.0 - 0.08 * k as f32),
            0.0,
        ];
    }
    // finger segments
    let fing = [(5usize, 1usize), (9, 2), (13, 3), (17, 4)];
    for (mcp, fi) in fing {
        let base = p[mcp];
        let ext = fingers[fi];
        let seg = palm * 0.32;
        for j in 1..=3 {
            let idx = mcp + j;
            if ext {
                p[idx] = [base[0], base[1] - seg * j as f32, 0.0];
            } else {
                // curled: fold down toward the palm
                let ang = 0.9 * j as f32;
                p[idx] = [
                    base[0],
                    base[1] - seg * libm::cosf(ang) * (1.0 - 0.25 * j as f32),
                    0.02 * j as f32,
                ];
            }
        }
    }
    // thumb
    let cmc = [cx + side * 0.3 * palm, cy - 0.25 * palm, 0.0];
    p[1] = cmc;
    if fingers[0] {
        // stuck out sideways
        for j in 2..=4 {
            p[j] = [
                cmc[0] + side * 0.3 * palm * (j - 1) as f32,
                cmc[1] - 0.12 * palm * (j - 1) as f32,
                0.0,
            ];
        }
    } else {
        // relaxed: resting beside the index finger, about 0.7 palm from the middle MCP
        // (a real relaxed thumb; "thumb in" needs < 0.55 palm and is a deliberate fold)
        for j in 2..=4 {
            let t = (j - 1) as f32 / 3.0;
            p[j] = [
                cmc[0] + side * 0.22 * palm * t,
                cmc[1] - 0.3 * palm * t,
                0.01,
            ];
        }
    }
    // apply tilt: rotate about the vertical axis through the wrist, so x mixes into z
    let a = tilt_deg.to_radians();
    for q in p.iter_mut() {
        let dx = q[0] - cx;
        let dz = q[2];
        // inward tilt = palm turns toward the body centre: the thumb side moves
        // away from the camera (+z) so the palm normal gains a body-centre component.
        let (nx, nz) = (dx * libm::cosf(a), side * dx * libm::sinf(a) + dz);
        q[0] = cx + nx;
        q[2] = nz;
    }
    HandFrame {
        landmarks: p,
        handedness,
        confidence: 0.95,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_label(h: Handedness) -> Handedness {
        // parser default: raw frames -> tracker labels are swapped relative to the user
        h.swapped()
    }

    fn left(fingers: [bool; 5], tilt: f32) -> HandFrame {
        let mut h = synth_hand(0.7, 0.5, 0.12, fingers, tilt, Handedness::Left);
        h.handedness = raw_label(Handedness::Left);
        h
    }

    fn right(fingers: [bool; 5], tilt: f32, y: f32) -> HandFrame {
        let mut h = synth_hand(0.3, y, 0.12, fingers, tilt, Handedness::Right);
        h.handedness = raw_label(Handedness::Right);
        h
    }

    fn run(p: &mut GestureParser, hands: &[HandFrame], frames: usize, start_ms: f64) -> f64 {
        let mut t = start_ms;
        for _ in 0..frames {
            t += 33.0;
            p.feed(hands, t);
        }
        t
    }

    #[test]
    fn finger_detection_on_synthetic_hands() {
        let mut p = GestureParser::default();
        let t = run(
            &mut p,
            &[
                left([false, true, false, false, false], 20.0),
                right([false, true, true, false, false], 0.0, 0.3),
            ],
            6,
            0.0,
        );
        assert_eq!(p.left_info().fingers, [false, true, false, false, false]);
        assert_eq!(p.right_info().fingers[1..], [true, true, false, false]);
        assert!(p.left_info().tilt > 8.0, "tilt {}", p.left_info().tilt);
        let s = p.state();
        assert_eq!(s.degree, 1, "degree after {t} ms");
        assert_eq!(s.quality, Quality::Major);
        assert_eq!(s.shape, Shape::Inv1);
        assert!(s.volume > 0.5);
        assert!(s.has_chord());
    }

    #[test]
    fn debounce_requires_stability() {
        let mut p = GestureParser::default();
        let l1 = left([false, true, false, false, false], 20.0);
        let l2 = left([false, true, true, false, false], 20.0);
        let r = right([false, true, false, false, false], 0.0, 0.4);
        run(&mut p, &[l1, r], 6, 0.0);
        assert_eq!(p.state().degree, 1);
        // one frame of II then back to I: must not change
        p.feed(&[l2, r], 300.0);
        p.feed(&[l1, r], 333.0);
        p.feed(&[l1, r], 366.0);
        assert_eq!(p.state().degree, 1);
        // hold II for > 90 ms: changes
        run(&mut p, &[l2, r], 5, 400.0);
        assert_eq!(p.state().degree, 2);
    }

    #[test]
    fn fist_mutes_and_minor_tilt() {
        let mut p = GestureParser::default();
        let r = right([false, true, false, false, false], 0.0, 0.4);
        run(
            &mut p,
            &[left([false, true, true, true, false], -25.0), r],
            6,
            0.0,
        );
        assert_eq!(p.state().degree, 3);
        assert_eq!(p.state().quality, Quality::Minor);
        run(
            &mut p,
            &[left([false, false, false, false, false], -25.0), r],
            6,
            300.0,
        );
        assert_eq!(p.state().degree, 0);
        assert!(!p.state().has_chord());
        assert!(
            p.events().iter().any(|e| matches!(e, Event::ChordOff)) || p.state().note_count == 0
        );
    }

    #[test]
    fn right_hand_shapes_and_octave() {
        let mut p = GestureParser::default();
        let l = left([false, true, false, false, false], 20.0);
        run(
            &mut p,
            &[l, right([false, true, true, true, false], 0.0, 0.4)],
            6,
            0.0,
        );
        assert_eq!(p.state().shape, Shape::Seventh);
        run(
            &mut p,
            &[l, right([false, true, true, true, true], 0.0, 0.4)],
            6,
            300.0,
        );
        assert_eq!(p.state().shape, Shape::DomOrDim7);
        assert_eq!(p.state().chord_name(VoicingSettings::default()), "I dom7");
        // thumb out -> octave +1
        run(
            &mut p,
            &[l, right([true, true, true, true, true], 0.0, 0.4)],
            6,
            600.0,
        );
        assert_eq!(p.state().octave, 1);
    }

    #[test]
    fn height_controls_volume_and_tilt_controls_cutoff() {
        let mut p = GestureParser::default();
        let l = left([false, true, false, false, false], 20.0);
        run(
            &mut p,
            &[l, right([false, true, false, false, false], 0.0, 0.2)],
            20,
            0.0,
        );
        let high = p.state().volume;
        run(
            &mut p,
            &[l, right([false, true, false, false, false], 0.0, 0.8)],
            30,
            1000.0,
        );
        let low = p.state().volume;
        assert!(high > 0.7 && low < 0.15, "high {high} low {low}");
        run(
            &mut p,
            &[l, right([false, true, false, false, false], 40.0, 0.5)],
            30,
            3000.0,
        );
        assert!(p.state().cutoff > 0.85, "cutoff {}", p.state().cutoff);
        run(
            &mut p,
            &[l, right([false, true, false, false, false], -40.0, 0.5)],
            30,
            5000.0,
        );
        assert!(p.state().cutoff < 0.15, "cutoff {}", p.state().cutoff);
    }

    #[test]
    fn lost_tracking_fades_out() {
        let mut p = GestureParser::default();
        let l = left([false, true, false, false, false], 20.0);
        let r = right([false, true, false, false, false], 0.0, 0.3);
        run(&mut p, &[l, r], 20, 0.0);
        assert!(p.state().volume > 0.5);
        // hands vanish
        let t = run(&mut p, &[], 8, 1000.0); // ~264 ms: still holding
        assert!(p.state().volume > 0.5);
        run(&mut p, &[], 60, t); // ~2 s later: faded
        assert!(p.state().volume < 0.01, "vol {}", p.state().volume);
        assert_eq!(p.state().degree, 1, "state is held, not cleared");
    }

    #[test]
    fn scale_only_scheme_uses_diatonic_quality() {
        let mut p = GestureParser::new(ParserConfig {
            left: LeftScheme::ScaleOnly,
            ..Default::default()
        });
        let r = right([false, true, false, false, false], 0.0, 0.3);
        run(
            &mut p,
            &[left([false, true, true, false, false], 30.0), r],
            6,
            0.0,
        );
        assert_eq!(p.state().degree, 2);
        assert_eq!(p.state().quality, Quality::Minor);
        run(
            &mut p,
            &[left([true, true, false, false, true], 30.0), r],
            6,
            300.0,
        );
        assert_eq!(p.state().degree, 7);
        assert_eq!(p.state().quality, Quality::Diminished);
    }

    #[test]
    fn fixed_degree_ignores_left_hand() {
        let mut p = GestureParser::new(ParserConfig {
            left: LeftScheme::FixedDegree { degree: 4 },
            ..Default::default()
        });
        run(
            &mut p,
            &[right([false, true, false, false, false], 0.0, 0.3)],
            6,
            0.0,
        );
        assert_eq!(p.state().degree, 4);
        assert!(p.state().has_chord());
        p.set_fixed_degree(5);
        assert_eq!(p.state().degree, 5);
    }

    #[test]
    fn theremin_mode_pitch_follows_height() {
        let mut p = GestureParser::new(ParserConfig {
            mode: PlayMode::Theremin,
            ..Default::default()
        });
        let l = left([false, true, true, true, true], 0.0);
        run(
            &mut p,
            &[l, right([false, true, true, true, true], 0.0, 0.8)],
            40,
            0.0,
        );
        let low = p.state().theremin_pitch_hz;
        run(
            &mut p,
            &[l, right([false, true, true, true, true], 0.0, 0.2)],
            40,
            2000.0,
        );
        let high = p.state().theremin_pitch_hz;
        assert!(high > low * 2.5, "low {low} high {high}");
        assert!(p.state().theremin);
        assert_eq!(p.state().degree, 0);
    }

    #[test]
    fn key_changes_emit_events_and_hue_walks() {
        let mut p = GestureParser::default();
        p.step_key_fifths(1);
        assert_eq!(p.state().key, PitchClass::G);
        assert!(p.events().iter().any(|e| matches!(
            e,
            Event::KeyChange {
                key: PitchClass::G,
                ..
            }
        )));
        p.set_key(PitchClass::D, Mode::Minor);
        assert_eq!(p.state().mode, Mode::Minor);
    }

    #[test]
    fn latch_after_holding_still() {
        let mut p = GestureParser::new(ParserConfig {
            latch_hold_ms: 500.0,
            ..Default::default()
        });
        let l = left([false, true, false, false, false], 20.0);
        let r = right([false, true, false, false, false], 0.0, 0.3);
        run(&mut p, &[l, r], 40, 0.0); // 1.3 s perfectly still
        assert!(p.state().latched);
        // hands leave: volume must NOT fade when latched
        run(&mut p, &[l.clone(), r][..0], 90, 2000.0);
        assert!(p.state().volume > 0.5);
        // new shape unlatches
        run(
            &mut p,
            &[left([false, true, true, false, false], 20.0), r],
            6,
            6000.0,
        );
        assert!(!p.state().latched);
    }
}
