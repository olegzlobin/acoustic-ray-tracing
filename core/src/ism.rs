//! 2.5D image-source method.
//!
//! WORLD COORDINATES (right-handed, z up), used everywhere in this crate and by the UI model:
//!   +x = right on the plan view, +y = UP on the plan view (the canvas flips y when drawing),
//!   +z = up (floor z = 0, ceiling z = H).
//! Looking down from +z this is a normal counter-clockwise-positive plane.
//!
//! Ambisonic frame (AmbiX: ACN order W,Y,Z,X, SN3D) of a listener with yaw 0:
//!   Ambisonic X (front) = world +x,  Y (left) = world +y,  Z (up) = world +z.
//! The listener yaw (counter-clockwise from +x, seen from above) is applied later by the main
//! thread through the Omnitone rotation matrix; the directions produced here are world-frame.

use std::ops::{Add, AddAssign, Index, IndexMut, Mul, MulAssign, Sub, SubAssign};

pub const NB: usize = 6;
mod diffraction;
pub mod utd;
pub use diffraction::{add_diffraction, build_edges, Edge, BAND_HZ};

/// Source directivity: per-band amplitude pattern g_b(cos) = max(alpha_b + (1 - alpha_b) * cos, floor), where `cos` is the
/// cosine of the angle between the emission direction and the (horizontal) facing axis `facing` (radians CCW from +x).
/// The presets live on the TypeScript side; the core only evaluates the pattern it is given.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Directivity {
    pub facing: f64,
    pub alpha: [f64; NB],
    pub floor: f64,
}

impl Default for Directivity {
    fn default() -> Self {
        Directivity { facing: 0.0, alpha: [1.0; NB], floor: 0.0 }
    }
}

impl Directivity {
    /// g == 1 in every direction (all alpha = 1): callers skip the weighting and stay bit-identical.
    pub fn is_omni(&self) -> bool {
        self.alpha.iter().all(|&a| a == 1.0)
    }
    /// Amplitude gain of band `b` at `cos` = cos(theta).
    #[inline]
    pub fn gain(&self, b: usize, cos: f64) -> f64 {
        (self.alpha[b] + (1.0 - self.alpha[b]) * cos).max(self.floor)
    }
    /// Cosine between the unit direction `d` (3D) and the facing axis.
    #[inline]
    pub fn cos_to(&self, d: [f64; 3]) -> f64 {
        d[0] * self.facing.cos() + d[1] * self.facing.sin()
    }
    /// Per-band amplitude gains for the direction `d`.
    pub fn gains(&self, d: [f64; 3]) -> Bands {
        let c = self.cos_to(d).clamp(-1.0, 1.0);
        Bands::from_fn(|b| self.gain(b, c))
    }
    /// Per-band ENERGY weights (gain squared) for the direction `d`.
    pub fn energy(&self, d: [f64; 3]) -> Bands {
        self.gains(d).map(|g| g * g)
    }
}

/// One value per octave band (125 Hz .. 4 kHz). Operators act per band; the floating-point
/// operation order of every expression is the same as the equivalent `for b in 0..NB` loop.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Bands(pub [f64; NB]);

impl Bands {
    pub const ZERO: Bands = Bands([0.0; NB]);
    pub const ONE: Bands = Bands([1.0; NB]);

    #[inline(always)]
    pub const fn splat(v: f64) -> Bands {
        Bands([v; NB])
    }
    #[inline(always)]
    pub fn from_fn(mut f: impl FnMut(usize) -> f64) -> Bands {
        let mut r = [0.0; NB];
        for b in 0..NB {
            r[b] = f(b);
        }
        Bands(r)
    }
    #[inline(always)]
    pub fn map(self, mut f: impl FnMut(f64) -> f64) -> Bands {
        Bands::from_fn(|b| f(self.0[b]))
    }
    #[inline(always)]
    pub fn zip(self, o: Bands, mut f: impl FnMut(f64, f64) -> f64) -> Bands {
        Bands::from_fn(|b| f(self.0[b], o.0[b]))
    }
    #[inline(always)]
    pub fn max(self, o: Bands) -> Bands {
        self.zip(o, f64::max)
    }
    #[inline(always)]
    pub fn iter(&self) -> std::slice::Iter<'_, f64> {
        self.0.iter()
    }
    #[inline(always)]
    pub fn sum(self) -> f64 {
        self.0.iter().sum()
    }
    /// Largest band value, floored at 0 (the values are energies / factors, never negative: NOT for `Path::gains`, which are signed).
    #[inline(always)]
    pub fn peak(self) -> f64 {
        self.0.iter().fold(0.0, |m, &v| m.max(v))
    }
    #[inline(always)]
    pub fn mean(self) -> f64 {
        self.sum() / NB as f64
    }
}

impl From<[f64; NB]> for Bands {
    #[inline(always)]
    fn from(a: [f64; NB]) -> Bands {
        Bands(a)
    }
}
impl From<f64> for Bands {
    #[inline(always)]
    fn from(x: f64) -> Bands {
        Bands::splat(x)
    }
}
impl Index<usize> for Bands {
    type Output = f64;
    #[inline(always)]
    fn index(&self, b: usize) -> &f64 {
        &self.0[b]
    }
}
impl IndexMut<usize> for Bands {
    #[inline(always)]
    fn index_mut(&mut self, b: usize) -> &mut f64 {
        &mut self.0[b]
    }
}
macro_rules! band_op {
    ($tr:ident, $f:ident, $tra:ident, $fa:ident, $op:tt) => {
        impl $tr for Bands {
            type Output = Bands;
            #[inline(always)]
            fn $f(self, o: Bands) -> Bands {
                Bands::from_fn(|b| self.0[b] $op o.0[b])
            }
        }
        impl $tr<f64> for Bands {
            type Output = Bands;
            #[inline(always)]
            fn $f(self, o: f64) -> Bands {
                Bands::from_fn(|b| self.0[b] $op o)
            }
        }
        impl $tra for Bands {
            #[inline(always)]
            fn $fa(&mut self, o: Bands) {
                for b in 0..NB {
                    self.0[b] = self.0[b] $op o.0[b];
                }
            }
        }
        impl $tra<f64> for Bands {
            #[inline(always)]
            fn $fa(&mut self, o: f64) {
                for b in 0..NB {
                    self.0[b] = self.0[b] $op o;
                }
            }
        }
    };
}
band_op!(Add, add, AddAssign, add_assign, +);
band_op!(Sub, sub, SubAssign, sub_assign, -);
band_op!(Mul, mul, MulAssign, mul_assign, *);
pub const SPEED_OF_SOUND: f64 = 343.0;
/// Air absorption, dB per metre, per octave band 125..4k (ISO 9613-1, 20 C, 50 %).
pub const AIR_DB_PER_M: Bands = Bands([0.00044, 0.00131, 0.00273, 0.00466, 0.00986, 0.0328]);

const EPS: f64 = 1e-9;

#[derive(Clone, Copy, Debug)]
pub struct Wall {
    pub p1: [f64; 2],
    pub p2: [f64; 2],
    pub mat: usize,
    /// Vertical extent in metres above the floor. `z1` may be huge ("to the ceiling"); `Scene::new` clamps
    /// to the room height.
    pub z0: f64,
    pub z1: f64,
}

/// Tolerance of the "full height" test (m).
const FULL_TOL: f64 = 1e-6;

impl Wall {
    /// Wall from the floor to the ceiling (whatever the room height).
    pub fn full(p1: [f64; 2], p2: [f64; 2], mat: usize) -> Wall {
        Wall { p1, p2, mat, z0: 0.0, z1: f64::INFINITY }
    }
    /// Wall with a vertical extent [z0, z1].
    pub fn partial(p1: [f64; 2], p2: [f64; 2], mat: usize, z0: f64, z1: f64) -> Wall {
        Wall { p1, p2, mat, z0, z1 }
    }
    /// Spans the whole room height `h`.
    #[inline]
    pub fn is_full(&self, h: f64) -> bool {
        self.z0 <= FULL_TOL && self.z1 >= h - FULL_TOL
    }
    /// z1 clamped to the room height, z0 to [0, z1].
    pub fn clamped(self, h: f64) -> Wall {
        let z1 = if self.z1.is_nan() { h } else { self.z1.min(h) };
        let z0 = if self.z0.is_nan() { 0.0 } else { self.z0.clamp(0.0, z1.max(0.0)) };
        Wall { z0, z1, ..self }
    }
}

/// Horizontal face of a closed group of partial-height walls (an obstacle of the plan analysis): the
/// top of a sofa, both sides of a table slab. `up` = the normal points to +z (top cap).
#[derive(Clone, Debug)]
pub struct Cap {
    pub ring: Vec<[f64; 2]>,
    pub z: f64,
    pub up: bool,
    pub mat: usize,
    /// [xmin, ymin, xmax, ymax] of the ring.
    pub bbox: [f64; 4],
}

impl Cap {
    #[inline]
    pub fn contains(&self, p: [f64; 2]) -> bool {
        let b = &self.bbox;
        p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] && crate::plan::point_in_ring(p, &self.ring)
    }
}

/// Distance from `p` to the segment a-b.
fn dist_to_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (p[0] - (a[0] + t * dx)).hypot(p[1] - (a[1] + t * dy))
}

/// Caps of the closed groups of partial-height walls: for every obstacle face of the plan analysis each
/// ring edge is mapped to the wall(s) covering it (collinear and overlapping); the top is at the lowest
/// `z1` of them, the bottom at the highest `z0`. A top cap exists when the top is below the ceiling, a bottom
/// cap when the bottom is above the floor; the material is that of the first covering wall.
pub fn build_caps(walls: &[Wall], h: f64) -> Vec<Cap> {
    if walls.iter().all(|w| w.is_full(h)) {
        return Vec::new();
    }
    let tol = 2.0 * crate::plan::SNAP_TOL;
    let plan = crate::plan::analyze(walls);
    let mut caps = Vec::new();
    for f in plan.faces.iter().filter(|f| f.region == crate::plan::Region::Obstacle) {
        let (mut top, mut bottom, mut mat) = (f64::INFINITY, f64::NEG_INFINITY, None);
        for i in 0..f.ring.len() {
            let (a, b) = (f.ring[i], f.ring[(i + 1) % f.ring.len()]);
            if (a[0] - b[0]).hypot(a[1] - b[1]) < 1e-9 {
                continue;
            }
            for w in walls {
                if dist_to_segment(a, w.p1, w.p2) <= tol && dist_to_segment(b, w.p1, w.p2) <= tol {
                    top = top.min(w.z1);
                    bottom = bottom.max(w.z0);
                    mat.get_or_insert(w.mat);
                }
            }
        }
        let Some(mat) = mat else { continue };
        let mut bbox = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for p in &f.ring {
            bbox = [bbox[0].min(p[0]), bbox[1].min(p[1]), bbox[2].max(p[0]), bbox[3].max(p[1])];
        }
        if top < h - FULL_TOL {
            caps.push(Cap { ring: f.ring.clone(), z: top, up: true, mat, bbox });
        }
        if bottom > FULL_TOL {
            caps.push(Cap { ring: f.ring.clone(), z: bottom, up: false, mat, bbox });
        }
    }
    caps
}

/// Surface material. Conventions: `alpha` is the energy fraction that is NOT reflected (so it
/// includes the transmitted part), `tau` the energy transmission coefficient (10^(-TL/10), 0 = opaque).
/// Reflected = 1 - alpha_eff, transmitted = tau, dissipated = alpha_eff - tau, where
/// `alpha_eff = max(alpha, tau)` enforces tau <= alpha (see `alpha_eff`).
#[derive(Clone, Copy, Debug)]
pub struct Material {
    pub alpha: Bands,
    /// Scattering coefficient per band: the share of the reflected energy that leaves diffusely.
    pub scatter: Bands,
    pub tau: Bands,
}

/// Transmission loss in dB -> energy transmission coefficient. Non-finite or negative TL gives
/// tau = 0 for +inf and tau = 1 for TL <= 0.
pub fn tl_to_tau(tl_db: f64) -> f64 {
    if tl_db.is_nan() {
        0.0
    } else {
        10f64.powf(-tl_db.max(0.0) / 10.0)
    }
}

impl Material {
    /// Opaque material (no transmission).
    pub fn new(alpha: impl Into<Bands>, scatter: impl Into<Bands>) -> Material {
        Material { alpha: alpha.into(), scatter: scatter.into(), tau: Bands::ZERO }
    }
    /// Effective absorption: a surface cannot transmit more than it does not reflect, so
    /// alpha_eff = max(alpha, tau), clamped to [0, 1]. Equals `alpha` for opaque materials.
    pub fn alpha_eff(&self) -> Bands {
        self.alpha.zip(self.tau, |a, t| a.clamp(0.0, 1.0).max(t.clamp(0.0, 1.0)))
    }
    /// Energy transmission coefficients clamped to [0, 1].
    pub fn tau_c(&self) -> Bands {
        self.tau.map(|t| t.clamp(0.0, 1.0))
    }
    /// The same material without transmission (floor and ceiling never transmit).
    pub fn without_tx(&self) -> Material {
        Material { tau: Bands::ZERO, ..*self }
    }
    pub fn transmits(&self) -> bool {
        self.tau.iter().any(|&t| t > 0.0)
    }
    /// Per-band pressure reflection factor sqrt((1 - alpha_eff)(1 - s)).
    pub fn refl(&self) -> Bands {
        let ae = self.alpha_eff();
        Bands::from_fn(|b| ((1.0 - ae[b]).clamp(0.0, 1.0) * (1.0 - self.scatter[b]).clamp(0.0, 1.0)).sqrt())
    }
}

#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub walls: Vec<Wall>,
    pub materials: Vec<Material>,
    pub height: f64,
    pub floor_mat: usize,
    pub ceil_mat: usize,
    /// Horizontal faces of closed groups of partial-height walls (see `build_caps`). Filled by `Scene::new`.
    pub caps: Vec<Cap>,
}

impl Scene {
    /// Scene with the walls clamped to the room height and the caps derived from them.
    pub fn new(walls: Vec<Wall>, materials: Vec<Material>, height: f64, floor_mat: usize, ceil_mat: usize) -> Scene {
        let walls: Vec<Wall> = walls.into_iter().map(|w| w.clamped(height)).collect();
        let caps = build_caps(&walls, height);
        Scene { walls, materials, height, floor_mat, ceil_mat, caps }
    }

    /// Some wall does not span the whole room height.
    pub fn has_partial(&self) -> bool {
        self.walls.iter().any(|w| !w.is_full(self.height))
    }

    /// Materials of all surfaces in tracer order: walls `0..n`, floor `n`, ceiling `n + 1`, caps `n + 2..`.
    /// Floor and ceiling never transmit (the energy leaving there is lost anyway); caps transmit like walls.
    pub fn surface_materials(&self) -> Vec<Material> {
        let walls = self.walls.iter().map(|w| self.mat(w.mat));
        walls
            .chain([self.mat(self.floor_mat).without_tx(), self.mat(self.ceil_mat).without_tx()])
            .chain(self.caps.iter().map(|c| self.mat(c.mat)))
            .collect()
    }

    pub fn mat(&self, i: usize) -> Material {
        self.materials
            .get(i)
            .copied()
            .unwrap_or(Material::new(Bands::splat(0.1), 0.0))
    }
}

/// One valid specular path (horizontal chain x vertical image).
#[derive(Clone, Debug)]
pub struct Path {
    /// Total reflection count (walls + floor + ceiling).
    pub order: u32,
    /// Unfolded 3D length in metres.
    pub r: f64,
    /// Per-band linear amplitude (reflection losses x air x 1/r). Signed: the diffracted path added in the lit
    /// zone (see `diffraction`) has negative gains; consumers must sum them linearly (IR synthesis) or square them
    /// (energy, ETC, visualisation), never take `peak()` / `log10` of them directly.
    pub gains: Bands,
    /// Unit vector from listener toward the final image source, world frame.
    pub dir: [f64; 3],
    /// Plan polyline: source -> reflection points -> listener.
    pub pts: Vec<[f64; 2]>,
    /// Number of wall crossings (transmissions) along the legs.
    pub crossed: u32,
    /// Coherence group (0 = none): a geometric path together with its lit-zone diffracted paths, or all shadow paths of one
    /// edge. The ETC sums a group coherently (see `metrics::build_etc`); all other paths add as energies.
    pub coh: u32,
}

impl Path {
    pub fn delay(&self) -> f64 {
        self.r / SPEED_OF_SOUND
    }
    /// Broadband energy (mean of squared band amplitudes).
    pub fn energy(&self) -> f64 {
        (self.gains * self.gains).mean()
    }
}

// ---------------------------------------------------------------- 2D geometry

use crate::geom::{cross, sub};

/// Mirror point `p` across the infinite line through the wall.
fn mirror(p: [f64; 2], w: &Wall) -> Option<[f64; 2]> {
    let d = sub(w.p2, w.p1);
    let len2 = d[0] * d[0] + d[1] * d[1];
    if len2 < EPS {
        return None;
    }
    let v = sub(p, w.p1);
    let t = (v[0] * d[0] + v[1] * d[1]) / len2;
    let foot = [w.p1[0] + t * d[0], w.p1[1] + t * d[1]];
    Some([2.0 * foot[0] - p[0], 2.0 * foot[1] - p[1]])
}

/// Parameters (t along a->b, u along wall) of the intersection of segment a->b with the wall
/// segment, if the lines are not parallel.
fn intersect(a: [f64; 2], b: [f64; 2], w: &Wall) -> Option<(f64, f64)> {
    let r = sub(b, a);
    let s = sub(w.p2, w.p1);
    let den = cross(r, s);
    if den.abs() < 1e-12 {
        return None;
    }
    let qp = sub(w.p1, a);
    let t = cross(qp, s) / den;
    let u = cross(qp, r) / den;
    Some((t, u))
}

/// Sound pressure amplitude factor sqrt(tau_b) of every wall; `None` = fully opaque (all tau = 0),
/// so legs that cross it are rejected exactly as in a scene without transmission.
pub fn wall_amps(scene: &Scene) -> Vec<Option<Bands>> {
    scene
        .walls
        .iter()
        .map(|w| {
            let m = scene.mat(w.mat);
            if !m.transmits() {
                return None;
            }
            let t = m.tau_c();
            Some(t.map(f64::sqrt))
        })
        .collect()
}

/// Legs weaker than this broadband energy (mean over bands of the squared amplitude factor,
/// -80 dB) are dropped.
const MIN_TX_ENERGY: f64 = 1e-8;

fn tx_energy(g: &Bands) -> f64 {
    (*g * *g).mean()
}

/// Partial-height walls met by a horizontal path (they are transparent in the plan stage): crossings and
/// reflections with their arclength from the listener along the polyline. The height check happens per
/// vertical image in `vertical_events`.
struct PartLog<'a> {
    /// Per wall: does not span the whole room height.
    partial: &'a [bool],
    /// Arclength (from the listener) at the start of the segment being walked.
    s0: f64,
    /// (wall, arclength, is a reflection)
    ev: Vec<(usize, f64, bool)>,
}

/// Walk segment a->b over all walls except the excluded ones: every crossed wall multiplies `acc`
/// by its transmission amplitude and bumps `n`. Returns false when a crossed wall is opaque or the
/// accumulated broadband attenuation drops below -80 dB. With a `log`, partial-height walls are only
/// recorded (and neither attenuate nor block).
fn cross_walls(
    walls: &[Wall],
    amps: &[Option<Bands>],
    a: [f64; 2],
    b: [f64; 2],
    ex1: Option<usize>,
    ex2: Option<usize>,
    acc: &mut Bands,
    n: &mut u32,
    mut log: Option<&mut PartLog>,
) -> bool {
    for (i, w) in walls.iter().enumerate() {
        if Some(i) == ex1 || Some(i) == ex2 {
            continue;
        }
        if let Some((t, u)) = intersect(a, b, w) {
            if t > 1e-6 && t < 1.0 - 1e-6 && u > -EPS && u < 1.0 + EPS {
                if let Some(l) = log.as_deref_mut() {
                    if l.partial[i] {
                        l.ev.push((i, l.s0 + t * (b[0] - a[0]).hypot(b[1] - a[1]), false));
                        continue;
                    }
                }
                let Some(am) = amps.get(i).and_then(|x| x.as_ref()) else { return false };
                *acc *= *am;
                *n += 1;
                if tx_energy(acc) < MIN_TX_ENERGY {
                    return false;
                }
            }
        }
    }
    true
}

// ---------------------------------------------------------------- horizontal image tree

pub struct Node {
    image: [f64; 2],
    wall: usize,
    parent: Option<usize>,
}

/// Recursively mirror images over the walls. Pruning: never mirror across the same wall twice in a
/// row, and skip degenerate cases where the parent lies on the wall line. Geometric validity
/// (reflection point within the wall extent, side of the wall, occlusion) is decided when
/// back-tracing from the listener, which also rejects images on the "wrong side" of a wall.
pub fn build_tree(walls: &[Wall], src: [f64; 2], max_h: u32) -> Vec<Node> {
    let mut nodes = Vec::new();
    fn rec(
        walls: &[Wall],
        nodes: &mut Vec<Node>,
        parent: Option<usize>,
        parent_image: [f64; 2],
        parent_wall: Option<usize>,
        order: u32,
        max_h: u32,
    ) {
        if order >= max_h {
            return;
        }
        for (wi, w) in walls.iter().enumerate() {
            if Some(wi) == parent_wall {
                continue;
            }
            let d = sub(w.p2, w.p1);
            let len = (d[0] * d[0] + d[1] * d[1]).sqrt();
            if len < EPS {
                continue;
            }
            let dist = cross(d, sub(parent_image, w.p1)).abs() / len;
            if dist < EPS {
                continue;
            }
            let Some(img) = mirror(parent_image, w) else { continue };
            let idx = nodes.len();
            nodes.push(Node { image: img, wall: wi, parent });
            rec(walls, nodes, Some(idx), img, Some(wi), order + 1, max_h);
        }
    }
    rec(walls, &mut nodes, None, src, None, 0, max_h);
    nodes
}

/// Result of a valid back-trace.
struct Traced {
    pts: Vec<[f64; 2]>,
    chain: Vec<usize>,
    /// Pressure amplitude factor from the crossed walls, per band.
    tx: Bands,
    crossed: u32,
    /// Partial-height wall events (empty without partial walls).
    ev: Vec<(usize, f64, bool)>,
}

/// Back-trace listener -> image chain -> source. Returns plan polyline source..listener, the wall
/// indices ordered from the source side to the listener side, and the transmission factors of the
/// walls crossed by the legs. `partial` (empty = no partial-height walls) flags the walls that are
/// transparent here and logged instead.
fn trace(walls: &[Wall], amps: &[Option<Bands>], partial: &[bool], lis: [f64; 2], src: [f64; 2], nodes: &[Node], idx: usize) -> Option<Traced> {
    let mut pts = vec![lis];
    let mut chain = Vec::new();
    let mut recv = lis;
    let mut prev_wall: Option<usize> = None;
    let mut cur = Some(idx);
    let mut tx = Bands::ONE;
    let mut crossed = 0u32;
    let mut log = (!partial.is_empty()).then(|| PartLog { partial, s0: 0.0, ev: Vec::new() });
    let mut s_cum = 0.0;
    while let Some(i) = cur {
        let n = &nodes[i];
        let w = &walls[n.wall];
        let (t, u) = intersect(recv, n.image, w)?;
        // Reflection points exactly at a wall end (grazing a corner) are rejected: they are measure-zero
        // artifacts (e.g. symmetric placements) and would create legs through the exterior.
        if !(t > 1e-9 && t < 1.0 && u > 1e-6 && u < 1.0 - 1e-6) {
            return None;
        }
        let q = [recv[0] + t * (n.image[0] - recv[0]), recv[1] + t * (n.image[1] - recv[1])];
        if let Some(l) = log.as_mut() {
            l.s0 = s_cum;
        }
        if !cross_walls(walls, amps, recv, q, Some(n.wall), prev_wall, &mut tx, &mut crossed, log.as_mut()) {
            return None;
        }
        if let Some(l) = log.as_mut() {
            s_cum += (q[0] - recv[0]).hypot(q[1] - recv[1]);
            if partial[n.wall] {
                l.ev.push((n.wall, s_cum, true));
            }
        }
        pts.push(q);
        chain.push(n.wall);
        recv = q;
        prev_wall = Some(n.wall);
        cur = n.parent;
    }
    if let Some(l) = log.as_mut() {
        l.s0 = s_cum;
    }
    if !cross_walls(walls, amps, recv, src, prev_wall, None, &mut tx, &mut crossed, log.as_mut()) {
        return None;
    }
    pts.push(src);
    pts.reverse();
    chain.reverse();
    Some(Traced { pts, chain, tx, crossed, ev: log.map(|l| l.ev).unwrap_or_default() })
}

// ---------------------------------------------------------------- vertical images

struct VImage {
    z: f64,
    floor_hits: u32,
    ceil_hits: u32,
}

/// Floor/ceiling mirror series up to `max_v` reflections: for each k >= 1 two images, one starting
/// with the floor (-z_s, 2H+z_s, -2H-z_s, ...) and one starting with the ceiling (2H-z_s, -2H+z_s, ...).
fn vertical_images(zs: f64, h: f64, max_v: u32) -> Vec<VImage> {
    let mut v = vec![VImage { z: zs, floor_hits: 0, ceil_hits: 0 }];
    for start_floor in [true, false] {
        let (mut z, mut f, mut c) = (zs, 0u32, 0u32);
        let mut floor_next = start_floor;
        for _ in 0..max_v {
            if floor_next {
                z = -z;
                f += 1;
            } else {
                z = 2.0 * h - z;
                c += 1;
            }
            floor_next = !floor_next;
            v.push(VImage { z, floor_hits: f, ceil_hits: c });
        }
    }
    v
}

// ---------------------------------------------------------------- public entry

/// Horizontal image-source tree cached for one (scene version, source xy, max order) and the diffraction
/// edges of the scene version. Listener-only moves reuse them and only re-run the back-trace validation.
#[derive(Default)]
pub struct IsmCache {
    key: Option<(u64, [f64; 2], u32)>,
    nodes: Vec<Node>,
    edges: Option<(u64, Vec<Edge>)>,
    /// Number of tree rebuilds (for tests / diagnostics).
    pub builds: u32,
}

impl IsmCache {
    pub fn tree(&mut self, scene: &Scene, scene_ver: u64, src2: [f64; 2], max_order: u32) -> &[Node] {
        let key = (scene_ver, src2, max_order);
        if self.key != Some(key) {
            self.nodes = build_tree(&scene.walls, src2, max_order);
            self.key = Some(key);
            self.builds += 1;
        }
        &self.nodes
    }

    /// The tree and, with `diffraction`, the scene's edges (built once per scene version).
    pub fn tree_and_edges(&mut self, scene: &Scene, scene_ver: u64, src2: [f64; 2], max_order: u32, diffraction: bool) -> (&[Node], Option<&[Edge]>) {
        self.tree(scene, scene_ver, src2, max_order);
        if !diffraction {
            return (&self.nodes, None);
        }
        if self.edges.as_ref().map(|e| e.0) != Some(scene_ver) {
            self.edges = Some((scene_ver, build_edges(scene)));
        }
        (&self.nodes, self.edges.as_ref().map(|e| e.1.as_slice()))
    }
}

/// `compute_paths_with_tree` plus the edge diffraction of the direct sound and of floor / ceiling reflections (see `diffraction`); `None`
/// edges = exactly the plain result.
pub fn compute_paths_with_edges(scene: &Scene, nodes: &[Node], edges: Option<&[Edge]>, src: [f64; 3], lis: [f64; 3], max_order: u32) -> Vec<Path> {
    let mut out = compute_paths_with_tree(scene, nodes, src, lis, max_order);
    if let Some(edges) = edges {
        add_diffraction(scene, edges, src, lis, max_order, &mut out);
    }
    out
}

pub fn compute_paths(scene: &Scene, src: [f64; 3], lis: [f64; 3], max_order: u32) -> Vec<Path> {
    let nodes = build_tree(&scene.walls, [src[0], src[1]], max_order);
    compute_paths_with_tree(scene, &nodes, src, lis, max_order)
}

// ---------------------------------------------------------------- partial-height walls and caps

/// Height of an unfolded vertical coordinate folded back into the room [0, h].
#[inline]
fn fold_z(zu: f64, h: f64) -> f64 {
    let m = zu.rem_euclid(2.0 * h);
    if m <= h {
        m
    } else {
        2.0 * h - m
    }
}

/// Plan point at arclength `s` from the listener along the polyline (stored source..listener).
fn point_at(pts: &[[f64; 2]], s: f64) -> [f64; 2] {
    let mut rem = s;
    for k in (1..pts.len()).rev() {
        let (a, b) = (pts[k], pts[k - 1]);
        let l = (b[0] - a[0]).hypot(b[1] - a[1]);
        if rem <= l {
            let t = if l > 0.0 { rem / l } else { 0.0 };
            return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        }
        rem -= l;
    }
    pts[0]
}

/// Transmission amplitude of a cap material (`None` = opaque), like `wall_amps`.
fn cap_amps(scene: &Scene) -> Vec<Option<Bands>> {
    scene
        .caps
        .iter()
        .map(|c| {
            let m = scene.mat(c.mat);
            m.transmits().then(|| m.tau_c().map(f64::sqrt))
        })
        .collect()
}

/// Multiply the transmission of one crossing into `acc`; false when the surface is opaque or too weak.
#[inline]
fn transmit(am: &Option<Bands>, acc: &mut Bands, n: &mut u32) -> bool {
    let Some(am) = am else { return false };
    *acc *= *am;
    *n += 1;
    tx_energy(acc) >= MIN_TX_ENERGY
}

/// Height rules for one (horizontal path, vertical image) combination. The unfolded 3D path is a straight
/// line; with `d` the unfolded plan length, the unfolded height at arclength `s` from the listener is
/// `z_lis + (vz - z_lis) s / d`, the real height its fold into [0, h]. Reflections off partial walls must
/// happen within [z0, z1] (else the combination is dropped); crossings of partial walls within their
/// range and of cap faces attenuate like full-height walls. Returns the extra transmission factor and
/// crossing count, `None` when the combination is impossible.
fn vertical_events(
    scene: &Scene,
    amps: &[Option<Bands>],
    camps: &[Option<Bands>],
    hp_tx: Bands,
    ev: &[(usize, f64, bool)],
    pts: &[[f64; 2]],
    d: f64,
    z_lis: f64,
    vz: f64,
) -> Option<(Bands, u32)> {
    let h = scene.height;
    let slope = if d > 1e-12 { (vz - z_lis) / d } else { 0.0 };
    let (mut acc, mut n) = (Bands::ONE, 0u32);
    for &(wi, s, refl) in ev {
        let z = fold_z(z_lis + slope * s, h);
        let w = &scene.walls[wi];
        if z < w.z0 || z > w.z1 {
            if refl {
                return None;
            }
            continue;
        }
        if !refl && (!transmit(&amps[wi], &mut acc, &mut n) || tx_energy(&(hp_tx * acc)) < MIN_TX_ENERGY) {
            return None;
        }
    }
    if !scene.caps.is_empty() && (vz - z_lis).abs() > 1e-12 {
        let (lo, hi) = (z_lis.min(vz), z_lis.max(vz));
        for (ci, c) in scene.caps.iter().enumerate() {
            for off in [c.z, -c.z] {
                let (k0, k1) = (((lo - off) / (2.0 * h)).ceil() as i64, ((hi - off) / (2.0 * h)).floor() as i64);
                for k in k0..=k1 {
                    let zt = 2.0 * h * k as f64 + off;
                    if !(zt > lo && zt < hi) {
                        continue;
                    }
                    let s = d * (zt - z_lis) / (vz - z_lis);
                    if c.contains(point_at(pts, s)) && (!transmit(&camps[ci], &mut acc, &mut n) || tx_energy(&(hp_tx * acc)) < MIN_TX_ENERGY) {
                        return None;
                    }
                }
            }
        }
    }
    Some((acc, n))
}

/// Occlusion of the straight 3D leg a-b (plan walls of full height, partial walls at the height the leg has
/// there, caps except `excl`): multiplies the crossed surfaces into `acc`. False when blocked.
fn leg_3d(scene: &Scene, amps: &[Option<Bands>], camps: &[Option<Bands>], partial: &[bool], a: [f64; 3], b: [f64; 3], excl: Option<usize>, acc: &mut Bands, n: &mut u32) -> bool {
    let (a2, b2) = ([a[0], a[1]], [b[0], b[1]]);
    let mut log = PartLog { partial, s0: 0.0, ev: Vec::new() };
    if !cross_walls(&scene.walls, amps, a2, b2, None, None, acc, n, Some(&mut log)) {
        return false;
    }
    let len2 = (b2[0] - a2[0]).hypot(b2[1] - a2[1]);
    for &(wi, s, _) in &log.ev {
        let z = a[2] + (b[2] - a[2]) * s / len2;
        let w = &scene.walls[wi];
        if z >= w.z0 && z <= w.z1 && !transmit(&amps[wi], acc, n) {
            return false;
        }
    }
    for (ci, c) in scene.caps.iter().enumerate() {
        if Some(ci) == excl || (a[2] - c.z) * (b[2] - c.z) >= 0.0 {
            continue;
        }
        let t = (c.z - a[2]) / (b[2] - a[2]);
        if c.contains([a2[0] + t * (b2[0] - a2[0]), a2[1] + t * (b2[1] - a2[1])]) && !transmit(&camps[ci], acc, n) {
            return false;
        }
    }
    true
}

/// First-order reflections off the horizontal cap faces (image source mirrored across the cap plane;
/// source and listener must be on the side the cap faces).
fn cap_reflections(scene: &Scene, amps: &[Option<Bands>], camps: &[Option<Bands>], partial: &[bool], src: [f64; 3], lis: [f64; 3], out: &mut Vec<Path>) {
    let (s2, l2) = ([src[0], src[1]], [lis[0], lis[1]]);
    for (ci, c) in scene.caps.iter().enumerate() {
        let same_side = if c.up { src[2] > c.z && lis[2] > c.z } else { src[2] < c.z && lis[2] < c.z };
        if !same_side {
            continue;
        }
        let zi = 2.0 * c.z - src[2];
        let f = (lis[2] - c.z) / (lis[2] - zi);
        let p = [l2[0] + f * (s2[0] - l2[0]), l2[1] + f * (s2[1] - l2[1])];
        if !c.contains(p) {
            continue;
        }
        let (mut tx, mut crossed) = (Bands::ONE, 0u32);
        let hit = [p[0], p[1], c.z];
        if !leg_3d(scene, amps, camps, partial, src, hit, Some(ci), &mut tx, &mut crossed) || !leg_3d(scene, amps, camps, partial, hit, lis, Some(ci), &mut tx, &mut crossed) {
            continue;
        }
        let refl = scene.mat(c.mat).refl() * tx;
        let d2 = (s2[0] - l2[0]).hypot(s2[1] - l2[1]);
        let dz = zi - lis[2];
        let r = (d2 * d2 + dz * dz).sqrt();
        let gains = Bands::from_fn(|b| {
            let air = 10f64.powf(-AIR_DB_PER_M[b] * r / 20.0);
            refl[b] * air / r.max(0.3)
        });
        let rr = r.max(1e-9);
        let dir = [(s2[0] - l2[0]) / rr, (s2[1] - l2[1]) / rr, dz / rr];
        out.push(Path { order: 1, r, gains, dir, pts: vec![s2, p, l2], crossed, coh: 0 });
    }
}

/// Validation of a prebuilt tree for a given listener (the cheap part), plus vertical images.
///
/// Walls that do not span the whole room height are transparent in the plan stage (a horizontal path is
/// never rejected by them); their crossings and reflections are logged and judged per vertical image by
/// `vertical_events`, which also handles the cap faces; first-order cap reflections are added at the end.
/// Scenes with only full-height walls take exactly the original code path.
pub fn compute_paths_with_tree(scene: &Scene, nodes: &[Node], src: [f64; 3], lis: [f64; 3], max_order: u32) -> Vec<Path> {
    let s2 = [src[0], src[1]];
    let l2 = [lis[0], lis[1]];
    let walls = &scene.walls;
    let floor_r = scene.mat(scene.floor_mat).without_tx().refl();
    let ceil_r = scene.mat(scene.ceil_mat).without_tx().refl();
    let wall_r: Vec<Bands> = scene.materials.iter().map(|m| m.refl()).collect();
    let amps = wall_amps(scene);
    let default_r = scene.mat(usize::MAX).refl();

    let vimgs = vertical_images(src[2], scene.height, max_order);

    // Partial-height walls: per-wall flags (empty = none) and cap transmission.
    let partial_flags: Vec<bool> = walls.iter().map(|w| !w.is_full(scene.height)).collect();
    let any_partial = partial_flags.iter().any(|&p| p) || !scene.caps.is_empty();
    let partial: &[bool] = if any_partial { &partial_flags } else { &[] };
    let camps = if any_partial { cap_amps(scene) } else { Vec::new() };

    // Valid horizontal paths: (image xy, wall chain, polyline).
    struct HPath {
        image: [f64; 2],
        chain: Vec<usize>,
        pts: Vec<[f64; 2]>,
        tx: Bands,
        crossed: u32,
        ev: Vec<(usize, f64, bool)>,
    }
    let mut hpaths = Vec::new();
    {
        let (mut tx, mut crossed) = (Bands::ONE, 0u32);
        let mut log = any_partial.then(|| PartLog { partial, s0: 0.0, ev: Vec::new() });
        if cross_walls(walls, &amps, l2, s2, None, None, &mut tx, &mut crossed, log.as_mut()) {
            hpaths.push(HPath { image: s2, chain: vec![], pts: vec![s2, l2], tx, crossed, ev: log.map(|l| l.ev).unwrap_or_default() });
        }
    }
    for i in 0..nodes.len() {
        if let Some(t) = trace(walls, &amps, partial, l2, s2, nodes, i) {
            hpaths.push(HPath { image: nodes[i].image, chain: t.chain, pts: t.pts, tx: t.tx, crossed: t.crossed, ev: t.ev });
        }
    }

    let mut out = Vec::new();
    for hp in &hpaths {
        let h = hp.chain.len() as u32;
        let mut hr = hp.tx;
        for &wi in &hp.chain {
            let r = wall_r.get(walls[wi].mat).unwrap_or(&default_r);
            hr *= *r;
        }
        let d2 = ((hp.image[0] - l2[0]).powi(2) + (hp.image[1] - l2[1]).powi(2)).sqrt();
        for v in &vimgs {
            let vo = v.floor_hits + v.ceil_hits;
            if h + vo > max_order {
                continue;
            }
            let (hr, crossed) = if any_partial {
                match vertical_events(scene, &amps, &camps, hp.tx, &hp.ev, &hp.pts, d2, lis[2], v.z) {
                    Some((extra, n)) => (hr * extra, hp.crossed + n),
                    None => continue,
                }
            } else {
                (hr, hp.crossed)
            };
            let dz = v.z - lis[2];
            let r = (d2 * d2 + dz * dz).sqrt();
            let gains = Bands::from_fn(|b| {
                let refl = hr[b] * floor_r[b].powi(v.floor_hits as i32) * ceil_r[b].powi(v.ceil_hits as i32);
                let air = 10f64.powf(-AIR_DB_PER_M[b] * r / 20.0);
                refl * air / r.max(0.3)
            });
            let rr = r.max(1e-9);
            let dir = [(hp.image[0] - l2[0]) / rr, (hp.image[1] - l2[1]) / rr, dz / rr];
            out.push(Path { order: h + vo, r, gains, dir, pts: hp.pts.clone(), crossed, coh: 0 });
        }
    }
    if max_order >= 1 && !scene.caps.is_empty() {
        cap_reflections(scene, &amps, &camps, partial, src, lis, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mat() -> Material {
        Material::new(Bands::splat(0.1), 0.0)
    }

    pub fn shoebox(w: f64, d: f64, h: f64) -> Scene {
        let c = [[0.0, 0.0], [w, 0.0], [w, d], [0.0, d]];
        let walls = (0..4).map(|i| Wall::full(c[i], c[(i + 1) % 4], 0)).collect();
        Scene { walls, materials: vec![mat()], height: h, floor_mat: 0, ceil_mat: 0, caps: vec![] }
    }

    #[test]
    fn shoebox_order1_has_seven_paths() {
        let sc = shoebox(10.0, 7.0, 3.0);
        let src = [2.0, 3.0, 1.5];
        let lis = [7.0, 4.0, 1.2];
        let paths = compute_paths(&sc, src, lis, 1);
        assert_eq!(paths.len(), 7);
        let direct = paths.iter().find(|p| p.order == 0).unwrap();
        let d = ((5.0f64).powi(2) + 1.0 + 0.09).sqrt();
        assert!((direct.r - d).abs() < 1e-9);
        assert!((direct.delay() - d / 343.0).abs() < 1e-12);
        // Expected unfolded distances of the six first-order paths.
        let mut expect = vec![];
        // walls x=0, x=10, y=0, y=7
        expect.push(((-2.0f64 - 7.0).powi(2) + 1.0 + 0.09).sqrt());
        expect.push(((18.0f64 - 7.0).powi(2) + 1.0 + 0.09).sqrt());
        expect.push((25.0 + (-3.0f64 - 4.0).powi(2) + 0.09).sqrt());
        expect.push((25.0 + (11.0f64 - 4.0).powi(2) + 0.09).sqrt());
        // floor, ceiling
        expect.push((25.0 + 1.0 + (-1.5f64 - 1.2).powi(2)).sqrt());
        expect.push((25.0 + 1.0 + (4.5f64 - 1.2).powi(2)).sqrt());
        for e in expect {
            assert!(
                paths.iter().any(|p| p.order == 1 && (p.r - e).abs() < 1e-9),
                "missing path of length {e}"
            );
        }
    }

    #[test]
    fn shoebox_order3_counts_and_direction() {
        let sc = shoebox(10.0, 7.0, 3.0);
        let paths = compute_paths(&sc, [2.0, 3.0, 1.5], [7.0, 4.0, 1.2], 3);
        // 2D lattice: 1+4+8+12 horizontal paths; vertical images 1+2k: 7*1+5*4+3*8+1*12 = 63.
        assert_eq!(paths.len(), 63);
        // Direct path: source is to the left (-x) of the listener and below-ish in y.
        let d = paths.iter().find(|p| p.order == 0).unwrap();
        assert!(d.dir[0] < -0.9 && d.dir[1] < 0.0);
        for p in &paths {
            let n = (p.dir[0].powi(2) + p.dir[1].powi(2) + p.dir[2].powi(2)).sqrt();
            assert!((n - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn l_room_occluded_direct() {
        // L-shape: 10x10 square with the upper-right 5x5 corner removed.
        let pts = [[0.0, 0.0], [10.0, 0.0], [10.0, 5.0], [5.0, 5.0], [5.0, 10.0], [0.0, 10.0]];
        let walls = (0..6).map(|i| Wall::full(pts[i], pts[(i + 1) % 6], 0)).collect();
        let sc = Scene { walls, materials: vec![mat()], height: 3.0, floor_mat: 0, ceil_mat: 0, caps: vec![] };
        // Source in the right arm, listener in the top arm: the corner (5,5) blocks the line.
        let src = [8.0, 2.0, 1.5];
        let lis = [2.0, 8.0, 1.5];
        let p = compute_paths(&sc, src, lis, 0);
        assert!(p.is_empty(), "direct path should be occluded");
        // Visible pair: both in the main square.
        let p = compute_paths(&sc, [2.0, 2.0, 1.5], [4.0, 4.0, 1.5], 0);
        assert_eq!(p.len(), 1);
        // With reflections some indirect paths exist, none at order 0.
        let p = compute_paths(&sc, src, lis, 2);
        assert!(!p.is_empty() && p.iter().all(|x| x.order > 0));
    }

    #[test]
    fn free_standing_wall_reflects_from_both_sides() {
        let mut sc = shoebox(10.0, 7.0, 3.0);
        sc.walls.push(Wall::full([5.0, 2.0], [5.0, 5.0], 0));
        let want = (36.0f64 + 1.0).sqrt();
        for x in [2.0, 8.0] {
            let paths = compute_paths(&sc, [x, 3.5, 1.5], [x, 4.5, 1.5], 1);
            assert!(paths.iter().any(|p| p.order == 1 && (p.r - want).abs() < 1e-9), "no reflection off the wall seen from x = {x}");
        }
    }

    #[test]
    fn pillar_blocks_the_direct_path_and_reflects() {
        let mut sc = shoebox(10.0, 7.0, 3.0);
        let c = [[4.0, 3.0], [6.0, 3.0], [6.0, 5.0], [4.0, 5.0]];
        for i in 0..4 {
            sc.walls.push(Wall::full(c[i], c[(i + 1) % 4], 0));
        }
        let paths = compute_paths(&sc, [2.0, 4.0, 1.5], [8.0, 4.0, 1.5], 1);
        assert!(!paths.iter().any(|p| p.order == 0), "direct path must be occluded by the pillar");
        // Listener on the same side as the source: off the pillar's left face.
        let paths = compute_paths(&sc, [2.0, 4.0, 1.5], [2.0, 3.5, 1.5], 1);
        let want = (16.0f64 + 0.25).sqrt();
        assert!(paths.iter().any(|p| p.order == 1 && (p.r - want).abs() < 1e-9));
    }
}
