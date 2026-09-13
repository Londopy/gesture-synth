//! Tiny vector helpers used by the gesture parser. No allocation, f32 only.

pub type Vec3 = [f32; 3];

#[inline]
pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[inline]
pub fn scale(a: Vec3, s: f32) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

#[inline]
pub fn dot(a: Vec3, b: Vec3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
pub fn len(a: Vec3) -> f32 {
    libm::sqrtf(dot(a, a))
}

#[inline]
pub fn dist(a: Vec3, b: Vec3) -> f32 {
    len(sub(a, b))
}

/// 2D distance ignoring z (MediaPipe z is noisy; most gesture tests use xy).
#[inline]
pub fn dist2(a: Vec3, b: Vec3) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    libm::sqrtf(dx * dx + dy * dy)
}

#[inline]
pub fn normalize(a: Vec3) -> Vec3 {
    let l = len(a);
    if l < 1e-9 {
        [0.0, 0.0, 0.0]
    } else {
        scale(a, 1.0 / l)
    }
}

/// Angle in degrees at vertex `b` of the triangle a-b-c (0..180).
#[inline]
pub fn angle_deg(a: Vec3, b: Vec3, c: Vec3) -> f32 {
    let u = normalize(sub(a, b));
    let v = normalize(sub(c, b));
    let d = dot(u, v).clamp(-1.0, 1.0);
    libm::acosf(d).to_degrees()
}

#[inline]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// One-pole smoothing coefficient for a given time constant (seconds) at `dt` seconds per update.
#[inline]
pub fn one_pole_coeff(time_constant_s: f32, dt_s: f32) -> f32 {
    if time_constant_s <= 0.0 {
        return 1.0;
    }
    1.0 - libm::expf(-dt_s / time_constant_s)
}

/// Rotate a 2D vector (x, y) by `angle` radians.
#[inline]
pub fn rot2(x: f32, y: f32, angle: f32) -> (f32, f32) {
    let (s, c) = libm::sincosf(angle);
    (x * c - y * s, x * s + y * c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn angle_at_vertex() {
        let a = [1.0, 0.0, 0.0];
        let b = [0.0, 0.0, 0.0];
        let c = [0.0, 1.0, 0.0];
        assert!((angle_deg(a, b, c) - 90.0).abs() < 1e-3);
        let straight = angle_deg([-1.0, 0.0, 0.0], b, a);
        assert!((straight - 180.0).abs() < 1e-3);
    }

    #[test]
    fn cross_is_right_handed() {
        let z = cross([1.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
        assert_eq!(z, [0.0, 0.0, 1.0]);
    }
}
