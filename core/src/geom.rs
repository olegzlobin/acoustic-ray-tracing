//! Small shared geometry helpers (2D vectors, 3D ray bookkeeping) used by the image-source method,
//! the ray tracers and the heat map.

use crate::rays::Geo;
use std::f64::consts::PI;

/// Index meaning "no surface" (no wall to skip / no hit).
pub(crate) const NONE: usize = usize::MAX;
/// Step off a surface after a hit (m), so the next intersection test cannot find it again.
pub(crate) const OFFSET: f64 = 1e-7;
/// Hard cap on bounces/transmissions of one ray.
pub(crate) const MAX_BOUNCES: u32 = 20000;

pub(crate) fn sub(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}

#[inline]
pub(crate) fn cross(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

/// Direction of ray `i`: the R2 low-discrepancy point on the sphere (every prefix of the sequence
/// is well spread), rotated by the run's random rotation.
pub(crate) fn sphere_dir(i: usize, rot: &[[f64; 3]; 3]) -> [f64; 3] {
    const GOLDEN: [f64; 2] = [0.7548776662466927, 0.5698402909980532]; // R2 sequence
    let u = (0.5 + GOLDEN[0] * i as f64).fract();
    let ph = (0.5 + GOLDEN[1] * i as f64).fract() * 2.0 * PI;
    let z = 1.0 - 2.0 * u;
    let rho = (1.0 - z * z).max(0.0).sqrt();
    let v = [rho * ph.cos(), rho * ph.sin(), z];
    [
        rot[0][0] * v[0] + rot[0][1] * v[1] + rot[0][2] * v[2],
        rot[1][0] * v[0] + rot[1][1] * v[1] + rot[1][2] * v[2],
        rot[2][0] * v[0] + rot[2][1] * v[1] + rot[2][2] * v[2],
    ]
}

/// Surface normal facing the incoming direction `d`. Surfaces are numbered walls `0..nw`, floor
/// `nw`, ceiling `nw + 1`, cap faces `nw + 2..`.
pub(crate) fn surface_normal(geo: &Geo, surf: usize, nw: usize, d: [f64; 3]) -> [f64; 3] {
    if surf < nw {
        let wn = geo.walls[surf].n;
        if wn[0] * d[0] + wn[1] * d[1] > 0.0 {
            [-wn[0], -wn[1], 0.0]
        } else {
            [wn[0], wn[1], 0.0]
        }
    } else if surf == nw {
        [0.0, 0.0, 1.0]
    } else if surf == nw + 1 {
        [0.0, 0.0, -1.0]
    } else if d[2] > 0.0 {
        [0.0, 0.0, -1.0] // cap face: faces the incoming ray
    } else {
        [0.0, 0.0, 1.0]
    }
}

/// Specular reflection of `d` about the unit normal `n`.
#[inline]
pub(crate) fn reflect(d: [f64; 3], n: [f64; 3]) -> [f64; 3] {
    let dd = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    [d[0] - 2.0 * dd * n[0], d[1] - 2.0 * dd * n[1], d[2] - 2.0 * dd * n[2]]
}

/// `p + k * n`.
#[inline]
pub(crate) fn offset(p: [f64; 3], n: [f64; 3], k: f64) -> [f64; 3] {
    [p[0] + k * n[0], p[1] + k * n[1], p[2] + k * n[2]]
}

/// Re-normalise a direction against numerical drift.
#[inline]
pub(crate) fn normalize(d: [f64; 3]) -> [f64; 3] {
    let inv = 1.0 / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    [d[0] * inv, d[1] * inv, d[2] * inv]
}
