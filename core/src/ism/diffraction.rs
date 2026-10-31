//! Edge diffraction of the direct sound and of the paths with floor / ceiling reflections: the UTD wedge
//! diffraction coefficient (Kouyoumjian-Pathak, rigid faces, see `utd`) with the real angles and the wedge angle.
//!
//! Edges are 3D segments: the vertical edges at the wall end points and the horizontal top / bottom edges
//! of partial-height walls. For a source S and listener L the diffraction point of an edge is the point E
//! of the segment minimising |S-E| + |E-L| (closed form), r1 = |S-E|, r2 = |E-L|.
//! * Vertical edges: the wedge is the free sector (wider than 180 degrees) of the wall directions at the edge
//!   that contains S and L, n = width / pi, the angles are plan angles from the start of the sector.
//! * Horizontal edges: a thin screen (n = 2); the angles are measured in the vertical plane perpendicular to
//!   the wall (u = signed distance from the wall line, v = z - z_edge) from face 0, the direction into the wall
//!   (down for a top edge, up for a bottom edge).
//!
//! The core keeps one real signed gain per octave band: g_b = sqrt(mean over 8 log-spaced frequencies of
//! |A|^2) / max(r1 + r2, 0.3) x air absorption x floor / ceiling reflection factors, where
//! A = p_d (r1 + r2) exp(+jk (r1 + r2)). The sign is +1 in the shadow (the straight line is blocked) and -1 in
//! the lit zone: near the shadow boundary the geometric and diffracted delays coincide and the diffracted
//! field is -1/2 of the geometric one on the lit side and +1/2 in the shadow, so the level is continuous.
//!
//! * Direct path blocked: the (up to `MAX_DIFFRACTED`) strongest edges whose legs S-E and E-L are clear become
//!   extra order-0 paths (plan polyline `[src, E, lis]`); paths whose largest band amplitude is below
//!   `SKIP_REL` of the free field 1/(r1+r2) are dropped.
//! * Direct path visible: the geometric path is NOT attenuated. Instead the (up to `MAX_DIFFRACTED`) strongest
//!   edges (right geometry, clear legs) with a diffracted level of at least `LIT_REL_MIN` of the geometric path
//!   add a separate order-0 path with negative gains and the same delay as the diffracted route.
//!
//! Floor / ceiling (ISO 9613-2 style ground + barrier, generalised): in 2.5D these are the planes z = 0 and
//! z = h, so their images are trivial. For every edge the combinations (i, j) with i, j in {none, floor,
//! ceiling} are considered: i is a reflection between the source and the edge, j one between the edge and
//! the listener. With the virtual end points S* = image_i(S), L* = image_j(L) all the geometry (edge point,
//! angles, r1, r2) is computed exactly as for the direct sound ((none, none) is the direct case). The real
//! route is S -> R1 -> E -> R2 -> L with R1 = (S*-E) x plane i, R2 = (E-L*) x plane j; the reflection points
//! must lie on the planes' segments and every real leg must be clear.
//! * Blocked combo (the unfolded line S*-L* crosses an owner wall of the edge, the crossing height folded
//!   back into [0, h] lies within the wall's [z0, z1]): up to `MAX_DIFFRACTED` paths with `order` = number
//!   of reflections, gains = UTD x the pressure reflection factors x air x 1/r.
//! * Lit: only the single-reflection combos with an ISM counterpart matter: the ISM floor / ceiling path keeps
//!   its gain and gets a negative diffracted path of the combo whose reflection lies on the same side of the
//!   owner wall as the reflection of the ISM path (same keep rule as for the direct sound, relative to the
//!   ISM path). Combos with two reflections add nothing there.
//! * A surface whose reflection factor is ~0 in all bands (alpha = 1) takes no part: the output is then
//!   exactly the direct-sound result. Combos are limited to `max_order` reflections.
//!
//! Wall reflections and the stochastic tail are not diffracted.

use super::utd::band_rms;
use super::{cap_amps, dist_to_segment, fold_z, intersect, leg_3d, Bands, Path, Scene, AIR_DB_PER_M, EPS, FULL_TOL, NB};
use crate::geom::{cross, sub};
use std::collections::BTreeMap;
use std::f64::consts::PI;

/// Octave-band centre frequencies (Hz), matching `Bands`.
pub const BAND_HZ: [f64; NB] = [125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0];
/// Diffracted paths kept for a blocked direct path.
const MAX_DIFFRACTED: usize = 3;
/// Shadow: a diffracted path whose largest band amplitude |A| is below this (re the free field 1 / (r1 + r2),
/// about -80 dB) is dropped.
const SKIP_REL: f64 = 1e-4;
/// Lit zone: a negative diffracted path is kept when its largest band level re the geometric path is at least
/// this (-30 dB).
const LIT_REL_MIN: f64 = 0.03;
/// Shortest leg / smallest sin(skew angle) the UTD is evaluated for.
const MIN_LEG: f64 = 1e-6;
const MIN_SINB: f64 = 1e-9;
/// Slack (m) when testing whether the diffraction point lies within the edge segment.
const EDGE_END_TOL: f64 = 1e-6;
/// Largest disagreement (rad) between the UTD side (|phi_l - phi_s| against pi) and the geometric lit / shadow
/// classification that is corrected, and the margin (rad) the angle is moved to the classified side by.
const SIDE_TOL: f64 = 1e-5;
const SIDE_EPS: f64 = 1e-9;
/// Merge tolerance of end points / collinear edges (m).
const MERGE_TOL: f64 = 1e-6;
/// Angular tolerance of the wedge sector test (rad).
const ANG_TOL: f64 = 1e-6;
/// A floor / ceiling with a pressure reflection factor below this in every band takes no part in the
/// folded combinations.
const MIN_REFL: f64 = 1e-3;

/// A diffracting edge.
#[derive(Clone, Debug)]
pub struct Edge {
    pub a: [f64; 3],
    pub b: [f64; 3],
    vertical: bool,
    /// Walls the edge belongs to.
    owners: Vec<usize>,
    /// Vertical edges: sorted plan directions (rad, [0, 2 pi)) of the walls meeting at the edge.
    dirs: Vec<f64>,
}

fn angle(d: [f64; 2]) -> f64 {
    d[1].atan2(d[0]).rem_euclid(2.0 * PI)
}

/// All diffracting edges of a scene (vertical edges at wall ends, top / bottom edges of partial walls).
pub fn build_edges(scene: &Scene) -> Vec<Edge> {
    let h = scene.height;
    struct V {
        p: [f64; 2],
        z0: f64,
        z1: f64,
        owners: Vec<usize>,
        dirs: Vec<f64>,
    }
    let mut vert: BTreeMap<(i64, i64), V> = BTreeMap::new();
    // Horizontal candidates: (a, b, z, owners)
    let mut hor: Vec<([f64; 2], [f64; 2], f64, Vec<usize>)> = Vec::new();
    for (wi, w) in scene.walls.iter().enumerate() {
        let w = &w.clamped(h); // scenes built by hand may hold z1 = infinity
        let d = sub(w.p2, w.p1);
        if d[0].hypot(d[1]) < EPS || w.z1 - w.z0 < EPS {
            continue;
        }
        for (p, q) in [(w.p1, w.p2), (w.p2, w.p1)] {
            let key = ((p[0] / 1e-5).round() as i64, (p[1] / 1e-5).round() as i64);
            let v = vert.entry(key).or_insert(V { p, z0: w.z0, z1: w.z1, owners: Vec::new(), dirs: Vec::new() });
            v.z0 = v.z0.min(w.z0);
            v.z1 = v.z1.max(w.z1);
            v.owners.push(wi);
            v.dirs.push(angle(sub(q, p)));
        }
        if w.z1 < h - FULL_TOL {
            hor.push((w.p1, w.p2, w.z1, vec![wi]));
        }
        if w.z0 > FULL_TOL {
            hor.push((w.p1, w.p2, w.z0, vec![wi]));
        }
    }
    let mut edges = Vec::new();
    for (_, v) in vert {
        let mut dirs = v.dirs;
        // A wall passing through the point (T-junction) closes the wedge on its side as well.
        for (wi, w) in scene.walls.iter().enumerate() {
            let far = |q: [f64; 2]| (q[0] - v.p[0]).hypot(q[1] - v.p[1]) > 1e-5;
            if !v.owners.contains(&wi) && far(w.p1) && far(w.p2) && dist_to_segment(v.p, w.p1, w.p2) < 1e-5 {
                dirs.push(angle(sub(w.p1, v.p)));
                dirs.push(angle(sub(w.p2, v.p)));
            }
        }
        dirs.sort_by(f64::total_cmp);
        dirs.dedup_by(|b, a| (*b - *a).abs() < ANG_TOL);
        if dirs.len() > 1 && dirs[0] + 2.0 * PI - dirs[dirs.len() - 1] < ANG_TOL {
            dirs.pop();
        }
        edges.push(Edge { a: [v.p[0], v.p[1], v.z0], b: [v.p[0], v.p[1], v.z1], vertical: true, owners: v.owners, dirs });
    }
    // Merge collinear horizontal edges of the same height that touch or overlap (a row of wall pieces is one edge).
    let mut i = 0;
    while i < hor.len() {
        let mut merged = false;
        let mut j = i + 1;
        while j < hor.len() {
            if let Some((a, b)) = try_merge(&hor[i], &hor[j]) {
                let owners = std::mem::take(&mut hor[j].3);
                hor[i].0 = a;
                hor[i].1 = b;
                hor[i].3.extend(owners);
                hor.swap_remove(j);
                merged = true;
            } else {
                j += 1;
            }
        }
        if !merged {
            i += 1;
        }
    }
    for (a, b, z, owners) in hor {
        edges.push(Edge { a: [a[0], a[1], z], b: [b[0], b[1], z], vertical: false, owners, dirs: Vec::new() });
    }
    edges
}

type HEdge = ([f64; 2], [f64; 2], f64, Vec<usize>);

/// Union of two horizontal edges when they are collinear, at the same height and touching or overlapping.
fn try_merge(e: &HEdge, f: &HEdge) -> Option<([f64; 2], [f64; 2])> {
    if (e.2 - f.2).abs() > MERGE_TOL {
        return None;
    }
    let d = sub(e.1, e.0);
    let len = d[0].hypot(d[1]);
    let u = [d[0] / len, d[1] / len];
    let (va, vb) = (sub(f.0, e.0), sub(f.1, e.0));
    if cross(u, va).abs() > MERGE_TOL || cross(u, vb).abs() > MERGE_TOL {
        return None;
    }
    let (ta, tb) = (va[0] * u[0] + va[1] * u[1], vb[0] * u[0] + vb[1] * u[1]);
    let (lo, hi) = (ta.min(tb), ta.max(tb));
    if lo > len + MERGE_TOL || hi < -MERGE_TOL {
        return None;
    }
    let (t0, t1) = (lo.min(0.0), hi.max(len));
    Some(([e.0[0] + u[0] * t0, e.0[1] + u[1] * t0], [e.0[0] + u[0] * t1, e.0[1] + u[1] * t1]))
}

fn dist3(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// Unconstrained minimiser of |S-E| + |E-L| along the edge line: (parameter in metres from `e.a`, edge length, unit
/// direction). Closed form: it splits the axial gap in the ratio of the perpendicular distances.
fn edge_param(e: &Edge, s: [f64; 3], l: [f64; 3]) -> (f64, f64, [f64; 3]) {
    let d = [e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]];
    let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    if len < EPS {
        return (0.0, len, [0.0; 3]);
    }
    let u = [d[0] / len, d[1] / len, d[2] / len];
    let proj = |p: [f64; 3]| {
        let v = [p[0] - e.a[0], p[1] - e.a[1], p[2] - e.a[2]];
        let ax = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
        let q2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - ax * ax;
        (ax, q2.max(0.0).sqrt())
    };
    let ((sa, ds), (la, dl)) = (proj(s), proj(l));
    let t = if ds + dl > 1e-12 { (sa * dl + la * ds) / (ds + dl) } else { 0.5 * (sa + la) };
    (t, len, u)
}

/// Diffraction point of an edge for S and L (argmin |S-E| + |E-L| over the segment: the clamp to the segment stays
/// optimal because the sum is convex along it).
fn diffraction_point(e: &Edge, s: [f64; 3], l: [f64; 3]) -> [f64; 3] {
    let (t, len, u) = edge_param(e, s, l);
    if len < EPS {
        return e.a;
    }
    let t = t.clamp(0.0, len);
    [e.a[0] + u[0] * t, e.a[1] + u[1] * t, e.a[2] + u[2] * t]
}

/// The UTD (an infinite edge) applies only where the straight S-L line passes the edge line within the segment; if the
/// unconstrained diffraction point lies beyond an end (the line goes over / under / past the finite edge), the
/// edge does not take part (the clamped point would be a corner, not a wedge).
fn hits_segment(e: &Edge, s: [f64; 3], l: [f64; 3]) -> bool {
    let (t, len, _) = edge_param(e, s, l);
    t >= -EDGE_END_TOL && t <= len + EDGE_END_TOL
}

/// The wedge an edge forms for S and L: n = open (air) angle / pi and the angles of S and L from face 0
/// inside the air sector.
#[derive(Clone, Copy, Debug)]
struct Wedge {
    n: f64,
    phi_s: f64,
    phi_l: f64,
}

impl Wedge {
    /// The polarity of the diffracted path (+ in the shadow, - when lit) follows the geometric classification
    /// (line of sight blocked or not, with its own tolerances), the UTD jumps at |phi_l - phi_s| = pi. Within
    /// `SIDE_TOL` of that boundary on the wrong side the angle is moved to the classified side, so that the two
    /// agree (the amplitude then is the one-sided limit that matches the geometric path, no glitch for a
    /// listener exactly on the boundary line).
    fn on_side(mut self, shadow: bool) -> Wedge {
        let d = self.phi_l - self.phi_s;
        let off = d.abs() - PI; // > 0: shadow side
        let wrong = if shadow { off < SIDE_EPS && off > -SIDE_TOL } else { off > -SIDE_EPS && off < SIDE_TOL };
        if wrong {
            let target = if shadow { PI + SIDE_EPS } else { PI - SIDE_EPS };
            self.phi_l = self.phi_s + d.signum() * target;
        }
        self
    }
}

/// S and L are on opposite sides of an owner wall (the path really goes around the edge), and for vertical
/// edges both lie in the same free wedge wider than 180 degrees (no leaking through a corner or T-junction).
/// Returns the wedge (see the module docs); horizontal edges use the heights of `s` and `l` (pass the image
/// points for a folded combination).
fn wedge(scene: &Scene, e: &Edge, s: [f64; 3], l: [f64; 3]) -> Option<Wedge> {
    let (s2, l2) = ([s[0], s[1]], [l[0], l[1]]);
    let owner = e.owners.iter().copied().find(|&wi| {
        let w = &scene.walls[wi];
        let d = sub(w.p2, w.p1);
        let (cs, cl) = (cross(d, sub(s2, w.p1)), cross(d, sub(l2, w.p1)));
        cs * cl < 0.0 && cs.abs() > 1e-9 && cl.abs() > 1e-9
    })?;
    if !e.vertical {
        // Thin screen in the vertical plane perpendicular to the wall: u = signed distance from the wall line,
        // v = z - z_edge; face 0 points into the wall (down for a top edge, up for a bottom edge).
        let w = scene.walls[owner].clamped(scene.height);
        let d = sub(w.p2, w.p1);
        let len = d[0].hypot(d[1]);
        let top = (e.a[2] - w.z1).abs() <= (e.a[2] - w.z0).abs();
        let sgn = if top { 1.0 } else { -1.0 };
        let phi = |p: [f64; 3]| {
            let u = cross(d, sub([p[0], p[1]], w.p1)) / len;
            let v = p[2] - e.a[2];
            (sgn * u).atan2(-sgn * v).rem_euclid(2.0 * PI)
        };
        return Some(Wedge { n: 2.0, phi_s: phi(s), phi_l: phi(l) });
    }
    let p = [e.a[0], e.a[1]];
    let (ds, dl) = (sub(s2, p), sub(l2, p));
    if ds[0].hypot(ds[1]) < EPS || dl[0].hypot(dl[1]) < EPS {
        return None;
    }
    let n = e.dirs.len();
    let sector = |a: f64| -> Option<(usize, f64)> {
        (0..n).find_map(|i| {
            let width = if n == 1 { 2.0 * PI } else { (e.dirs[(i + 1) % n] - e.dirs[i]).rem_euclid(2.0 * PI) };
            let rel = (a - e.dirs[i]).rem_euclid(2.0 * PI);
            (rel > ANG_TOL && rel < width - ANG_TOL).then_some((i, width))
        })
    };
    let (a_s, a_l) = (angle(ds), angle(dl));
    match (sector(a_s), sector(a_l)) {
        (Some((i, width)), Some((j, _))) if i == j && width > PI + ANG_TOL => Some(Wedge {
            n: width / PI,
            phi_s: (a_s - e.dirs[i]).rem_euclid(2.0 * PI),
            phi_l: (a_l - e.dirs[i]).rem_euclid(2.0 * PI),
        }),
        _ => None,
    }
}

/// UTD of one edge for the (possibly image) end points `s`, `l`.
struct Diff {
    /// Index of the edge.
    edge: usize,
    /// Diffraction point.
    p: [f64; 3],
    r1: f64,
    r2: f64,
    /// Band amplitude |A| = sqrt(mean |A|^2) (A = p_d (r1 + r2) exp(+jk (r1 + r2))), per band.
    rms: Bands,
}

impl Diff {
    fn new(edge: usize, e: &Edge, w: Wedge, s: [f64; 3], l: [f64; 3]) -> Option<Diff> {
        if !hits_segment(e, s, l) {
            return None;
        }
        let p = diffraction_point(e, s, l);
        let (r1, r2) = (dist3(s, p), dist3(p, l));
        let d = [e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]];
        let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        if r1 < MIN_LEG || r2 < MIN_LEG || len < EPS {
            return None;
        }
        let c = ((s[0] - p[0]) * d[0] + (s[1] - p[1]) * d[1] + (s[2] - p[2]) * d[2]) / (r1 * len);
        let sinb = (1.0 - c * c).max(0.0).sqrt();
        if sinb < MIN_SINB {
            return None;
        }
        let rms = Bands::from_fn(|b| band_rms(b, w.phi_s, w.phi_l, w.n, r1, r2, sinb));
        Some(Diff { edge, p, r1, r2, rms })
    }
    fn r(&self) -> f64 {
        self.r1 + self.r2
    }
    /// Unsigned band amplitudes without air / reflection factors: |A| / max(r, 0.3).
    fn amp(&self) -> Bands {
        self.rms.map(|v| v / self.r().max(0.3))
    }
    /// Largest band level re a path of length `r_geo` (|A| r_geo / r).
    fn rel(&self, r_geo: f64) -> f64 {
        self.rms.peak() * r_geo / self.r()
    }
}

/// Allocator of coherence group ids (`Path::coh`, 0 = none) for one `add_diffraction` call: one group per geometric
/// path with its lit-zone diffracted paths, one per edge for the shadow paths.
struct Groups {
    next: u32,
    /// Shadow group of every edge (0 = not yet created).
    edge: Vec<u32>,
}

impl Groups {
    fn new(edges: usize) -> Groups {
        Groups { next: 0, edge: vec![0; edges] }
    }
    fn fresh(&mut self) -> u32 {
        self.next += 1;
        self.next
    }
    fn of_edge(&mut self, e: usize) -> u32 {
        if self.edge[e] == 0 {
            self.edge[e] = self.fresh();
        }
        self.edge[e]
    }
}

fn air(b: usize, r: f64) -> f64 {
    10f64.powf(-AIR_DB_PER_M[b] * r / 20.0)
}

/// Add the diffraction effects to the paths of `compute_paths_with_tree` (see the module docs).
pub fn add_diffraction(scene: &Scene, edges: &[Edge], src: [f64; 3], lis: [f64; 3], max_order: u32, out: &mut Vec<Path>) {
    if edges.is_empty() {
        return;
    }
    let direct = out.iter().position(|p| p.order == 0 && p.pts.len() == 2);
    let visible = direct.is_some_and(|i| out[i].crossed == 0);
    let direct_len = dist3(src, lis);
    let partial: Vec<bool> = scene.walls.iter().map(|w| !w.is_full(scene.height)).collect();
    let amps = super::wall_amps(scene);
    let camps = cap_amps(scene);
    let clear = |a: [f64; 3], b: [f64; 3]| {
        let (mut acc, mut n) = (Bands::ONE, 0u32);
        leg_3d(scene, &amps, &camps, &partial, a, b, None, &mut acc, &mut n) && n == 0
    };
    let (s2, l2) = ([src[0], src[1]], [lis[0], lis[1]]);
    let mut groups = Groups::new(edges.len());

    // UTD of every edge in the right geometry.
    let mut cs: Vec<Diff> = Vec::new();
    for (ei, e) in edges.iter().enumerate() {
        let Some(w) = wedge(scene, e, src, lis).map(|w| w.on_side(!visible)) else { continue };
        let Some(d) = Diff::new(ei, e, w, src, lis) else { continue };
        if visible {
            if d.rel(direct_len) >= LIT_REL_MIN {
                cs.push(d);
            }
        } else if d.rms.peak() >= SKIP_REL {
            cs.push(d);
        }
    }
    // Lit: strongest relative to the geometric path; blocked: largest mean amplitude.
    if visible {
        cs.sort_by(|a, b| b.rel(direct_len).total_cmp(&a.rel(direct_len)));
    } else {
        cs.sort_by(|a, b| b.amp().mean().total_cmp(&a.amp().mean()));
    }
    let sign = if visible { -1.0 } else { 1.0 };
    // Lit: the geometric path and all its negative diffracted paths form one group.
    let lit_group = groups.fresh();
    let mut kept = 0;
    for c in cs {
        if kept == MAX_DIFFRACTED {
            break;
        }
        if !clear(src, c.p) || !clear(c.p, lis) {
            continue;
        }
        let r = c.r();
        let amp = c.amp();
        let gains = Bands::from_fn(|b| sign * amp[b] * air(b, r));
        let rr = c.r2.max(1e-9);
        let dir = [(c.p[0] - lis[0]) / rr, (c.p[1] - lis[1]) / rr, (c.p[2] - lis[2]) / rr];
        let coh = if visible { lit_group } else { groups.of_edge(c.edge) };
        out.push(Path { order: 0, r, gains, dir, pts: vec![s2, [c.p[0], c.p[1]], l2], crossed: 0, coh });
        kept += 1;
    }
    if visible && kept > 0 {
        out[direct.unwrap()].coh = lit_group;
    }
    folded(scene, edges, src, lis, max_order, &clear, &mut groups, out);
}

/// A horizontal reflecting plane.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Plane {
    Floor,
    Ceil,
}

fn plane_z(p: Plane, h: f64) -> f64 {
    match p {
        Plane::Floor => 0.0,
        Plane::Ceil => h,
    }
}

/// Image of `p` in the plane (`None` = p itself).
fn image(p: [f64; 3], pl: Option<Plane>, h: f64) -> [f64; 3] {
    match pl {
        None => p,
        Some(pl) => [p[0], p[1], 2.0 * plane_z(pl, h) - p[2]],
    }
}

/// The unfolded line s*-l* passes through a wall owning the edge: it crosses the wall in plan and the
/// crossing height, folded back into [0, h], lies within [z0, z1].
fn blocked_by_owner(scene: &Scene, e: &Edge, s: [f64; 3], l: [f64; 3]) -> bool {
    let (s2, l2) = ([s[0], s[1]], [l[0], l[1]]);
    e.owners.iter().any(|&wi| {
        let w = &scene.walls[wi];
        let Some((t, u)) = intersect(s2, l2, w) else { return false };
        if !(t > 1e-6 && t < 1.0 - 1e-6 && u > -EPS && u < 1.0 + EPS) {
            return false;
        }
        let z = fold_z(s[2] + t * (l[2] - s[2]), scene.height);
        z >= w.z0 && z <= w.z1
    })
}

/// Parameter (along s -> l in plan) where the line crosses the line of the first owner wall with s and l
/// on opposite sides.
fn owner_line_crossing(scene: &Scene, e: &Edge, s: [f64; 3], l: [f64; 3]) -> Option<f64> {
    let (s2, l2) = ([s[0], s[1]], [l[0], l[1]]);
    e.owners.iter().find_map(|&wi| {
        let w = &scene.walls[wi];
        let d = sub(w.p2, w.p1);
        let (cs, cl) = (cross(d, sub(s2, w.p1)), cross(d, sub(l2, w.p1)));
        (cs * cl < 0.0).then(|| cs / (cs - cl))
    })
}

/// Real route S -> R1 -> E -> R2 -> L of a combination: the reflection points (on the planes, strictly
/// inside the unfolded legs) and clear legs.
fn route(
    h: f64,
    clear: &dyn Fn([f64; 3], [f64; 3]) -> bool,
    src: [f64; 3],
    lis: [f64; 3],
    e: [f64; 3],
    (i, j): (Option<Plane>, Option<Plane>),
) -> Option<(Option<[f64; 3]>, Option<[f64; 3]>)> {
    let (s_star, l_star) = (image(src, i, h), image(lis, j, h));
    let hit = |from: [f64; 3], pl: Plane| -> Option<[f64; 3]> {
        let pz = plane_z(pl, h);
        let dz = e[2] - from[2];
        if dz.abs() < 1e-12 {
            return None;
        }
        let t = (pz - from[2]) / dz;
        if !(t > 1e-9 && t < 1.0 - 1e-9) {
            return None;
        }
        Some([from[0] + t * (e[0] - from[0]), from[1] + t * (e[1] - from[1]), pz])
    };
    let r1 = match i {
        Some(pl) => Some(hit(s_star, pl)?),
        None => None,
    };
    let r2 = match j {
        Some(pl) => Some(hit(l_star, pl)?),
        None => None,
    };
    let ok = clear(src, r1.unwrap_or(e)) && (r1.is_none() || clear(r1.unwrap(), e)) && clear(e, r2.unwrap_or(lis)) && (r2.is_none() || clear(r2.unwrap(), lis));
    ok.then_some((r1, r2))
}

/// Diffraction of the paths with floor / ceiling reflections (see the module docs).
fn folded(scene: &Scene, edges: &[Edge], src: [f64; 3], lis: [f64; 3], max_order: u32, clear: &dyn Fn([f64; 3], [f64; 3]) -> bool, groups: &mut Groups, out: &mut Vec<Path>) {
    let h = scene.height;
    let floor_r = scene.mat(scene.floor_mat).without_tx().refl();
    let ceil_r = scene.mat(scene.ceil_mat).without_tx().refl();
    let mut planes: Vec<Plane> = Vec::new();
    if floor_r.peak() >= MIN_REFL {
        planes.push(Plane::Floor);
    }
    if ceil_r.peak() >= MIN_REFL {
        planes.push(Plane::Ceil);
    }
    if planes.is_empty() || max_order == 0 {
        return;
    }
    let refl_of = |pl: Plane| if pl == Plane::Floor { floor_r } else { ceil_r };
    let (s2, l2) = ([src[0], src[1]], [lis[0], lis[1]]);

    // Lit zone: the ISM floor / ceiling path (found before anything is added) keeps its gain and gets a negative
    // diffracted path of the combo on the same side of the owner wall as its reflection.
    for &pl in &planes {
        let len = dist3(image(src, Some(pl), h), lis);
        let Some(ism_path) = out.iter().position(|p| p.order == 1 && p.pts.len() == 2 && p.crossed == 0 && (p.r - len).abs() < 1e-6 && (p.dir[2] < 0.0) == (pl == Plane::Floor)) else {
            continue;
        };
        // Reflection point of the ISM path along S -> L in plan.
        let (ds, dl) = ((src[2] - plane_z(pl, h)).abs(), (lis[2] - plane_z(pl, h)).abs());
        if ds + dl < 1e-12 {
            continue;
        }
        let t_r = ds / (ds + dl);
        let mut best: Vec<(Diff, (Option<Plane>, Option<Plane>))> = Vec::new();
        for (ei, e) in edges.iter().enumerate() {
            let Some(t_w) = owner_line_crossing(scene, e, src, lis) else { continue };
            let combo = if t_r < t_w { (Some(pl), None) } else { (None, Some(pl)) };
            let (s_c, l_c) = (image(src, combo.0, h), image(lis, combo.1, h));
            if blocked_by_owner(scene, e, s_c, l_c) {
                continue;
            }
            let Some(w) = wedge(scene, e, s_c, l_c).map(|w| w.on_side(false)) else { continue };
            let Some(d) = Diff::new(ei, e, w, s_c, l_c) else { continue };
            if d.rel(len) >= LIT_REL_MIN {
                best.push((d, combo));
            }
        }
        best.sort_by(|a, b| b.0.rel(len).total_cmp(&a.0.rel(len)));
        let group = groups.fresh();
        let mut kept = 0;
        for (d, combo) in best {
            if kept == MAX_DIFFRACTED {
                break;
            }
            let Some((_, r2)) = route(h, clear, src, lis, d.p, combo) else { continue };
            let (r, amp) = (d.r(), d.amp());
            let refl = refl_of(pl);
            let gains = Bands::from_fn(|b| -amp[b] * refl[b] * air(b, r));
            let last = r2.unwrap_or(d.p);
            let rr = dist3(last, lis).max(1e-9);
            let dir = [(last[0] - lis[0]) / rr, (last[1] - lis[1]) / rr, (last[2] - lis[2]) / rr];
            out.push(Path { order: 1, r, gains, dir, pts: vec![s2, [d.p[0], d.p[1]], l2], crossed: 0, coh: group });
            kept += 1;
        }
        if kept > 0 {
            out[ism_path].coh = group;
        }
    }

    // Blocked combinations: extra paths.
    let opts: Vec<Option<Plane>> = std::iter::once(None).chain(planes.iter().map(|&p| Some(p))).collect();
    for &i in &opts {
        for &j in &opts {
            if i.is_none() && j.is_none() {
                continue;
            }
            let order = i.is_some() as u32 + j.is_some() as u32;
            if order > max_order {
                continue;
            }
            let (s_star, l_star) = (image(src, i, h), image(lis, j, h));
            let mut refl = Bands::ONE;
            for pl in [i, j].into_iter().flatten() {
                refl *= refl_of(pl);
            }
            let mut cs: Vec<Diff> = Vec::new();
            for (ei, e) in edges.iter().enumerate() {
                if !blocked_by_owner(scene, e, s_star, l_star) {
                    continue;
                }
                let Some(w) = wedge(scene, e, s_star, l_star).map(|w| w.on_side(true)) else { continue };
                let Some(d) = Diff::new(ei, e, w, s_star, l_star) else { continue };
                if d.rms.peak() >= SKIP_REL {
                    cs.push(d);
                }
            }
            cs.sort_by(|a, b| b.amp().mean().total_cmp(&a.amp().mean()));
            let mut kept = 0;
            for c in cs {
                if kept == MAX_DIFFRACTED {
                    break;
                }
                let Some((_, r2)) = route(h, clear, src, lis, c.p, (i, j)) else { continue };
                let (r, amp) = (c.r(), c.amp());
                let gains = Bands::from_fn(|b| amp[b] * refl[b] * air(b, r));
                let last = r2.unwrap_or(c.p);
                let rr = dist3(last, lis).max(1e-9);
                let dir = [(last[0] - lis[0]) / rr, (last[1] - lis[1]) / rr, (last[2] - lis[2]) / rr];
                let coh = groups.of_edge(c.edge);
                out.push(Path { order, r, gains, dir, pts: vec![s2, [c.p[0], c.p[1]], l2], crossed: 0, coh });
                kept += 1;
            }
        }
    }
}
