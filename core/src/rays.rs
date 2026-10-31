//! Stochastic ray tracer for the late reverberation tail (2.5D: vertical walls + floor/ceiling).
//!
//! Units are the same as the image-source taps: a tap of amplitude 1/r has energy 1/r^2, and N rays
//! start with energy 4*pi/N per band, so that "energy detected" is directly comparable and additive.
//!
//! Double counting is avoided by construction:
//!  * diffuse rain (deterministic hit -> listener leg) carries the diffuse share `s` of every
//!    reflection, the ISM carries the specular share `(1-s)`;
//!  * the receiver sphere only scores rays whose LAST reflection was specular (the diffuse leg was
//!    already counted by rain) and skips all-specular rays of order <= ISM order (exactly ISM paths).
//!    Transmissions through walls are not reflections: they change neither the order nor the
//!    specular flags, so a ray with specular reflections only (order <= ISM order) is ISM-covered no
//!    matter how many walls it crossed (the ISM multiplies sqrt(tau) per crossed wall).
//!
//! Transmission: at a wall hit a ray is transmitted with probability p_t = mean(tau) / (mean(tau) +
//! mean(1 - alpha_eff)) (direction unchanged, E_b *= tau_b / p_t) and reflected otherwise
//! (E_b *= (1 - alpha_eff_b) / (1 - p_t)): an unbiased Russian-roulette choice. Walls with tau = 0
//! have p_t = 0 exactly and take the old code path without drawing a random number. The diffuse
//! rain visibility test becomes an attenuation (product of tau over the walls crossed by the leg).

use crate::geom::{cross, sphere_dir, MAX_BOUNCES, NONE};
use crate::kernel::{trace_ray, Ctx, Ray, RayModel};
use crate::ism::{Bands, Cap, Directivity, Scene, AIR_DB_PER_M, NB, SPEED_OF_SOUND};
use std::f64::consts::PI;

pub const BIN_S: f64 = 1e-3;
const EPS_S: f64 = 1e-9;
/// Number of population-halving stages (see `RayParams::thin_fracs`).
pub const THIN_STAGES: usize = 5;

#[derive(Clone, Copy, Debug)]
pub struct RayParams {
    pub n_rays: usize,
    /// Maximum travel time (= IR length), seconds.
    pub t_max: f64,
    pub ism_order: u32,
    /// Receiver sphere radius, metres.
    pub radius: f64,
    pub seed: u64,
    /// Number of rays whose first bounces are recorded for drawing (0 = none).
    pub viz_rays: usize,
    /// Source directivity: scales every ray's initial per-band energy (omni = untouched).
    pub dir: Directivity,
    /// Use the uniform grid when the scene has more walls than this.
    pub grid_min_walls: usize,
    /// Population control: at these fractions of `t_max` every ray survives with probability 1/2
    /// (energy doubled), an unbiased Russian roulette that cuts late-time work (the late field is
    /// smooth, so fewer rays suffice). Fractions >= 1 disable a stage; stages that would leave fewer
    /// than ~600 rays alive are disabled automatically.
    pub thin_fracs: [f64; THIN_STAGES],
}

impl Default for RayParams {
    fn default() -> Self {
        RayParams { n_rays: 20000, t_max: 1.0, ism_order: 3, radius: 0.4, seed: 0x9E3779B97F4A7C15, viz_rays: 0, dir: Directivity::default(), grid_min_walls: 12, thin_fracs: [0.1, 0.2, 0.3, 0.45, 0.6] }
    }
}

/// Energy histogram, 1 ms bins (air absorption included). `e[bin*NB + band]`; `dir` = energy-weighted sum of unit vectors
/// pointing from the listener toward where the energy comes from (world frame).
pub struct Hist {
    pub nbins: usize,
    pub e: Vec<f64>,
    pub dir: Vec<[f64; 3]>,
    pub steps: u64,
    pub lost: usize,
}

impl Hist {
    /// All-zero histogram (no rays traced).
    pub fn empty(nbins: usize) -> Hist {
        Hist::new(nbins.max(1))
    }
    fn new(nbins: usize) -> Hist {
        Hist { nbins, e: vec![0.0; nbins * NB], dir: vec![[0.0; 3]; nbins], steps: 0, lost: 0 }
    }
    #[inline]
    fn add(&mut self, t: f64, e: &Bands, dir: [f64; 3]) {
        let k = (t / BIN_S) as usize;
        if k >= self.nbins {
            return;
        }
        for (x, v) in self.e[k * NB..(k + 1) * NB].iter_mut().zip(e.iter()) {
            *x += v;
        }
        let tot = e.sum();
        for i in 0..3 {
            self.dir[k][i] += dir[i] * tot;
        }
    }
}

// ------------------------------------------------------------------ RNG

pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed | 1)
    }
    /// xorshift64*
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    /// Uniform in [0,1).
    #[inline]
    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }
    /// Standard normal (Box-Muller).
    pub fn gauss(&mut self) -> f64 {
        let u1 = self.f64().max(1e-300);
        let u2 = self.f64();
        (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos()
    }
}

// ------------------------------------------------------------------ air table

/// exp(-k_b x) with k_b the energy attenuation per metre, tabulated (avoids 6 exp() per deposit).
struct AirTable {
    step: f64,
    tab: Vec<Bands>,
}
impl AirTable {
    fn new(max_dist: f64) -> AirTable {
        let step = 0.5;
        let n = (max_dist / step) as usize + 3;
        let k = AIR_DB_PER_M.map(|a| a * std::f64::consts::LN_10 / 10.0);
        let tab = (0..n).map(|i| k.map(|k| (-k * i as f64 * step).exp())).collect();
        AirTable { step, tab }
    }
    #[inline]
    fn eval(&self, x: f64) -> Bands {
        let f = x / self.step;
        let i = (f as usize).min(self.tab.len() - 2);
        let fr = (f - i as f64).min(1.0);
        let (a, b) = (&self.tab[i], &self.tab[i + 1]);
        *a + (*b - *a) * fr
    }
}

// ------------------------------------------------------------------ geometry + grid

pub(crate) struct Wall2 {
    pub(crate) p: [f64; 2],
    pub(crate) e: [f64; 2],
    /// Unit normal (arbitrary side).
    pub(crate) n: [f64; 2],
}

struct Grid {
    x0: f64,
    y0: f64,
    cw: f64,
    ch: f64,
    nx: usize,
    ny: usize,
    cells: Vec<Vec<u32>>,
}

pub struct Geo {
    pub(crate) walls: Vec<Wall2>,
    pub bbox: [f64; 4],
    grid: Option<Grid>,
    /// Every wall has all other endpoints on one side: no wall can occlude another point of the
    /// room, so listener visibility checks can be skipped.
    pub convex: bool,
    /// Some wall does not span the whole room height (hits are then checked against `zr`).
    pub partial: bool,
    /// Per wall vertical extent [z0, z1]; full-height walls are (-inf, inf). Only used when `partial`.
    zr: Vec<[f64; 2]>,
    /// Horizontal faces (surface `nw + 2 + k`).
    pub caps: Vec<Cap>,
    /// `partial` or has caps: visibility needs the 3D tests.
    pub complex: bool,
}

impl Geo {
    pub fn new(scene: &Scene, grid_min_walls: usize) -> Geo {
        let walls: Vec<Wall2> = scene
            .walls
            .iter()
            .map(|w| {
                let e = [w.p2[0] - w.p1[0], w.p2[1] - w.p1[1]];
                let l = (e[0] * e[0] + e[1] * e[1]).sqrt().max(1e-12);
                Wall2 { p: w.p1, e, n: [-e[1] / l, e[0] / l] }
            })
            .collect();
        let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for w in &scene.walls {
            for p in [w.p1, w.p2] {
                bb[0] = bb[0].min(p[0]);
                bb[1] = bb[1].min(p[1]);
                bb[2] = bb[2].max(p[0]);
                bb[3] = bb[3].max(p[1]);
            }
        }
        if walls.is_empty() {
            bb = [0.0; 4];
        }
        let grid = if walls.len() > grid_min_walls { Some(Self::build_grid(&walls, bb)) } else { None };
        let partial = scene.walls.iter().any(|w| !w.is_full(scene.height));
        let zr = if partial {
            scene.walls.iter().map(|w| if w.is_full(scene.height) { [f64::NEG_INFINITY, f64::INFINITY] } else { [w.z0, w.z1] }).collect()
        } else {
            Vec::new()
        };
        let caps = scene.caps.clone();
        let complex = partial || !caps.is_empty();
        let mut convex = !walls.is_empty() && !complex;
        'outer: for (i, w) in scene.walls.iter().enumerate() {
            let (mut pos, mut neg) = (false, false);
            for (j, o) in scene.walls.iter().enumerate() {
                if i == j {
                    continue;
                }
                for q in [o.p1, o.p2] {
                    let c = cross(walls[i].e, [q[0] - w.p1[0], q[1] - w.p1[1]]);
                    pos |= c > 1e-9;
                    neg |= c < -1e-9;
                }
                if pos && neg {
                    convex = false;
                    break 'outer;
                }
            }
        }
        Geo { walls, bbox: bb, grid, convex, partial, zr, caps, complex }
    }

    fn build_grid(walls: &[Wall2], bb: [f64; 4]) -> Grid {
        let n = ((walls.len() as f64 * 2.0).sqrt().ceil() as usize).clamp(1, 64);
        let (x0, y0) = (bb[0] - 1e-6, bb[1] - 1e-6);
        let (w, h) = ((bb[2] - bb[0]) + 2e-6, (bb[3] - bb[1]) + 2e-6);
        let (cw, ch) = (w / n as f64, h / n as f64);
        let mut cells = vec![Vec::new(); n * n];
        for (i, wl) in walls.iter().enumerate() {
            let a = wl.p;
            let b = [wl.p[0] + wl.e[0], wl.p[1] + wl.e[1]];
            let cx = |x: f64| (((x - x0) / cw) as isize).clamp(0, n as isize - 1) as usize;
            let cy = |y: f64| (((y - y0) / ch) as isize).clamp(0, n as isize - 1) as usize;
            for iy in cy(a[1].min(b[1]))..=cy(a[1].max(b[1])) {
                for ix in cx(a[0].min(b[0]))..=cx(a[0].max(b[0])) {
                    // Segment vs cell rectangle: corners must not all lie on one side of the line.
                    let (rx0, ry0) = (x0 + ix as f64 * cw, y0 + iy as f64 * ch);
                    let (mut pos, mut neg) = (false, false);
                    for (qx, qy) in [(rx0, ry0), (rx0 + cw, ry0), (rx0, ry0 + ch), (rx0 + cw, ry0 + ch)] {
                        let c = cross(wl.e, [qx - a[0], qy - a[1]]);
                        if c >= -1e-9 {
                            pos = true;
                        }
                        if c <= 1e-9 {
                            neg = true;
                        }
                    }
                    if pos && neg {
                        cells[iy * n + ix].push(i as u32);
                    }
                }
            }
        }
        Grid { x0, y0, cw, ch, nx: n, ny: n, cells }
    }

    /// Ray p + s*d vs wall i. Division-free rejection: the hit parameters are compared as
    /// numerators against `den`, and only an accepted hit pays for the division.
    #[inline]
    fn hit_wall(&self, i: usize, p: [f64; 2], d: [f64; 2], best: f64) -> Option<f64> {
        let w = &self.walls[i];
        let den0 = cross(d, w.e);
        let qp = [w.p[0] - p[0], w.p[1] - p[1]];
        let ns0 = cross(qp, w.e);
        let nu0 = cross(qp, d);
        // Fold the sign of den into the numerators without a branch, then test with one combined branch.
        let sg = 1.0f64.copysign(den0);
        let (den, ns, nu) = (den0 * sg, ns0 * sg, nu0 * sg);
        if (den < 1e-14) | (ns <= EPS_S * den) | (ns >= best * den) | (nu < -1e-9 * den) | (nu > (1.0 + 1e-9) * den) {
            return None;
        }
        Some(ns / den)
    }

    /// Nearest wall hit along p + s*d (d not necessarily unit) with s in (0, smax).
    pub fn nearest(&self, p: [f64; 2], d: [f64; 2], smax: f64, skip: usize) -> Option<(f64, usize)> {
        match &self.grid {
            None => self.brute::<false>(p, d, smax, skip, (0.0, 0.0)),
            Some(g) => self.grid_search::<false>(g, p, d, smax, skip, (0.0, 0.0)),
        }
    }

    /// Like `nearest` for the 3D ray p + s*d: a hit on a partial-height wall only counts when its height
    /// p.z + s*d.z lies within the wall's extent. Full-height scenes take the plain 2D search.
    #[inline]
    pub fn nearest3(&self, p: [f64; 3], d: [f64; 3], smax: f64, skip: usize) -> Option<(f64, usize)> {
        if !self.partial {
            return self.nearest([p[0], p[1]], [d[0], d[1]], smax, skip);
        }
        let zq = (p[2], d[2]);
        match &self.grid {
            None => self.brute::<true>([p[0], p[1]], [d[0], d[1]], smax, skip, zq),
            Some(g) => self.grid_search::<true>(g, [p[0], p[1]], [d[0], d[1]], smax, skip, zq),
        }
    }

    pub fn nearest_brute(&self, p: [f64; 2], d: [f64; 2], smax: f64, skip: usize) -> Option<(f64, usize)> {
        self.brute::<false>(p, d, smax, skip, (0.0, 0.0))
    }

    /// Nearest cap face along p + s*d (s in (0, smax)); the surface index is `nw + 2 + k`.
    pub fn nearest_cap(&self, p: [f64; 3], d: [f64; 3], smax: f64, skip: usize) -> Option<(f64, usize)> {
        if d[2].abs() <= 1e-12 {
            return None;
        }
        let nw = self.walls.len();
        let (mut best, mut bi) = (smax, NONE);
        for (k, c) in self.caps.iter().enumerate() {
            if nw + 2 + k == skip {
                continue;
            }
            let s = (c.z - p[2]) / d[2];
            if s <= 0.0 || s >= best {
                continue;
            }
            if c.contains([p[0] + s * d[0], p[1] + s * d[1]]) {
                best = s;
                bi = nw + 2 + k;
            }
        }
        (bi != NONE).then_some((best, bi))
    }

    /// Does any cap face lie on the open leg p + s*d, s in (0, 1 - 1e-6)? Calls `f(k)` for each (cap index).
    fn caps_on_leg(&self, p: [f64; 3], d: [f64; 3], skip: usize, mut f: impl FnMut(usize) -> bool) -> bool {
        let nw = self.walls.len();
        let z_end = p[2] + d[2] * (1.0 - 1e-6);
        for (k, c) in self.caps.iter().enumerate() {
            if nw + 2 + k == skip || (p[2] - c.z) * (z_end - c.z) >= 0.0 {
                continue;
            }
            let s = (c.z - p[2]) / d[2];
            if c.contains([p[0] + s * d[0], p[1] + s * d[1]]) && !f(k) {
                return false;
            }
        }
        true
    }

    /// The open 3D leg p + s*d (s in (0, 1)) meets a wall (at its height) or a cap face.
    pub fn blocked3(&self, p: [f64; 3], d: [f64; 3], skip: usize) -> bool {
        self.nearest3(p, d, 1.0 - 1e-6, skip).is_some() || !self.caps_on_leg(p, d, skip, |_| false)
    }

    /// 3D version of `leg_tau`: partial walls count only at the leg's height there, cap faces are
    /// crossed like walls (`taus` is indexed by surface: walls, floor, ceiling, caps).
    pub fn leg_tau3(&self, p: [f64; 3], d: [f64; 3], skip: usize, taus: &[Bands]) -> Option<Bands> {
        let nw = self.walls.len();
        let mut f = Bands::ONE;
        let (mut origin, mut tmax, mut skip_w) = (p, 1.0 - 1e-6, skip);
        let inv_len = 1.0 / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt().max(1e-12);
        let mut walls_done = false;
        for _ in 0..64 {
            let Some((s, wi)) = self.nearest3(origin, d, tmax, skip_w) else {
                walls_done = true;
                break;
            };
            f *= taus[wi];
            if f.peak() < 1e-8 {
                return None;
            }
            let adv = s + 1e-7 * inv_len;
            origin = [origin[0] + adv * d[0], origin[1] + adv * d[1], origin[2] + adv * d[2]];
            tmax -= adv;
            skip_w = wi;
            if tmax <= 0.0 {
                walls_done = true;
                break;
            }
        }
        if !walls_done {
            return None;
        }
        let ok = self.caps_on_leg(p, d, skip, |k| {
            f *= taus[nw + 2 + k];
            f.peak() >= 1e-8
        });
        ok.then_some(f)
    }

    fn brute<const Z: bool>(&self, p: [f64; 2], d: [f64; 2], smax: f64, skip: usize, zq: (f64, f64)) -> Option<(f64, usize)> {
        let mut best = smax;
        let mut bi = NONE;
        for i in 0..self.walls.len() {
            if i == skip {
                continue;
            }
            if let Some(s) = self.hit_wall(i, p, d, best) {
                if Z && !self.z_ok(i, zq.0 + s * zq.1) {
                    continue;
                }
                best = s;
                bi = i;
            }
        }
        (bi != NONE).then_some((best, bi))
    }

    #[inline]
    fn z_ok(&self, i: usize, z: f64) -> bool {
        let r = self.zr[i];
        z >= r[0] && z <= r[1]
    }

    fn grid_search<const Z: bool>(&self, g: &Grid, p: [f64; 2], d: [f64; 2], smax: f64, skip: usize, zq: (f64, f64)) -> Option<(f64, usize)> {
        let mut ix = (((p[0] - g.x0) / g.cw).floor() as isize).clamp(0, g.nx as isize - 1);
        let mut iy = (((p[1] - g.y0) / g.ch).floor() as isize).clamp(0, g.ny as isize - 1);
        let (sx, sy) = (if d[0] > 0.0 { 1isize } else { -1 }, if d[1] > 0.0 { 1isize } else { -1 });
        let next = |i: isize, s: isize, o: f64, c: f64, pp: f64, dd: f64| -> (f64, f64) {
            if dd.abs() < 1e-14 {
                return (f64::INFINITY, f64::INFINITY);
            }
            let edge = o + (i + if s > 0 { 1 } else { 0 }) as f64 * c;
            ((edge - pp) / dd, c / dd.abs())
        };
        let (mut tx, dtx) = next(ix, sx, g.x0, g.cw, p[0], d[0]);
        let (mut ty, dty) = next(iy, sy, g.y0, g.ch, p[1], d[1]);
        let mut best = smax;
        let mut bi = NONE;
        loop {
            for &wi in &g.cells[iy as usize * g.nx + ix as usize] {
                let wi = wi as usize;
                if wi == skip {
                    continue;
                }
                if let Some(s) = self.hit_wall(wi, p, d, best) {
                    if Z && !self.z_ok(wi, zq.0 + s * zq.1) {
                        continue;
                    }
                    best = s;
                    bi = wi;
                }
            }
            let exit = tx.min(ty);
            if bi != NONE && best <= exit {
                break;
            }
            if exit >= smax {
                break;
            }
            if tx < ty {
                ix += sx;
                tx += dtx;
            } else {
                iy += sy;
                ty += dty;
            }
            if ix < 0 || iy < 0 || ix >= g.nx as isize || iy >= g.ny as isize {
                break;
            }
        }
        (bi != NONE).then_some((best, bi))
    }

    /// Energy factor (per band) of the straight leg p + s*d, s in (0, 1): the product of the `taus`
    /// of every crossed wall (the wall `skip` is ignored). `None` when an opaque wall (tau = 0) is
    /// crossed or the factor falls below 1e-8 in every band.
    pub fn leg_tau(&self, p: [f64; 2], d: [f64; 2], skip: usize, taus: &[Bands]) -> Option<Bands> {
        let mut f = Bands::ONE;
        let (mut origin, mut tmax, mut skip) = (p, 1.0 - 1e-6, skip);
        let inv_len = 1.0 / (d[0] * d[0] + d[1] * d[1]).sqrt().max(1e-12);
        for _ in 0..64 {
            let Some((s, wi)) = self.nearest(origin, d, tmax, skip) else { return Some(f) };
            f *= taus[wi];
            if f.peak() < 1e-8 {
                return None;
            }
            let adv = s + 1e-7 * inv_len;
            origin = [origin[0] + adv * d[0], origin[1] + adv * d[1]];
            tmax -= adv;
            skip = wi;
            if tmax <= 0.0 {
                return Some(f);
            }
        }
        None
    }

    pub fn inside_bbox(&self, x: f64, y: f64) -> bool {
        let b = &self.bbox;
        x >= b[0] - 1e-6 && x <= b[2] + 1e-6 && y >= b[1] - 1e-6 && y <= b[3] + 1e-6
    }
}

// ------------------------------------------------------------------ tracer

pub(crate) fn random_rotation(rng: &mut Rng) -> [[f64; 3]; 3] {
    // Rodrigues rotation about a random axis by a random angle.
    let z = rng.f64() * 2.0 - 1.0;
    let ph = rng.f64() * 2.0 * PI;
    let r = (1.0 - z * z).sqrt();
    let (kx, ky, kz) = (r * ph.cos(), r * ph.sin(), z);
    let th = rng.f64() * 2.0 * PI;
    let (s, c) = th.sin_cos();
    let t = 1.0 - c;
    [
        [t * kx * kx + c, t * kx * ky - s * kz, t * kx * kz + s * ky],
        [t * kx * ky + s * kz, t * ky * ky + c, t * ky * kz - s * kx],
        [t * kx * kz - s * ky, t * ky * kz + s * kx, t * kz * kz + c],
    ]
}

/// Cosine-weighted direction about unit normal n.
pub(crate) fn lambert(n: [f64; 3], rng: &mut Rng) -> [f64; 3] {
    // Orthonormal basis (t1, t2, n).
    let a = if n[0].abs() > 0.9 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] };
    let mut t1 = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
    let l = (t1[0] * t1[0] + t1[1] * t1[1] + t1[2] * t1[2]).sqrt();
    t1 = [t1[0] / l, t1[1] / l, t1[2] / l];
    let t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
    let (u1, u2) = (rng.f64(), rng.f64());
    let (r, phi) = (u1.sqrt(), 2.0 * PI * u2);
    let (x, y, z) = (r * phi.cos(), r * phi.sin(), (1.0 - u1).sqrt());
    [
        x * t1[0] + y * t2[0] + z * n[0],
        x * t1[1] + y * t2[1] + z * n[1],
        x * t1[2] + y * t2[2] + z * n[2],
    ]
}

/// Chunked, resumable ray tracer. Ray `i` of the run is a pure function of `i` (R2 low-discrepancy
/// sphere point, random-rotated by the seed) and the RNG stream continues across chunks, so tracing
/// in chunks is bit-identical to tracing all rays at once, and any prefix of the run is a
/// well-distributed ray set (usable as a coarse preview that is refined by more chunks).
pub struct RayTracer {
    geo: Geo,
    nw: usize,
    hgt: f64,
    max_dist: f64,
    air: AirTable,
    /// Per surface (walls 0..nw, floor nw, ceiling nw+1): reflection energy factor
    /// (1 - alpha_eff) / (1 - p_t) applied when the ray is reflected.
    oma: Vec<Bands>,
    /// Probability of transmitting through the surface (0 for opaque surfaces, floor and ceiling).
    pt: Vec<f64>,
    /// Energy factor tau / p_t applied when the ray is transmitted.
    tw: Vec<Bands>,
    /// Plain tau per surface (rain visibility attenuation).
    tau: Vec<Bands>,
    any_tx: bool,
    scat: Vec<f64>,
    /// Per-band scattering (clamped) for the diffuse rain; `None` when every band is 0.
    sband: Vec<Option<Bands>>,
    /// Energy weights (specular, diffuse) of the two scattering branches, only for surfaces whose bands differ.
    sw: Vec<Option<(Bands, Bands)>>,
    rng: Rng,
    rot: [[f64; 3]; 3],
    p: RayParams,
    src: [f64; 3],
    lis: [f64; 3],
    e0: f64,
    thr: f64,
    sphere_k: f64,
    thin_d: [f64; THIN_STAGES],
    viz_stride: usize,
    /// Raw histogram (energy for the rays traced so far, no air, no scaling).
    hist: Hist,
    next: usize,
    viz: Vec<f32>,
}

impl RayTracer {
    pub fn new(scene: &Scene, src: [f64; 3], lis: [f64; 3], p: &RayParams) -> RayTracer {
        let nbins = (p.t_max / BIN_S).ceil() as usize + 1;
        let geo = Geo::new(scene, p.grid_min_walls);
        let nw = geo.walls.len();
        let max_dist = SPEED_OF_SOUND * p.t_max;
        // Per surface: reflection/transmission factors and scattering; walls 0..nw, floor nw, ceiling nw+1.
        // Floor and ceiling never transmit (the energy leaving there is lost anyway).
        let mut oma: Vec<Bands> = Vec::with_capacity(nw + 2);
        let mut pt: Vec<f64> = Vec::with_capacity(nw + 2);
        let mut tw: Vec<Bands> = Vec::with_capacity(nw + 2);
        let mut tau: Vec<Bands> = Vec::with_capacity(nw + 2);
        let mut scat: Vec<f64> = Vec::with_capacity(nw + 2);
        let mut sband: Vec<Option<Bands>> = Vec::with_capacity(nw + 2);
        let mut sw: Vec<Option<(Bands, Bands)>> = Vec::with_capacity(nw + 2);
        let mut any_tx = false;
        for m in scene.surface_materials() {
            let ae = m.alpha_eff();
            let t = m.tau_c();
            let mt = t.mean();
            let mr = ae.map(|a| 1.0 - a).mean();
            let p_t = if mt > 0.0 { mt / (mt + mr) } else { 0.0 };
            let a = ae.map(|x| if p_t < 1.0 { (1.0 - x) / (1.0 - p_t) } else { 0.0 });
            let w = t.map(|x| if p_t > 0.0 { x / p_t } else { 0.0 });
            any_tx |= p_t > 0.0;
            oma.push(a);
            pt.push(p_t);
            tw.push(w);
            tau.push(if p_t > 0.0 { t } else { Bands::ZERO });
            // Scattering: the branch probability is the band mean (or the common value); non-uniform
            // surfaces reweight the branches so that band b keeps e*(1-s_b) specular / e*s_b diffuse.
            let s = m.scatter.map(|x| x.clamp(0.0, 1.0));
            let uniform = s.iter().all(|&x| x == s[0]);
            let p_s = if uniform { s[0] } else { s.mean() };
            scat.push(p_s);
            sband.push(if s.iter().any(|&x| x > 0.0) { Some(s) } else { None });
            sw.push(if uniform { None } else { Some((s.map(|x| (1.0 - x) / (1.0 - p_s)), s.map(|x| x / p_s))) });
        }
        let mut rng = Rng::new(p.seed);
        let rot = random_rotation(&mut rng);
        let n = p.n_rays.max(1);
        let e0 = 4.0 * PI / n as f64;
        let r = p.radius;
        RayTracer {
            nw,
            hgt: scene.height,
            max_dist,
            air: AirTable::new(max_dist + 10.0),
            oma,
            pt,
            tw,
            tau,
            any_tx,
            scat,
            sband,
            sw,
            rng,
            rot,
            p: *p,
            src,
            lis,
            e0,
            thr: e0 * 1e-6,
            sphere_k: 1.0 / ((4.0 * r / 3.0) * PI * r * r),
            // Keep at least ~600 rays alive: fewer halvings for small ray counts.
            thin_d: {
                let allowed = ((n as f64 / 600.0).log2().floor().max(0.0) as usize).min(THIN_STAGES);
                let mut t = p.thin_fracs.map(|f| f * max_dist);
                for d in t.iter_mut().skip(allowed) {
                    *d = f64::INFINITY;
                }
                t
            },
            viz_stride: if p.viz_rays > 0 { (n / p.viz_rays).max(1) } else { 0 },
            hist: Hist::new(nbins),
            next: 0,
            viz: Vec::new(),
            geo,
        }
    }

    pub fn done(&self) -> usize {
        self.next
    }
    pub fn total(&self) -> usize {
        self.p.n_rays
    }
    pub fn viz(&self) -> &[f32] {
        &self.viz
    }

    /// Histogram of the rays traced so far, scaled to represent all `n_rays` and with air
    /// absorption applied once per bin (air depends only on path length = c * arrival time).
    pub fn snapshot(&self) -> Hist {
        let mut h = Hist { nbins: self.hist.nbins, e: self.hist.e.clone(), dir: self.hist.dir.clone(), steps: self.hist.steps, lost: self.hist.lost };
        let scale = if self.next == 0 { 0.0 } else { self.p.n_rays as f64 / self.next as f64 };
        for k in 0..h.nbins {
            let f = self.air.eval((k as f64 + 0.5) * BIN_S * SPEED_OF_SOUND) * scale;
            for (x, f) in h.e[k * NB..(k + 1) * NB].iter_mut().zip(f.iter()) {
                *x *= f;
            }
            for i in 0..3 {
                h.dir[k][i] *= scale; // direction is an energy-weighted sum: scale like energy
            }
        }
        h
    }

    /// Trace up to `count` more rays; returns the number traced so far.
    pub fn step(&mut self, count: usize) -> usize {
        let end = (self.next + count).min(self.p.n_rays);
        let RayTracer { geo, nw, hgt, max_dist, air, oma, pt, tw, tau, any_tx, scat, sband, sw, rng, rot, p, src, lis, e0, thr, sphere_k, thin_d, viz_stride, hist, next, viz } = self;
        let ctx = Ctx { geo, nw: *nw, hgt: *hgt, max_dist: *max_dist };
        let (src, e0, viz_stride) = (*src, *e0, *viz_stride);
        let mut model = RaysModel {
            air, oma, pt, tw, tau, scat, sband, sw, any_tx: *any_tx, p, lis: *lis, thr: *thr, sphere_k: *sphere_k, thin_d,
            hist, viz, line: Vec::new(), record: false,
            order: 0, all_spec: true, last_spec: true, cap_hits: 0, stage: 0,
        };
        for i in *next..end {
            let d = sphere_dir(i, rot);
            model.record = viz_stride > 0 && i % viz_stride == 0 && model.viz.len() < p.viz_rays * 20;
            model.line.clear();
            if model.record {
                model.line.extend_from_slice(&[src[0] as f32, src[1] as f32]);
            }
            (model.order, model.all_spec, model.last_spec, model.stage, model.cap_hits) = (0, true, true, 0, 0);
            trace_ray(&ctx, &mut model, rng, Ray::new::<RaysModel>(src, d, if p.dir.is_omni() { Bands::splat(e0) } else { p.dir.energy(d) * Bands::splat(e0) }));
            if model.record {
                model.viz.push((model.line.len() / 2) as f32);
                model.viz.extend_from_slice(&model.line);
            }
        }
        *next = end;
        end
    }
}

/// Ray behaviour of the IR tracer: receiver sphere, diffuse rain, histogram, drawing lines and
/// population thinning on top of the shared kernel.
struct RaysModel<'a> {
    air: &'a AirTable,
    oma: &'a [Bands],
    pt: &'a [f64],
    tw: &'a [Bands],
    tau: &'a [Bands],
    scat: &'a [f64],
    sband: &'a [Option<Bands>],
    sw: &'a [Option<(Bands, Bands)>],
    any_tx: bool,
    p: &'a RayParams,
    lis: [f64; 3],
    thr: f64,
    sphere_k: f64,
    thin_d: &'a [f64; THIN_STAGES],
    hist: &'a mut Hist,
    viz: &'a mut Vec<f32>,
    /// Polyline of the ray being recorded (x, y pairs).
    line: Vec<f32>,
    record: bool,
    // Per-ray state.
    order: u32,
    all_spec: bool,
    last_spec: bool,
    /// Reflections off cap faces so far.
    cap_hits: u32,
    /// Number of thinning stages passed.
    stage: usize,
}

impl RayModel for RaysModel<'_> {
    type E = Bands;
    const RECIP_DZ: bool = true;
    const BOUNCE_LIMIT: u32 = MAX_BOUNCES;
    const CAP_BEFORE_ROULETTE: bool = true;

    #[inline]
    fn on_step(&mut self) {
        self.hist.steps += 1;
    }
    #[inline]
    fn on_lost(&mut self) {
        self.hist.lost += 1;
    }

    /// Receiver sphere on this segment.
    #[inline]
    fn on_segment(&mut self, ctx: &Ctx, ray: &Ray<Bands>, s: f64) {
        if !(self.last_spec && !(self.all_spec && self.order <= self.p.ism_order)) {
            return;
        }
        let (pos, d, r) = (ray.pos, ray.d, self.p.radius);
        let w = [self.lis[0] - pos[0], self.lis[1] - pos[1], self.lis[2] - pos[2]];
        let tc = w[0] * d[0] + w[1] * d[1] + w[2] * d[2];
        let perp2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2] - tc * tc;
        if perp2 < r * r {
            let half = (r * r - perp2).sqrt();
            let (t0, t1) = ((tc - half).max(0.0), (tc + half).min(s));
            if t1 > t0 {
                let tm = ray.trav + 0.5 * (t0 + t1);
                let t_arr = tm / SPEED_OF_SOUND;
                // Occlusion: the sphere may poke through a wall into the neighbouring room, where the
                // listener must not hear the ray directly (transmitted energy arrives through the
                // transmission roulette and the diffuse rain; no tau here, that would double count).
                // The segment itself crosses no wall (it ends at the next hit), so the chord midpoint
                // is on one side of any wall and a single listener -> midpoint test decides.
                if t_arr < self.p.t_max && (ctx.geo.convex || {
                    let m = 0.5 * (t0 + t1);
                    if ctx.geo.complex {
                        // Partial-height walls and cap faces: the test is 3D.
                        let mid = [pos[0] + m * d[0], pos[1] + m * d[1], pos[2] + m * d[2]];
                        !ctx.geo.blocked3(self.lis, [mid[0] - self.lis[0], mid[1] - self.lis[1], mid[2] - self.lis[2]], NONE)
                    } else {
                        let mid = [pos[0] + m * d[0], pos[1] + m * d[1]];
                        ctx.geo.nearest([self.lis[0], self.lis[1]], [mid[0] - self.lis[0], mid[1] - self.lis[1]], 1.0 - 1e-6, NONE).is_none()
                    }
                }) {
                    let k = (t1 - t0) * self.sphere_k;
                    self.hist.add(t_arr, &(ray.e * k), [-d[0], -d[1], -d[2]]);
                }
            }
        }
    }

    #[inline]
    fn thin(&mut self, ray: &mut Ray<Bands>, rng: &mut Rng) -> bool {
        while self.stage < THIN_STAGES && ray.trav >= self.thin_d[self.stage] {
            self.stage += 1;
            if rng.f64() < 0.5 {
                Self::double(&mut ray.e);
            } else {
                return false;
            }
        }
        true
    }

    #[inline]
    fn p_transmit(&self, surf: usize) -> f64 {
        self.pt[surf]
    }
    #[inline]
    fn transmit_energy(&self, e: &mut Bands, surf: usize) {
        *e *= self.tw[surf];
    }
    #[inline]
    fn reflect_energy(&self, e: &mut Bands, surf: usize) {
        *e *= self.oma[surf];
    }
    #[inline]
    fn on_transmit(&mut self, ray: &Ray<Bands>) {
        // Not a reflection: order and the specular flags are untouched.
        if self.record && ray.bounces <= 6 {
            self.line.extend_from_slice(&[ray.pos[0] as f32, ray.pos[1] as f32]);
        }
    }
    #[inline]
    fn scatter(&self, surf: usize) -> f64 {
        self.scat[surf]
    }
    #[inline]
    fn scatter_energy(&self, e: &mut Bands, surf: usize, specular: bool) {
        if let Some((ws, wd)) = &self.sw[surf] {
            *e *= if specular { *ws } else { *wd };
        }
    }

    /// Reflection bookkeeping, drawing line and diffuse rain towards the listener.
    #[inline]
    fn on_reflect(&mut self, ctx: &Ctx, ray: &Ray<Bands>, surf: usize, n3: [f64; 3]) {
        let (pos, e) = (ray.pos, &ray.e);
        self.order += 1;
        if surf >= ctx.nw + 2 {
            // The ISM has the first-order cap reflections only: a ray with any other cap history is not
            // covered by it (the receiver sphere must count it).
            self.cap_hits += 1;
            if self.cap_hits > 1 || self.order > 1 {
                self.all_spec = false;
            }
        } else if self.cap_hits > 0 {
            self.all_spec = false;
        }
        if self.record && ray.bounces <= 6 {
            self.line.extend_from_slice(&[pos[0] as f32, pos[1] as f32]);
        }
        if let Some(sb) = self.sband[surf] {
            let w = [self.lis[0] - pos[0], self.lis[1] - pos[1], self.lis[2] - pos[2]];
            let dn = w[0] * n3[0] + w[1] * n3[1] + w[2] * n3[2];
            if dn > 0.0 {
                let d2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
                let dist = d2.sqrt();
                let t_arr = (ray.trav + dist) / SPEED_OF_SOUND;
                if t_arr < self.p.t_max {
                    // Visibility: attenuation by the walls between hit point and listener.
                    let geo = ctx.geo;
                    let mut vf: Option<Bands> = None;
                    let visible = if geo.convex {
                        true
                    } else if geo.complex {
                        match geo.leg_tau3(pos, w, surf, self.tau) {
                            Some(f) => {
                                if f != Bands::ONE {
                                    vf = Some(f);
                                }
                                true
                            }
                            None => false,
                        }
                    } else if !self.any_tx {
                        geo.nearest([pos[0], pos[1]], [w[0], w[1]], 1.0 - 1e-6, surf).is_none()
                    } else {
                        match geo.leg_tau([pos[0], pos[1]], [w[0], w[1]], surf, self.tau) {
                            Some(f) => {
                                if f != Bands::ONE {
                                    vf = Some(f);
                                }
                                true
                            }
                            None => false,
                        }
                    };
                    if visible {
                        let inv_dist = 1.0 / dist;
                        let k = sb.map(|s| s * dn * inv_dist * inv_dist * inv_dist * (1.0 / PI));
                        let ed = match vf {
                            None => *e * k,
                            Some(f) => *e * k * f,
                        };
                        self.hist.add(t_arr, &ed, [-w[0] * inv_dist, -w[1] * inv_dist, -w[2] * inv_dist]);
                    }
                }
            }
        }
    }

    #[inline]
    fn on_scatter(&mut self, specular: bool) {
        self.last_spec = specular;
        if !specular {
            self.all_spec = false;
        }
    }

    #[inline]
    fn weak(&self, ray: &Ray<Bands>) -> bool {
        let e = &ray.e;
        e.peak() < self.thr || (ray.bounces & 7 == 0 && (*e * self.air.eval(ray.trav)).peak() < self.thr)
    }
    #[inline]
    fn double(e: &mut Bands) {
        *e *= 2.0;
    }
}

/// Trace all rays in one go (convenience for tests / non-progressive use).
pub fn trace(scene: &Scene, src: [f64; 3], lis: [f64; 3], p: &RayParams) -> (Hist, Vec<f32>) {
    let mut t = RayTracer::new(scene, src, lis, p);
    t.step(p.n_rays);
    (t.snapshot(), t.viz)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ism::{Material, Wall};

    fn polygon(n: usize, r: f64) -> Scene {
        let pts: Vec<[f64; 2]> = (0..n).map(|i| {
            let a = 2.0 * PI * i as f64 / n as f64;
            [r * a.cos() + r, r * a.sin() + r]
        }).collect();
        let walls = (0..n).map(|i| Wall::full(pts[i], pts[(i + 1) % n], 0)).collect();
        Scene { walls, materials: vec![Material::new(Bands::splat(0.2), 0.5)], height: 3.0, floor_mat: 0, ceil_mat: 0, caps: vec![] }
    }

    #[test]
    fn grid_matches_brute_force() {
        let sc = polygon(40, 8.0);
        let geo = Geo::new(&sc, 0);
        assert!(geo.grid.is_some());
        let mut rng = Rng::new(7);
        for _ in 0..20000 {
            let a = rng.f64() * 2.0 * PI;
            let rr = rng.f64() * 7.5;
            let p = [8.0 + rr * a.cos(), 8.0 + rr * a.sin()];
            let t = rng.f64() * 2.0 * PI;
            let d = [t.cos() * (0.2 + rng.f64()), t.sin() * (0.2 + rng.f64())];
            let a = geo.nearest_brute(p, d, 1e9, NONE);
            let b = geo.nearest(p, d, 1e9, NONE);
            assert_eq!(a.map(|x| x.1), b.map(|x| x.1));
            if let (Some(x), Some(y)) = (a, b) {
                assert!((x.0 - y.0).abs() < 1e-9);
            }
        }
    }
}
