//! The synthetic hand generator must produce poses the parser reads as intended:
//! a relaxed thumb is octave-neutral, a stuck-out thumb is +1, and every listed
//! finger combination maps to its degree/shape. Guards the tutorial diagrams
//! and the camera-less dev hook against drift.

use gsyn_core::gesture::{synth_hand, GestureParser, HandFrame, Handedness};

fn left(f: [bool; 5], tilt: f32) -> HandFrame {
    let mut h = synth_hand(0.7, 0.5, 0.12, f, tilt, Handedness::Left);
    h.handedness = Handedness::Right; // raw frame: tracker labels are swapped
    h
}

fn right(f: [bool; 5], y: f32) -> HandFrame {
    let mut h = synth_hand(0.3, y, 0.12, f, 0.0, Handedness::Right);
    h.handedness = Handedness::Left;
    h
}

fn settle(p: &mut GestureParser, hands: &[HandFrame]) {
    for i in 0..10 {
        p.feed(hands, i as f64 * 33.0 + 1.0);
    }
}

#[test]
fn relaxed_thumb_is_octave_neutral() {
    let mut p = GestureParser::default();
    settle(
        &mut p,
        &[
            left([false, true, false, false, false], 20.0),
            right([false, true, false, false, false], 0.3),
        ],
    );
    assert_eq!(
        p.right_info().thumb,
        0,
        "relaxed thumb must not read as folded"
    );
    assert_eq!(p.state().octave, 0);
    assert_eq!(p.state().notes(), &[48, 52, 55], "I in C sits at C3");
}

#[test]
fn thumb_out_raises_octave() {
    let mut p = GestureParser::default();
    settle(
        &mut p,
        &[
            left([false, true, false, false, false], 20.0),
            right([true, true, false, false, false], 0.3),
        ],
    );
    assert_eq!(p.state().octave, 1);
}

#[test]
fn every_degree_and_shape_is_reachable() {
    let degrees: [[bool; 5]; 7] = [
        [false, true, false, false, false],
        [false, true, true, false, false],
        [false, true, true, true, false],
        [false, true, true, true, true],
        [true, true, true, true, true],
        [false, true, false, false, true],
        [true, true, false, false, true],
    ];
    for (i, f) in degrees.iter().enumerate() {
        let mut p = GestureParser::default();
        settle(
            &mut p,
            &[
                left(*f, 20.0),
                right([false, true, false, false, false], 0.3),
            ],
        );
        assert_eq!(p.state().degree as usize, i + 1, "fingers {f:?}");
    }
    for n in 1..=4u8 {
        let mut f = [false; 5];
        for k in 1..=n as usize {
            f[k] = true;
        }
        let mut p = GestureParser::default();
        settle(
            &mut p,
            &[
                left([false, true, false, false, false], 20.0),
                right(f, 0.3),
            ],
        );
        assert_eq!(p.state().shape as u8, n - 1, "right fingers {f:?}");
        assert_eq!(p.state().octave, 0);
    }
}
