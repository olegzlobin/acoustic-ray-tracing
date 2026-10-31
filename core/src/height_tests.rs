//! Walls with a vertical extent [z0, z1] and the horizontal cap faces of closed groups of such walls:
//! full-height scenes are unchanged, partial walls block/reflect only at their height, caps reflect and
//! attenuate, rays respect both.

use crate::ism::{self, build_caps, Bands, Material, Scene, Wall, SPEED_OF_SOUND};
use crate::tx_tests::{f32_digest, hist_digest, paths_digest};
use crate::{dsp, heat, rays};

const H: f64 = 3.0;

fn opaque() -> Material {
    Material::new(Bands::splat(0.1), 0.0)
}

/// Transmits 10 % of the energy (TL 10 dB).
fn leaky() -> Material {
    Material { alpha: Bands::splat(0.5), scatter: Bands::splat(0.0), tau: Bands::splat(0.1) }
}

/// Closed rectangle (counter-clockwise) with the vertical extent [z0, z1].
fn rect(x0: f64, y0: f64, x1: f64, y1: f64, mat: usize, z0: f64, z1: f64) -> Vec<Wall> {
    let c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    (0..4).map(|i| Wall::partial(c[i], c[(i + 1) % 4], mat, z0, z1)).collect()
}

/// 10 x 7 x 3 room (material 0 opaque, material 1 leaky) plus extra walls.
fn room(extra: Vec<Wall>) -> Scene {
    let mut walls = rect(0.0, 0.0, 10.0, 7.0, 0, 0.0, f64::INFINITY);
    walls.extend(extra);
    Scene::new(walls, vec![opaque(), leaky()], H, 0, 0)
}

fn direct(paths: &[ism::Path]) -> Option<&ism::Path> {
    paths.iter().find(|p| p.order == 0)
}

// ---------------------------------------------------------------- full height = unchanged

fn digests(sc: &Scene, src: [f64; 3], lis: [f64; 3]) -> [u64; 5] {
    let paths = ism::compute_paths(sc, src, lis, 3);
    let ir = dsp::synth_ir(&paths, 48000.0, 24000);
    let p = rays::RayParams { n_rays: 4000, t_max: 0.8, ..Default::default() };
    let (h, _) = rays::trace(sc, src, lis, &p);
    let bb = rays::Geo::new(sc, 12).bbox;
    let (x0, y0, cell, nx, ny) = heat::grid_for(bb, 0.5, 4000);
    let hp = heat::HeatParams { x0, y0, cell, nx, ny, ear_z: 1.2, n_rays: 4000, t_max: 0.8, seed: 5, dir: Default::default() };
    let mut ht = heat::HeatTracer::new(sc, src, &hp);
    ht.step(4000);
    [paths_digest(&paths), f32_digest(&ir), hist_digest(&h), h.steps, f32_digest(&ht.snapshot())]
}

#[test]
fn explicit_full_height_walls_equal_the_default_ones() {
    let materials = vec![opaque(), leaky()];
    let build = |lo: f64, hi: f64| {
        let mut w: Vec<Wall> = rect(0.0, 0.0, 10.0, 7.0, 0, lo, hi);
        w.extend(rect(4.0, 3.0, 6.0, 5.0, 1, lo, hi)); // pillar with a leaky skin
        w.push(Wall::partial([8.0, 1.0], [8.0, 3.0], 0, lo, hi)); // baffle
        w
    };
    // Reference: the plain constructor (z1 = infinity, never clamped), no caps.
    let plain = Scene { walls: build(0.0, f64::INFINITY), materials: materials.clone(), height: H, floor_mat: 0, ceil_mat: 0, caps: vec![] };
    let (src, lis) = ([2.5, 3.5, 1.5], [7.0, 3.5, 1.2]);
    let want = digests(&plain, src, lis);
    for (lo, hi) in [(0.0, H), (0.0, 1e9), (-2.0, H + 5.0), (1e-7, H - 1e-7)] {
        let sc = Scene::new(build(lo, hi), materials.clone(), H, 0, 0);
        assert!(sc.caps.is_empty() && !sc.has_partial(), "[{lo}, {hi}] is full height");
        assert_eq!(digests(&sc, src, lis), want, "[{lo}, {hi}] differs from the default walls");
    }
}

// ---------------------------------------------------------------- caps

#[test]
fn caps_of_obstacles() {
    let n = |w: Vec<Wall>| build_caps(&w, H);
    // Sofa: closed box on the floor -> one top cap.
    let sofa = n(rect(1.0, 1.0, 3.0, 2.0, 0, 0.0, 0.85));
    assert_eq!(sofa.len(), 0, "a lone closed loop is a room, not an obstacle");
    let mut with_room = rect(0.0, 0.0, 10.0, 7.0, 0, 0.0, f64::INFINITY);
    with_room.extend(rect(1.0, 1.0, 3.0, 2.0, 1, 0.0, 0.85));
    let caps = n(with_room.clone());
    assert_eq!(caps.len(), 1);
    assert!(caps[0].up && (caps[0].z - 0.85).abs() < 1e-12 && caps[0].mat == 1);
    assert!(caps[0].contains([2.0, 1.5]) && !caps[0].contains([4.0, 1.5]));
    // Table slab: top and bottom.
    let mut t = rect(0.0, 0.0, 10.0, 7.0, 0, 0.0, f64::INFINITY);
    t.extend(rect(4.0, 3.0, 6.0, 4.0, 0, 0.72, 0.75));
    let caps = n(t);
    assert_eq!(caps.len(), 2);
    let (top, bottom) = (caps.iter().find(|c| c.up).unwrap(), caps.iter().find(|c| !c.up).unwrap());
    assert!((top.z - 0.75).abs() < 1e-12 && (bottom.z - 0.72).abs() < 1e-12);
    // Ceiling cloud: bottom cap above the floor, top cap below the ceiling.
    let mut c = rect(0.0, 0.0, 10.0, 7.0, 0, 0.0, f64::INFINITY);
    c.extend(rect(2.0, 2.0, 8.0, 5.0, 0, 2.6, 2.7));
    assert_eq!(n(c).len(), 2);
    // Full-height pillar and open baffles: nothing.
    let mut p = rect(0.0, 0.0, 10.0, 7.0, 0, 0.0, f64::INFINITY);
    p.extend(rect(4.0, 3.0, 6.0, 5.0, 0, 0.0, H));
    p.push(Wall::partial([8.0, 1.0], [8.0, 3.0], 0, 0.0, 1.0));
    assert!(n(p).is_empty());
    // Mixed heights: the lowest top and the highest bottom win.
    let mut m = rect(0.0, 0.0, 10.0, 7.0, 0, 0.0, f64::INFINITY);
    m.extend(rect(4.0, 3.0, 6.0, 5.0, 0, 0.0, 0.8));
    m[4 + 2].z1 = 0.6;
    let caps = n(m);
    assert_eq!(caps.len(), 1);
    assert!((caps[0].z - 0.6).abs() < 1e-12);
    // Scene::new clamps and derives the caps.
    let sc = Scene::new(with_room, vec![opaque(), leaky()], H, 0, 0);
    assert_eq!(sc.caps.len(), 1);
    assert_eq!(sc.surface_materials().len(), 4 + 4 + 2 + 1);
}

// ---------------------------------------------------------------- ISM: partial walls

#[test]
fn partial_partition_blocks_the_direct_path_only_at_its_height() {
    let part = |z0: f64, z1: f64, mat: usize| room(vec![Wall::partial([5.0, 0.0], [5.0, 7.0], mat, z0, z1)]);
    let open = room(vec![]);
    let (src, lis) = ([2.0, 3.5, 1.5], [8.0, 3.5, 1.5]);
    let reference = ism::compute_paths(&open, src, lis, 0);
    let d0 = direct(&reference).unwrap().gains;
    let d = |sc: &Scene, s: [f64; 3], l: [f64; 3]| ism::compute_paths(sc, s, l, 0);
    // Full-height partition (reference): the direct path is blocked.
    assert!(direct(&d(&part(0.0, H, 0), src, lis)).is_none());
    // Below the line / above the line: passes, exactly as in the open room.
    for (z0, z1) in [(0.0, 1.0), (2.0, 3.0)] {
        let p = d(&part(z0, z1, 0), src, lis);
        let p = direct(&p).unwrap_or_else(|| panic!("wall [{z0}, {z1}] must not block"));
        assert_eq!(p.gains, d0);
        assert_eq!(p.crossed, 0);
    }
    // At the height of the line: blocked (opaque) or attenuated (leaky).
    assert!(direct(&d(&part(1.0, 2.0, 0), src, lis)).is_none());
    let p = d(&part(1.0, 2.0, 1), src, lis);
    let p = direct(&p).unwrap();
    assert_eq!(p.crossed, 1);
    for b in 0..6 {
        assert!((p.gains[b] / d0[b] - 0.1f64.sqrt()).abs() < 1e-12);
    }
    // A descending line crosses x = 5 at z = 1.5 as well.
    let (s2, l2) = ([2.0, 3.5, 2.5], [8.0, 3.5, 0.5]);
    assert!(direct(&d(&part(1.0, 2.0, 0), s2, l2)).is_none());
    assert!(direct(&d(&part(0.0, 1.0, 0), s2, l2)).is_some());
    assert!(direct(&d(&part(2.0, 3.0, 0), s2, l2)).is_some());
}

#[test]
fn wall_reflection_is_dropped_above_the_wall() {
    // Free-standing wall x = 5, y 2..5; source and listener on its left face at different heights: the
    // unfolded line reaches the wall half way, at z = 1.5.
    let (src, lis) = ([2.0, 3.5, 1.0], [2.0, 4.5, 2.0]);
    let want = 38f64.sqrt();
    let n = |z0: f64, z1: f64| {
        let sc = room(vec![Wall::partial([5.0, 2.0], [5.0, 5.0], 0, z0, z1)]);
        ism::compute_paths(&sc, src, lis, 1).iter().filter(|p| p.order == 1 && (p.r - want).abs() < 1e-9).count()
    };
    assert_eq!(n(0.0, H), 1, "full-height reference");
    assert_eq!(n(0.0, 1.6), 1);
    assert_eq!(n(1.4, 1.6), 1);
    assert_eq!(n(0.0, 1.4), 0);
    assert_eq!(n(1.6, H), 0);
}

// ---------------------------------------------------------------- ISM: slabs and caps

fn table(z0: f64, z1: f64, mat: usize) -> Scene {
    room(rect(4.0, 3.0, 6.0, 4.0, mat, z0, z1))
}

#[test]
fn slab_at_ear_height_blocks_and_a_low_one_lets_the_direct_path_pass() {
    let (src, lis) = ([2.0, 3.5, 1.5], [8.0, 3.5, 1.5]);
    let d0 = direct(&ism::compute_paths(&room(vec![]), src, lis, 0)).unwrap().gains;
    let run = |sc: &Scene, s, l| ism::compute_paths(sc, s, l, 0);
    // Slab at ear height: the two edge walls are crossed.
    assert!(direct(&run(&table(1.45, 1.55, 0), src, lis)).is_none());
    let p = run(&table(1.45, 1.55, 1), src, lis);
    let p = direct(&p).unwrap();
    assert_eq!(p.crossed, 2);
    for b in 0..6 {
        assert!((p.gains[b] / d0[b] - 0.1).abs() < 1e-12, "two crossings of tau = 0.1");
    }
    // Same slab at table height: the horizontal line passes above it.
    let low = run(&table(0.72, 0.75, 0), src, lis);
    let p = direct(&low).unwrap();
    assert_eq!(p.crossed, 0);
    assert_eq!(p.gains, d0);
    // A line coming down through the slab crosses its top and bottom faces (caps), not the edges.
    let (s2, l2) = ([2.0, 3.5, 1.6], [8.0, 3.5, 0.1]);
    let d1 = direct(&run(&room(vec![]), s2, l2)).unwrap().gains;
    assert!(direct(&run(&table(0.72, 0.75, 0), s2, l2)).is_none());
    let p = run(&table(0.72, 0.75, 1), s2, l2);
    let p = direct(&p).unwrap();
    assert_eq!(p.crossed, 2);
    for b in 0..6 {
        assert!((p.gains[b] / d1[b] - 0.1).abs() < 1e-12);
    }
}

/// Order-1 path whose plan polyline bends at `p`.
fn bend_at<'a>(paths: &'a [ism::Path], p: [f64; 2]) -> Option<&'a ism::Path> {
    paths.iter().find(|q| q.order == 1 && q.pts.len() == 3 && (q.pts[1][0] - p[0]).hypot(q.pts[1][1] - p[1]) < 1e-9)
}

#[test]
fn top_cap_reflection_has_the_geometric_delay() {
    // Table top at 0.75 under the source and the listener.
    let sc = table(0.72, 0.75, 0);
    let (src, lis) = ([4.5, 3.2, 1.5], [5.5, 3.7, 1.2]);
    let paths = ism::compute_paths(&sc, src, lis, 1);
    let f = (1.2 - 0.75) / (1.2 - 0.0);
    let p = [lis[0] + f * (src[0] - lis[0]), lis[1] + f * (src[1] - lis[1])];
    let q = bend_at(&paths, p).expect("top cap reflection");
    let r = (1.0f64 + 0.25 + 1.2 * 1.2).sqrt(); // image at z = 0
    assert!((q.r - r).abs() < 1e-9 && (q.delay() - r / SPEED_OF_SOUND).abs() < 1e-12);
    assert_eq!(q.pts[0], [src[0], src[1]]);
    assert_eq!(q.pts[2], [lis[0], lis[1]]);
    assert_eq!(q.crossed, 0);
    // The listener -> image direction points down and towards the source.
    assert!(q.dir[2] < -0.4 && q.dir[0] < 0.0);
    let n = (q.dir[0].powi(2) + q.dir[1].powi(2) + q.dir[2].powi(2)).sqrt();
    assert!((n - 1.0).abs() < 1e-12);
    for b in 0..6 {
        let want = 0.9f64.sqrt() * 10f64.powf(-ism::AIR_DB_PER_M[b] * r / 20.0) / r;
        assert!((q.gains[b] - want).abs() < 1e-12 * want, "band {b}");
    }
    // Not with max order 0; none when source and listener are on different sides of the top.
    assert!(bend_at(&ism::compute_paths(&sc, src, lis, 0), p).is_none());
    assert!(ism::compute_paths(&sc, [4.5, 3.2, 0.3], lis, 1).iter().all(|q| q.pts.len() != 3 || q.pts[1][0] != p[0]));
}

#[test]
fn bottom_cap_reflects_from_below_and_blockers_are_honoured() {
    let sc = table(0.72, 0.75, 0);
    let (src, lis) = ([4.5, 3.2, 0.3], [5.5, 3.7, 0.4]);
    let f = (0.4 - 0.72) / (0.4 - 1.14);
    let p = [lis[0] + f * (src[0] - lis[0]), lis[1] + f * (src[1] - lis[1])];
    let all = ism::compute_paths(&sc, src, lis, 1);
    let q = bend_at(&all, p).expect("bottom cap reflection");
    assert!((q.r - (1.0f64 + 0.25 + 0.74 * 0.74).sqrt()).abs() < 1e-9);
    assert!(q.dir[2] > 0.0, "image above the listener");
    // A wide table with a wall between the source and the reflection point: blocked by a full-height wall,
    // not by a low one.
    let (src, lis) = ([3.0, 3.5, 1.5], [9.5, 3.5, 1.5]);
    let p = [6.25, 3.5];
    let with = |wall: Option<Wall>| {
        let mut w = rect(5.0, 3.0, 9.0, 4.0, 0, 0.72, 0.75);
        w.extend(wall);
        bend_at(&ism::compute_paths(&room(w), src, lis, 1), p).is_some()
    };
    assert!(with(None));
    assert!(with(Some(Wall::partial([4.0, 0.0], [4.0, 7.0], 0, 0.0, 0.3))));
    assert!(!with(Some(Wall::partial([4.0, 0.0], [4.0, 7.0], 0, 0.0, H))));
}

// ---------------------------------------------------------------- rays

#[test]
fn geo_partial_wall_and_cap_hits() {
    let sc = room(vec![Wall::partial([5.0, 0.0], [5.0, 7.0], 0, 0.0, 1.0)]);
    let geo = rays::Geo::new(&sc, 12);
    assert!(geo.partial && geo.complex && !geo.convex);
    let hit = |g: &rays::Geo, z: f64, dz: f64| g.nearest3([2.0, 3.0, z], [1.0, 0.0, dz], 1e9, usize::MAX).map(|h| h.1);
    assert_eq!(hit(&geo, 0.5, 0.0), Some(4), "ray at 0.5 m hits the partition");
    assert_eq!(hit(&geo, 2.0, 0.0), Some(1), "ray at 2 m passes it and reaches x = 10");
    assert_eq!(hit(&geo, 2.0, -0.5), Some(4), "descending ray is at 0.5 m at x = 5");
    // The grid variant agrees.
    let grid = rays::Geo::new(&sc, 0);
    for (z, dz) in [(0.5, 0.0), (2.0, 0.0), (2.0, -0.5), (0.9, 0.05)] {
        assert_eq!(hit(&grid, z, dz), hit(&geo, z, dz));
    }
    // Caps.
    let mut w = rect(0.0, 0.0, 10.0, 7.0, 0, 0.0, f64::INFINITY);
    w.extend(rect(4.0, 3.0, 6.0, 4.0, 0, 0.72, 0.75));
    let sc = Scene::new(w, vec![opaque()], H, 0, 0);
    let geo = rays::Geo::new(&sc, 12);
    let nw = geo.walls.len();
    assert_eq!(nw, 8);
    let down = [0.0, 0.0, -1.0];
    assert_eq!(geo.nearest_cap([5.0, 3.5, 2.0], down, 1e9, usize::MAX), Some((2.0 - 0.75, nw + 2 + 0)));
    assert_eq!(geo.nearest_cap([5.0, 3.5, 0.74], down, 1e9, usize::MAX), Some((0.74 - 0.72, nw + 2 + 1)));
    assert_eq!(geo.nearest_cap([5.0, 3.5, 2.0], down, 1e9, nw + 2), Some((2.0 - 0.72, nw + 2 + 1)), "skip the top face");
    assert!(geo.nearest_cap([7.0, 3.5, 2.0], down, 1e9, usize::MAX).is_none(), "beside the table");
    assert!(geo.nearest_cap([5.0, 3.5, 0.5], down, 1e9, usize::MAX).is_none(), "below it, going down");
    // 3D visibility: the line from above the table to a point below it is blocked by the caps.
    assert!(geo.blocked3([5.0, 3.5, 2.0], [0.0, 0.0, -1.9], usize::MAX));
    assert!(!geo.blocked3([1.0, 3.5, 2.0], [0.0, 0.0, -1.9], usize::MAX));
}

fn rays_hist(sc: &Scene, n: usize) -> rays::Hist {
    let p = rays::RayParams { n_rays: n, t_max: 0.6, ..Default::default() };
    rays::trace(sc, [2.0, 3.5, 1.5], [8.0, 3.5, 1.2], &p).0
}

#[test]
fn slab_changes_the_ray_field_and_chunking_stays_exact() {
    let open = room(vec![]);
    // A thick opaque block at the height of the line (z 1.0..1.6) and a thin table slab.
    let block = room(rect(4.0, 2.5, 5.0, 4.5, 0, 1.0, 1.6));
    let slab = room(rect(4.0, 2.5, 6.0, 4.5, 0, 0.72, 0.75));
    let total = |h: &rays::Hist| h.e.iter().sum::<f64>();
    let (h0, h1, h2) = (rays_hist(&open, 20000), rays_hist(&block, 20000), rays_hist(&slab, 20000));
    for h in [&h1, &h2] {
        assert_eq!(h.lost, 0);
        assert!(h.e.iter().all(|v| v.is_finite()));
    }
    println!("ray energy open {:.4e}, block {:.4e}, slab {:.4e}", total(&h0), total(&h1), total(&h2));
    assert!((total(&h1) / total(&h0) - 1.0).abs() > 0.01, "the block must change the field at the receiver");
    assert_ne!(hist_digest(&h2), hist_digest(&h0));
    // Rays that start below the slab cannot see a receiver above it directly: with an opaque slab covering
    // the whole room except a margin the field at a receiver above differs from the open room a lot.
    let cloud = room(rect(0.3, 0.3, 9.7, 6.7, 0, 2.0, 2.05));
    let p = rays::RayParams { n_rays: 20000, t_max: 0.6, ..Default::default() };
    let below = |sc: &Scene, lis_z: f64| rays::trace(sc, [2.0, 3.5, 1.0], [8.0, 3.5, lis_z], &p).0.e.iter().sum::<f64>();
    let (open_above, cloud_above) = (below(&open, 2.5), below(&cloud, 2.5));
    println!("receiver above the cloud: open {open_above:.4e}, cloud {cloud_above:.4e}");
    assert!(cloud_above < 0.7 * open_above, "the cloud shields the receiver above it");
    // Chunked == single, also with caps.
    let (src, lis) = ([2.0, 3.5, 1.5], [8.0, 3.5, 1.2]);
    let pp = rays::RayParams { n_rays: 3000, t_max: 0.5, ..Default::default() };
    let (single, _) = rays::trace(&slab, src, lis, &pp);
    let mut t = rays::RayTracer::new(&slab, src, lis, &pp);
    for c in [700, 1, 1299, 1000] {
        t.step(c);
    }
    assert_eq!(single.e, t.snapshot().e);
}

#[test]
fn heat_map_with_partial_walls_runs() {
    let sc = room(rect(4.0, 2.5, 6.0, 4.5, 1, 0.72, 0.75));
    let bb = rays::Geo::new(&sc, 12).bbox;
    let (x0, y0, cell, nx, ny) = heat::grid_for(bb, 0.5, 4000);
    let hp = heat::HeatParams { x0, y0, cell, nx, ny, ear_z: 1.2, n_rays: 6000, t_max: 0.8, seed: 5, dir: Default::default() };
    let mut ht = heat::HeatTracer::new(&sc, [2.0, 3.5, 1.5], &hp);
    ht.step(6000);
    let acc = ht.snapshot();
    assert!(acc.iter().all(|v| v.is_finite()) && acc.iter().sum::<f32>() > 0.0);
}

#[test]
fn full_pipeline_with_caps_is_finite() {
    let sc = room(rect(4.0, 2.5, 6.0, 4.5, 1, 0.72, 0.75));
    let rp = crate::RunParams { sample_rate: 48000.0, max_order: 3, ir_len_s: 0.0, n_rays: 5000, radius: 0.4, viz_rays: 0, dir: Default::default(), diffraction: true };
    let o = crate::run(&sc, &mut dsp::NoiseCache::default(), [2.0, 3.5, 1.5], [8.0, 3.5, 1.2], &rp);
    assert!(o.ir.iter().all(|v| v.is_finite()) && o.total_paths > 10);
}
