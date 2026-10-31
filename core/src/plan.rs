//! Planar analysis of the wall plan: which parts of the plan are rooms, which are obstacles.
//!
//! Walls are first made into a planar graph: endpoints closer than `SNAP_TOL` are merged, and every
//! wall is split at the vertices lying on it (T-junctions, also mid-segment) and at crossings with
//! other walls. The faces of that graph come from half-edge traversal (each face on the left of its
//! half-edges: bounded faces run counter-clockwise, the outer boundary of a connected component
//! clockwise). Then:
//!   * a bounded face is a ROOM when it is not enclosed by another connected group of walls, an
//!     OBSTACLE (pillar) when it is enclosed by one level, a room again by two levels, and so on:
//!     a closed loop of walls that does not touch the walls around it is a pillar, join it to them
//!     to make it a room. The rule never depends on where sources or the listener are;
//!   * the floor area is the sum of the net areas of the room faces (the area of a face minus the
//!     outline of the groups of walls standing inside it);
//!   * every wall piece knows how many of its two sides face a room (a partition between two rooms
//!     counts 2, an outer wall 1, a baffle inside a room 2, anything outside 0). That is the surface
//!     that absorbs sound in the Sabine/Eyring estimates.
//! The same algorithm is implemented in TypeScript (`src/editor/rooms.ts`) for the editor; both are
//! tested against `core/testdata/plans.txt`.

use crate::ism::Wall;
use std::collections::BTreeMap;

/// Endpoints and vertices closer than this (m) are one vertex; a vertex this close to a wall splits it.
pub const SNAP_TOL: f64 = 1e-3;
/// Faces smaller than this (m^2) are slivers between nearly coincident walls and are ignored.
pub const MIN_FACE_AREA: f64 = 1e-4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Region {
    Outside,
    Room,
    Obstacle,
}

#[derive(Clone, Debug)]
pub struct Face {
    /// Outline, counter-clockwise (the same vertex may repeat where a baffle sticks into the face).
    pub ring: Vec<[f64; 2]>,
    /// Net area: outline minus the groups of walls standing inside.
    pub area: f64,
    pub region: Region,
    /// Nesting level of the connected group of walls this face belongs to (0 = outermost).
    pub depth: u32,
}

#[derive(Clone, Debug, Default)]
pub struct Plan {
    /// Bounded faces, rooms and obstacles.
    pub faces: Vec<Face>,
    /// Per input wall: `(length, number of room sides)` of every piece between split points.
    pub pieces: Vec<Vec<(f64, u8)>>,
}

impl Plan {
    pub fn rooms(&self) -> impl Iterator<Item = &Face> {
        self.faces.iter().filter(|f| f.region == Region::Room)
    }
    pub fn floor_area(&self) -> f64 {
        self.rooms().map(|f| f.area).sum()
    }
    /// Innermost face containing `p`: room, obstacle or outside.
    pub fn locate(&self, p: [f64; 2]) -> Region {
        let mut best: Option<&Face> = None;
        for f in &self.faces {
            if point_in_ring(p, &f.ring) && best.map_or(true, |b| ring_area(&f.ring) < ring_area(&b.ring)) {
                best = Some(f);
            }
        }
        best.map_or(Region::Outside, |f| f.region)
    }
}

pub fn point_in_ring(pt: [f64; 2], ring: &[[f64; 2]]) -> bool {
    let mut c = false;
    let mut j = ring.len().wrapping_sub(1);
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > pt[1]) != (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0] {
            c = !c;
        }
        j = i;
    }
    c
}

fn signed_area2(ring: &[[f64; 2]]) -> f64 {
    let mut a2 = 0.0;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        a2 += a[0] * b[1] - b[0] * a[1];
    }
    a2
}

fn ring_area(ring: &[[f64; 2]]) -> f64 {
    signed_area2(ring).abs() / 2.0
}

/// Vertex table that merges points closer than `SNAP_TOL`.
#[derive(Default)]
struct Verts {
    p: Vec<[f64; 2]>,
    cells: BTreeMap<(i64, i64), Vec<usize>>,
}

impl Verts {
    fn cell(p: [f64; 2]) -> (i64, i64) {
        ((p[0] / SNAP_TOL).floor() as i64, (p[1] / SNAP_TOL).floor() as i64)
    }
    fn id(&mut self, p: [f64; 2]) -> usize {
        let (cx, cy) = Self::cell(p);
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(l) = self.cells.get(&(cx + dx, cy + dy)) {
                    for &i in l {
                        if (self.p[i][0] - p[0]).hypot(self.p[i][1] - p[1]) <= SNAP_TOL {
                            return i;
                        }
                    }
                }
            }
        }
        self.p.push(p);
        self.cells.entry((cx, cy)).or_default().push(self.p.len() - 1);
        self.p.len() - 1
    }
}

fn cross(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

/// Position (t along a->b, 0..1) of `p` if it lies within `SNAP_TOL` of the segment's interior.
fn on_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> Option<f64> {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    if t <= 0.0 || t >= 1.0 {
        return None;
    }
    let d = (p[0] - (a[0] + t * dx)).hypot(p[1] - (a[1] + t * dy));
    (d <= SNAP_TOL).then_some(t)
}

fn find(parent: &mut [usize], i: usize) -> usize {
    let mut r = i;
    while parent[r] != r {
        r = parent[r];
    }
    let mut c = i;
    while parent[c] != r {
        let n = parent[c];
        parent[c] = r;
        c = n;
    }
    r
}

pub fn analyze(walls: &[Wall]) -> Plan {
    // 1. Vertices: merged endpoints.
    let mut vs = Verts::default();
    let ends: Vec<Option<(usize, usize)>> = walls
        .iter()
        .map(|w| {
            let (a, b) = (vs.id(w.p1), vs.id(w.p2));
            (a != b).then_some((a, b))
        })
        .collect();
    // 2. Vertices at proper crossings (both parameters strictly inside the walls).
    for i in 0..walls.len() {
        let Some((a1, b1)) = ends[i] else { continue };
        let (p, r) = (vs.p[a1], [vs.p[b1][0] - vs.p[a1][0], vs.p[b1][1] - vs.p[a1][1]]);
        let lr = r[0].hypot(r[1]);
        for j in i + 1..walls.len() {
            let Some((a2, b2)) = ends[j] else { continue };
            let (q, s) = (vs.p[a2], [vs.p[b2][0] - vs.p[a2][0], vs.p[b2][1] - vs.p[a2][1]]);
            let ls = s[0].hypot(s[1]);
            let den = cross(r, s);
            if den.abs() < 1e-12 * lr * ls {
                continue;
            }
            let qp = [q[0] - p[0], q[1] - p[1]];
            let (t, u) = (cross(qp, s) / den, cross(qp, r) / den);
            if t * lr > SNAP_TOL && (1.0 - t) * lr > SNAP_TOL && u * ls > SNAP_TOL && (1.0 - u) * ls > SNAP_TOL {
                vs.id([p[0] + t * r[0], p[1] + t * r[1]]);
            }
        }
    }
    // 3. Split every wall at the vertices lying on it; collect the undirected edges.
    let mut edge_ids: BTreeMap<(usize, usize), usize> = BTreeMap::new();
    let mut edges: Vec<(usize, usize)> = Vec::new();
    let mut wall_edges: Vec<Vec<usize>> = vec![Vec::new(); walls.len()];
    for (i, e) in ends.iter().enumerate() {
        let Some((a, b)) = *e else { continue };
        let (pa, pb) = (vs.p[a], vs.p[b]);
        let mut chain: Vec<(f64, usize)> = (0..vs.p.len()).filter(|&v| v != a && v != b).filter_map(|v| on_segment(vs.p[v], pa, pb).map(|t| (t, v))).collect();
        chain.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut prev = a;
        for v in chain.iter().map(|c| c.1).chain(std::iter::once(b)) {
            if v == prev {
                continue;
            }
            let key = (prev.min(v), prev.max(v));
            let id = *edge_ids.entry(key).or_insert_with(|| {
                edges.push(key);
                edges.len() - 1
            });
            wall_edges[i].push(id);
            prev = v;
        }
    }
    // 4. Half-edges 2k (u -> v) and 2k+1 (v -> u), outgoing lists sorted counter-clockwise.
    let nv = vs.p.len();
    let mut out: Vec<Vec<usize>> = vec![Vec::new(); nv];
    for (k, &(u, v)) in edges.iter().enumerate() {
        out[u].push(2 * k);
        out[v].push(2 * k + 1);
    }
    let origin = |h: usize| if h % 2 == 0 { edges[h / 2].0 } else { edges[h / 2].1 };
    let target = |h: usize| origin(h ^ 1);
    let angle = |h: usize| {
        let (a, b) = (vs.p[origin(h)], vs.p[target(h)]);
        (b[1] - a[1]).atan2(b[0] - a[0])
    };
    for l in out.iter_mut() {
        l.sort_by(|&x, &y| angle(x).partial_cmp(&angle(y)).unwrap_or(std::cmp::Ordering::Equal));
    }
    let next = |h: usize| {
        let l = &out[target(h)];
        let k = l.iter().position(|&x| x == (h ^ 1)).unwrap();
        l[(k + l.len() - 1) % l.len()]
    };
    // 5. Cycles (faces on the left of their half-edges).
    let nh = 2 * edges.len();
    let mut cycle_of = vec![usize::MAX; nh];
    let mut cycles: Vec<Vec<usize>> = Vec::new();
    for h0 in 0..nh {
        if cycle_of[h0] != usize::MAX {
            continue;
        }
        let mut c = Vec::new();
        let mut h = h0;
        while cycle_of[h] == usize::MAX {
            cycle_of[h] = cycles.len();
            c.push(h);
            h = next(h);
        }
        cycles.push(c);
    }
    let rings: Vec<Vec<[f64; 2]>> = cycles.iter().map(|c| c.iter().map(|&h| vs.p[origin(h)]).collect()).collect();
    let area2: Vec<f64> = rings.iter().map(|r| signed_area2(r)).collect();
    // 6. Connected groups of walls.
    let mut parent: Vec<usize> = (0..nv).collect();
    for &(u, v) in &edges {
        let (ru, rv) = (find(&mut parent, u), find(&mut parent, v));
        parent[ru] = rv;
    }
    let comp_of_cycle: Vec<usize> = cycles.iter().map(|c| find(&mut parent, origin(c[0]))).collect();
    let is_face = |c: usize| area2[c] / 2.0 > MIN_FACE_AREA;
    // Outline area of every group (its clockwise cycle) and its enclosing face, if any.
    let mut outline = vec![0.0f64; nv];
    for c in 0..cycles.len() {
        if area2[c] / 2.0 < -MIN_FACE_AREA {
            outline[comp_of_cycle[c]] += -area2[c] / 2.0;
        }
    }
    let comps: Vec<usize> = {
        let mut v: Vec<usize> = (0..edges.len()).map(|k| find(&mut parent, edges[k].0)).collect();
        v.sort_unstable();
        v.dedup();
        v
    };
    // Probe vertex of a group: its lowest-then-leftmost vertex.
    let mut probe: BTreeMap<usize, [f64; 2]> = BTreeMap::new();
    for v in 0..nv {
        let r = find(&mut parent, v);
        if out[v].is_empty() {
            continue;
        }
        let e = probe.entry(r).or_insert(vs.p[v]);
        if (vs.p[v][1], vs.p[v][0]) < (e[1], e[0]) {
            *e = vs.p[v];
        }
    }
    let mut enclosing: BTreeMap<usize, usize> = BTreeMap::new(); // group -> face cycle
    for &g in &comps {
        let pt = probe[&g];
        let mut best: Option<usize> = None;
        for c in 0..cycles.len() {
            if comp_of_cycle[c] == g || !is_face(c) || !point_in_ring(pt, &rings[c]) {
                continue;
            }
            if best.map_or(true, |b| area2[c] < area2[b]) {
                best = Some(c);
            }
        }
        if let Some(b) = best {
            enclosing.insert(g, b);
        }
    }
    let depth_of = |g: usize| {
        let (mut d, mut cur) = (0u32, g);
        while let Some(&f) = enclosing.get(&cur) {
            d += 1;
            cur = comp_of_cycle[f];
        }
        d
    };
    let region_of_depth = |d: u32| if d % 2 == 0 { Region::Room } else { Region::Obstacle };
    // 7. Faces with their net areas.
    let mut faces = Vec::new();
    let mut face_region = vec![Region::Outside; cycles.len()]; // per cycle: region on its left
    for c in 0..cycles.len() {
        let g = comp_of_cycle[c];
        if is_face(c) {
            let d = depth_of(g);
            let inner: f64 = enclosing.iter().filter(|(_, &f)| f == c).map(|(&g2, _)| outline[g2]).sum();
            face_region[c] = region_of_depth(d);
            faces.push(Face { ring: rings[c].clone(), area: area2[c] / 2.0 - inner, region: region_of_depth(d), depth: d });
        } else {
            // Outline of a group (or a sliver): it borders whatever region encloses the group.
            face_region[c] = enclosing.get(&g).map_or(Region::Outside, |&f| region_of_depth(depth_of(comp_of_cycle[f])));
        }
    }
    // 8. Pieces: room sides of every wall piece.
    let sides_of = |e: usize| -> u8 { (face_region[cycle_of[2 * e]] == Region::Room) as u8 + (face_region[cycle_of[2 * e + 1]] == Region::Room) as u8 };
    let pieces = wall_edges
        .iter()
        .map(|es| {
            es.iter()
                .map(|&e| {
                    let (a, b) = (vs.p[edges[e].0], vs.p[edges[e].1]);
                    ((b[0] - a[0]).hypot(b[1] - a[1]), sides_of(e))
                })
                .collect()
        })
        .collect();
    Plan { faces, pieces }
}

/// Floats before the ring of a packed face: region (0 room, 1 obstacle), depth, net area, nPts.
pub const FACE_HEADER: usize = 4;

/// Pack the faces for the UI (read through `out_ptr(OUT_PLAN)`): `[nFaces, then per face
/// region, depth, area, nPts, x0, y0, ...]` as f32. The UI only classifies points against the rings.
pub fn pack_faces(plan: &Plan) -> Vec<f32> {
    let mut out = vec![plan.faces.len() as f32];
    for f in &plan.faces {
        out.extend([if f.region == Region::Room { 0.0 } else { 1.0 }, f.depth as f32, f.area as f32, f.ring.len() as f32]);
        out.extend(f.ring.iter().flat_map(|p| [p[0] as f32, p[1] as f32]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture cases shared with the TypeScript tests (`src/editor/plan.test.ts`).
    #[test]
    fn shared_fixture_cases() {
        let text = include_str!("../testdata/plans.txt");
        let mut n = 0;
        let mut walls: Vec<Wall> = Vec::new();
        let (mut name, mut rooms, mut obst, mut area, mut sides) = (String::new(), 0usize, 0usize, 0.0, None::<f64>);
        let mut probes: Vec<([f64; 2], Region)> = Vec::new();
        for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
            let t: Vec<&str> = line.split_whitespace().collect();
            let num = |i: usize| t[i].parse::<f64>().unwrap();
            match t[0] {
                "case" => {
                    name = t[1].to_string();
                    walls.clear();
                    probes.clear();
                    sides = None;
                }
                "wall" => walls.push(Wall::full([num(1), num(2)], [num(3), num(4)], 0)),
                "rooms" => {
                    rooms = num(1) as usize;
                    obst = num(2) as usize;
                }
                "area" => area = num(1),
                "sides" => sides = Some(num(1)),
                "probe" => probes.push(([num(1), num(2)], match t[3] {
                    "room" => Region::Room,
                    "obstacle" => Region::Obstacle,
                    _ => Region::Outside,
                })),
                "end" => {
                    let plan = analyze(&walls);
                    assert_eq!(plan.rooms().count(), rooms, "{name}: room faces");
                    assert_eq!(plan.faces.len() - plan.rooms().count(), obst, "{name}: obstacle faces");
                    assert!((plan.floor_area() - area).abs() < 1e-6, "{name}: area {} vs {area}", plan.floor_area());
                    if let Some(s) = sides {
                        let got: f64 = plan.pieces.iter().flatten().map(|&(l, k)| l * k as f64).sum();
                        assert!((got - s).abs() < 1e-6, "{name}: sides {got} vs {s}");
                    }
                    for (p, r) in &probes {
                        assert_eq!(plan.locate(*p), *r, "{name}: probe {p:?}");
                    }
                    n += 1;
                }
                other => panic!("unknown fixture keyword {other}"),
            }
        }
        assert!(n >= 15, "fixture cases: {n}");
    }

    #[test]
    fn packed_faces_round_trip_the_rings() {
        let w = |a: [f64; 2], b: [f64; 2]| Wall::full(a, b, 0);
        let plan = analyze(&[w([0., 0.], [4., 0.]), w([4., 0.], [4., 3.]), w([4., 3.], [0., 3.]), w([0., 3.], [0., 0.])]);
        let p = pack_faces(&plan);
        assert_eq!(p[0], 1.0);
        let n = p[1 + 3] as usize;
        assert_eq!(p.len(), 1 + FACE_HEADER + 2 * n);
        assert_eq!((p[1], p[2], p[3]), (0.0, 0.0, 12.0));
    }
}
