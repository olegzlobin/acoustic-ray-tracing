//! Edge diffraction of the direct sound: doorway jamb, low and just-too-low walls, continuity across the
//! shadow boundary, switch off = unchanged.

use crate::ism::utd::band_rms;
use crate::ism::{self, build_edges, Bands, BAND_HZ, Directivity, IsmCache, Material, Path, Scene, Wall, SPEED_OF_SOUND};
use crate::tx_tests::paths_digest;
use std::f64::consts::PI;

const H: f64 = 3.0;

fn opaque() -> Material {
    Material::new(Bands::splat(0.1), 0.0)
}

fn room(extra: Vec<Wall>) -> Scene {
    let c = [[0.0, 0.0], [10.0, 0.0], [10.0, 5.0], [0.0, 5.0]];
    let mut walls: Vec<Wall> = (0..4).map(|i| Wall::full(c[i], c[(i + 1) % 4], 0)).collect();
    walls.extend(extra);
    Scene::new(walls, vec![opaque()], H, 0, 0)
}

/// 10 x 5 room, partition at x = 5 from y = 0 to 4 (doorway y = 4..5).
fn doorway() -> Scene {
    room(vec![Wall::full([5.0, 0.0], [5.0, 4.0], 0)])
}

fn paths(sc: &Scene, src: [f64; 3], lis: [f64; 3], diffraction: bool) -> Vec<Path> {
    let mut cache = IsmCache::default();
    let (nodes, edges) = cache.tree_and_edges(sc, 1, [src[0], src[1]], 0, diffraction);
    ism::compute_paths_with_edges(sc, nodes, edges, src, lis, 0)
}

fn level_db(p: &[Path]) -> f64 {
    // Mean over the six bands and 8 log-spaced sub-frequencies of |sum_p g_b exp(-jk r)|^2 of the order-0 paths:
    // the signed gains (diffracted path negative in the lit zone) add coherently.
    let mut acc = 0.0;
    for b in 0..6 {
        for i in 0..8 {
            let k = 2.0 * PI * BAND_HZ[b] * 2f64.powf(-0.5 + i as f64 / 7.0) / SPEED_OF_SOUND;
            let (mut re, mut im) = (0.0, 0.0);
            for x in p.iter().filter(|x| x.order == 0) {
                re += x.gains[b] * (k * x.r).cos();
                im -= x.gains[b] * (k * x.r).sin();
            }
            acc += re * re + im * im;
        }
    }
    10.0 * (acc / 48.0).log10()
}

fn is_direct(p: &Path) -> bool {
    p.order == 0 && p.pts.len() == 2
}

fn db(a: f64, b: f64) -> f64 {
    20.0 * (a / b).log10()
}

#[test]
fn edges_of_a_partition_and_of_a_low_wall() {
    // 4 room corners + the two partition ends.
    assert_eq!(build_edges(&doorway()).len(), 6);
    let low = room(vec![Wall::partial([5.0, 0.0], [5.0, 5.0], 0, 0.0, 1.5)]);
    let e = build_edges(&low);
    assert_eq!(e.len(), 7, "6 vertical + the top edge");
    assert_eq!(e.iter().filter(|e| e.a[2] == e.b[2] && (e.a[2] - 1.5).abs() < 1e-12).count(), 1);
    // A row of collinear wall pieces of the same height is one top edge.
    let row = room(vec![
        Wall::partial([2.0, 2.0], [3.0, 2.0], 0, 0.0, 0.8),
        Wall::partial([3.0, 2.0], [4.5, 2.0], 0, 0.0, 0.8),
    ]);
    assert_eq!(build_edges(&row).iter().filter(|e| e.a[2] == e.b[2]).count(), 1);
    // Floating panel: top and bottom edge.
    let panel = room(vec![Wall::partial([2.0, 2.0], [4.0, 2.0], 0, 0.5, 2.0)]);
    assert_eq!(build_edges(&panel).iter().filter(|e| e.a[2] == e.b[2]).count(), 2);
}

#[test]
fn doorway_listener_behind_the_partition_hears_the_jamb() {
    let sc = doorway();
    let (src, lis) = ([2.0, 1.0, 1.2], [8.0, 1.0, 1.2]);
    let p = paths(&sc, src, lis, true);
    assert!(!p.iter().any(is_direct), "direct path is blocked");
    let d: Vec<&Path> = p.iter().filter(|x| x.order == 0).collect();
    assert!(!d.is_empty() && d.len() <= 3);
    let d = d[0];
    assert_eq!(d.crossed, 0);
    assert_eq!(d.pts.len(), 3);
    assert!((d.pts[1][0] - 5.0).abs() < 1e-9 && (d.pts[1][1] - 4.0).abs() < 1e-9, "via the jamb (5, 4): {:?}", d.pts);
    let e = [5.0, 4.0, 1.2];
    let r = ((src[0] - e[0]).powi(2) + (src[1] - e[1]).powi(2)).sqrt() + ((lis[0] - e[0]).powi(2) + (lis[1] - e[1]).powi(2)).sqrt();
    assert!((d.delay() - r / SPEED_OF_SOUND).abs() < 1e-9);
    let drop = db(d.gains[0], d.gains[5]);
    assert!(drop > 6.0 && drop < 20.0, "4 kHz is {drop:.1} dB below 125 Hz");
    // UTD thin screen (n = 2) at the jamb: the partition leaves the jamb in direction 3 pi / 2 (face 0), S is at
    // 225 degrees and L at 315 degrees from the jamb, i.e. phi_s = 7 pi / 4, phi_l = pi / 4; S, E, L at the same
    // height, so the edge is perpendicular to both legs (sin b = 1).
    for b in 0..6 {
        let a = band_rms(b, 7.0 * PI / 4.0, PI / 4.0, 2.0, r / 2.0, r / 2.0, 1.0);
        let want = a * 10f64.powf(-ism::AIR_DB_PER_M[b] * r / 20.0) / r;
        assert!((d.gains[b] - want).abs() < 1e-12 * want, "band {b}: {} vs {want}", d.gains[b]);
    }
    // Arrives from the jamb.
    assert!(d.dir[1] > 0.0 && d.dir[0] < 0.0);
}

#[test]
fn level_is_continuous_across_the_shadow_boundary() {
    let sc = doorway();
    let src = [4.0, 3.5, 1.2];
    // The line through the jamb (5, 4) hits x = 6 at y = 4.5: lit above, shadow below.
    let mut prev: Option<f64> = None;
    let (mut saw_lit, mut saw_shadow) = (false, false);
    let mut y = 3.5;
    while y < 4.95 {
        let p = paths(&sc, src, [6.0, y, 1.2], true);
        saw_lit |= p.iter().any(is_direct);
        saw_shadow |= !p.iter().any(is_direct);
        let l = level_db(&p);
        if let Some(q) = prev {
            assert!((l - q).abs() < 2.0, "step {:.2} dB at y = {y:.2}", l - q);
        }
        prev = Some(l);
        y += 0.05;
    }
    assert!(saw_lit && saw_shadow);
    // Right on the boundary the direct sound is about 6 dB down (geometric - 1/2 on the lit side); the exact figure
    // depends on k L (the smooth diffraction terms), here the legs are only ~1.1 m long: 3.6 .. 5.6 dB over the bands.
    // (The -6.02 dB limit for k L >> 1 is checked in `utd_tests`.)
    let free = level_db(&paths(&sc, src, [6.0, 4.5001, 1.2], false));
    let edge = level_db(&paths(&sc, src, [6.0, 4.5001, 1.2], true));
    assert!(edge < free - 3.0 && edge > free - 6.5, "{} vs {}", edge, free);
}

#[test]
fn walls_below_and_above_the_line() {
    let (src, lis) = ([2.0, 2.5, 1.2], [8.0, 2.5, 1.2]);
    let base = paths(&room(vec![]), src, lis, true);
    let base_g = base.iter().find(|p| is_direct(p)).unwrap().gains;
    // Low wall far below the line: the geometric path is NOT attenuated any more (it used to be, by the lit-zone
    // insertion loss). The only addition is the weak negative diffracted path over the top edge.
    let low = room(vec![Wall::partial([5.0, 0.0], [5.0, 5.0], 0, 0.0, 0.2)]);
    let p = paths(&low, src, lis, true);
    assert_eq!(p.iter().find(|p| is_direct(p)).unwrap().gains, base_g);
    let extra: Vec<&Path> = p.iter().filter(|x| x.order == 0 && x.pts.len() == 3).collect();
    assert_eq!(p.len(), base.len() + extra.len());
    assert_eq!(extra.len(), 1);
    assert!(extra[0].gains.iter().all(|&g| g < 0.0), "negative in the lit zone");
    let rel = (0..6).map(|b| -extra[0].gains[b] / base_g[b]).fold(0.0, f64::max);
    assert!(rel >= 0.03 && rel < 0.35, "{rel:.3} of the geometric path");
    // Wall just above the line: blocked, heard over the top edge: UTD thin screen. The edge is along y, so S - E and
    // E - L are perpendicular to it (sin b = 1); top edge at 1.5: v = 1.2 - 1.5 = -0.3, u = +-3 (face 0 points down).
    let high = room(vec![Wall::partial([5.0, 0.0], [5.0, 5.0], 0, 0.0, 1.5)]);
    let p = paths(&high, src, lis, true);
    assert!(!p.iter().any(is_direct));
    let d = p.iter().find(|x| x.order == 0).expect("diffracted path");
    assert!((d.pts[1][0] - 5.0).abs() < 1e-9 && (d.pts[1][1] - 2.5).abs() < 1e-6, "{:?}", d.pts);
    assert!(d.dir[2] > 0.0, "arrives from above");
    let (phi_s, phi_l) = ((3.0f64).atan2(0.3), (-3.0f64).atan2(0.3).rem_euclid(2.0 * PI));
    let r1 = (9.0f64 + 0.09).sqrt();
    for b in 0..6 {
        let want = band_rms(b, phi_s, phi_l, 2.0, r1, r1, 1.0) * 10f64.powf(-ism::AIR_DB_PER_M[b] * 2.0 * r1 / 20.0) / (2.0 * r1);
        assert!((d.gains[b] - want).abs() < 1e-12 * want, "band {b}: {} vs {want}", d.gains[b]);
    }
    assert!(d.gains[5] < d.gains[0]);
    let il = db(base_g[0], d.gains[0]);
    assert!(il > 4.5 && il < 10.0, "level re the geometric path at 125 Hz: -{il:.2} dB");
}

#[test]
fn switch_off_and_edge_free_scenes_are_unchanged() {
    // Off: exactly the plain implementation (also with a doorway).
    let sc = doorway();
    let (src, lis) = ([2.0, 1.0, 1.2], [8.0, 1.0, 1.2]);
    let mut cache = IsmCache::default();
    let (nodes, edges) = cache.tree_and_edges(&sc, 1, [src[0], src[1]], 3, false);
    assert!(edges.is_none());
    let off = ism::compute_paths_with_edges(&sc, nodes, edges, src, lis, 3);
    assert_eq!(paths_digest(&off), paths_digest(&ism::compute_paths(&sc, src, lis, 3)));
    // On: a plain shoebox with the direct path visible and no edge near the line is bit-identical.
    let bx = room(vec![]);
    let (src, lis) = ([2.0, 2.5, 1.5], [8.0, 2.0, 1.2]);
    let mut cache = IsmCache::default();
    let (nodes, edges) = cache.tree_and_edges(&bx, 1, [src[0], src[1]], 3, true);
    let on = ism::compute_paths_with_edges(&bx, nodes, edges, src, lis, 3);
    assert_eq!(paths_digest(&on), paths_digest(&ism::compute_paths(&bx, src, lis, 3)));
}

#[test]
fn diffracted_paths_get_the_directivity_of_the_first_leg() {
    let sc = doorway();
    let (src, lis) = ([2.0, 1.0, 1.2], [8.0, 1.0, 1.2]);
    let gain_for = |facing: f64| {
        let mut p = paths(&sc, src, lis, true);
        crate::apply_directivity(&mut p, &Directivity { facing, alpha: [0.5; 6], floor: 0.0 });
        p.iter().find(|x| x.order == 0).unwrap().gains[5]
    };
    let toward_jamb = (3.0f64).atan2(3.0);
    assert!(gain_for(toward_jamb) > 1.5 * gain_for(toward_jamb + std::f64::consts::PI));
}

// ---- floor / ceiling combinations (ISO 9613-2 style ground + barrier)

fn mat(alpha: f64) -> Material {
    Material::new(Bands::splat(alpha), 0.0)
}

/// 10 x 5 x 3 room (walls alpha 0.1) with the given floor / ceiling absorption and extra walls.
fn room_fc(floor: f64, ceil: f64, extra: Vec<Wall>) -> Scene {
    let c = [[0.0, 0.0], [10.0, 0.0], [10.0, 5.0], [0.0, 5.0]];
    let mut walls: Vec<Wall> = (0..4).map(|i| Wall::full(c[i], c[(i + 1) % 4], 0)).collect();
    walls.extend(extra);
    Scene::new(walls, vec![opaque(), mat(floor), mat(ceil)], H, 1, 2)
}

fn paths_n(sc: &Scene, src: [f64; 3], lis: [f64; 3], order: u32) -> Vec<Path> {
    let mut cache = IsmCache::default();
    let (nodes, edges) = cache.tree_and_edges(sc, 1, [src[0], src[1]], order, true);
    ism::compute_paths_with_edges(sc, nodes, edges, src, lis, order)
}

fn digest_of(p: &[Path], keep: impl Fn(&Path) -> bool) -> u64 {
    let v: Vec<Path> = p.iter().filter(|x| keep(x)).cloned().collect();
    paths_digest(&v)
}

/// Energy (summed over all bands) of the W channel of the IR of `p`, per octave band.
fn band_energies(p: &[Path]) -> [f64; 6] {
    let fs = 48000.0;
    let n = 4096;
    let ir = crate::dsp::synth_ir(p, fs, n);
    let mut e = [0.0; 6];
    for (b, eb) in e.iter_mut().enumerate() {
        let mut w: Vec<f32> = ir[..n].to_vec();
        crate::dsp::filter_band(b, fs, &mut w);
        *eb = w.iter().map(|&v| (v as f64) * (v as f64)).sum();
    }
    e
}

#[test]
fn absorbing_floor_and_ceiling_leave_the_direct_diffraction_bit_identical() {
    let scenes = [
        room_fc(1.0, 1.0, vec![Wall::full([5.0, 0.0], [5.0, 4.0], 0)]),
        room_fc(1.0, 1.0, vec![Wall::partial([5.0, 0.0], [5.0, 5.0], 0, 0.0, 1.5)]),
    ];
    for sc in &scenes {
        for (src, lis) in [([2.0, 1.0, 1.2], [8.0, 1.0, 1.2]), ([2.0, 1.0, 0.3], [8.0, 2.0, 0.1]), ([4.0, 3.5, 1.2], [6.0, 4.4, 1.2]), ([4.0, 3.5, 1.2], [6.0, 4.6, 1.2])] {
            let full = paths_n(sc, src, lis, 3);
            let only_direct = paths_n(sc, src, lis, 0);
            let is0 = |p: &Path| p.order == 0;
            assert_eq!(digest_of(&full, is0), digest_of(&only_direct, is0), "{src:?} -> {lis:?}");
            // Nothing but order-0 paths was added to the plain ISM result.
            let plain = ism::compute_paths(sc, src, lis, 3);
            let isn = |p: &Path| p.order > 0;
            assert_eq!(digest_of(&full, isn), digest_of(&plain, isn));
        }
    }
}

/// Sum of the 125 Hz amplitudes of the diffracted paths over the partition edge whose delay is within `tol_m`
/// of `r0` (paths of nearly equal delay add coherently at 125 Hz).
fn coherent_125(p: &[Path], r0: f64, tol_m: f64) -> f64 {
    p.iter().filter(|x| x.pts.len() == 3 && (x.pts[1][0] - 5.0).abs() < 1e-9 && (x.r - r0).abs() < tol_m).map(|x| x.gains[0]).sum()
}

#[test]
fn receiver_on_a_rigid_floor_doubles_the_diffracted_amplitude() {
    // Infinite partition (floor to 2 m, room 3 m high) between source and a receiver 5 mm above the floor.
    let part = || vec![Wall::partial([5.0, 0.0], [5.0, 5.0], 0, 0.0, 2.0)];
    let (src, lis) = ([2.0, 2.5, 1.5], [8.0, 2.5, 0.005]);
    let hard = paths_n(&room_fc(0.01, 1.0, part()), src, lis, 1);
    let soft = paths_n(&room_fc(1.0, 1.0, part()), src, lis, 1);
    let d0 = soft.iter().find(|p| p.order == 0 && p.pts.len() == 3 && (p.pts[1][0] - 5.0).abs() < 1e-9).expect("diffracted path");
    let g_soft = coherent_125(&soft, d0.r, 0.05);
    assert_eq!(g_soft, d0.gains[0]);
    let g_hard = coherent_125(&hard, d0.r, 0.05);
    let gain_db = 20.0 * (g_hard / g_soft).log10();
    assert!((gain_db - 6.0).abs() < 1.0, "{gain_db:.2} dB");
    // The (none, none) path itself is unchanged.
    let h0 = hard.iter().find(|p| p.order == 0 && p.pts.len() == 3 && (p.pts[1][0] - 5.0).abs() < 1e-9).unwrap();
    assert_eq!(h0.gains, d0.gains);
    // The 125 Hz IR energy of the order <= 1 diffraction paths behaves the same way.
    let diff_only = |p: &[Path]| -> Vec<Path> { p.iter().filter(|x| x.pts.len() == 3 && (x.pts[1][0] - 5.0).abs() < 1e-9 && x.order <= 1 && (x.r - d0.r).abs() < 0.05).cloned().collect() };
    let (eh, es) = (band_energies(&diff_only(&hard))[0], band_energies(&diff_only(&soft))[0]);
    let ir_db = 10.0 * (eh / es).log10();
    assert!((ir_db - 6.0).abs() < 1.0, "IR {ir_db:.2} dB");
}

#[test]
fn level_is_continuous_across_the_floor_path_shadow_boundary() {
    // Partition at x = 3 up to 0.5 m, source (2, 2.5, 0.3), listener at 1 m moving away: the floor-reflected
    // line passes over the top at x = 3.6 (lit before, shadow after); the direct line only at x = 5.5.
    let sc = room_fc(0.05, 1.0, vec![Wall::partial([3.0, 0.0], [3.0, 5.0], 0, 0.0, 0.5)]);
    let src = [2.0, 2.5, 0.3];
    let has_floor_path = |p: &[Path]| p.iter().any(|x| x.order == 1 && x.pts.len() == 2 && x.dir[2] < 0.0);
    let (mut saw_lit, mut saw_shadow) = (false, false);
    let mut prev: Option<[f64; 6]> = None;
    let mut x = 3.2;
    while x < 4.2 {
        let p = paths_n(&sc, src, [x, 2.5, 1.0], 1);
        let lit = has_floor_path(&p);
        saw_lit |= lit;
        saw_shadow |= !lit;
        let e = band_energies(&p);
        if let Some(q) = prev {
            // 125 Hz .. 1 kHz: above that the 2-tap fractional delay of the IR synthesis itself makes the band
            // energy wobble by a few dB from step to step (4 kHz), independent of the diffraction.
            let tot = |a: &[f64; 6]| a[..4].iter().sum::<f64>();
            let step = 10.0 * (tot(&e) / tot(&q)).log10();
            assert!(step.abs() < 1.5, "total step {step:.2} dB at x = {x:.2}");
            for b in 0..4 {
                let s = 10.0 * (e[b] / q[b]).log10();
                assert!(s.abs() < 1.5, "band {b} step {s:.2} dB at x = {x:.2}");
            }
        }
        prev = Some(e);
        x += 0.01;
    }
    assert!(saw_lit && saw_shadow);
}

#[test]
fn a_blocked_floor_leg_removes_the_folded_path() {
    let part = Wall::partial([5.0, 0.0], [5.0, 5.0], 0, 0.0, 2.0);
    // Off-centre in y so that no wall reflection happens to touch the partition.
    let (src, lis) = ([2.0, 2.2, 1.5], [8.0, 2.9, 1.0]);
    let y_edge = 2.55; // the line S-L crosses x = 5 here; the diffraction points lie close to it
    let over_edge = |p: &[Path]| p.iter().filter(|x| x.order == 1 && x.pts.len() == 3 && (x.pts[1][0] - 5.0).abs() < 1e-9 && (x.pts[1][1] - y_edge).abs() < 0.2).count();
    let free = over_edge(&paths_n(&room_fc(0.05, 1.0, vec![part]), src, lis, 1));
    assert_eq!(free, 2, "(floor, none) and (none, floor)");
    // A 0.6 m low wall at x = 6.5: the leg E -> floor point (z = 0.5 there) is blocked, the leg E -> L (z = 1.5) is not.
    let low = Wall::partial([6.5, 0.0], [6.5, 5.0], 0, 0.0, 0.6);
    let with_low = paths_n(&room_fc(0.05, 1.0, vec![part, low]), src, lis, 1);
    assert_eq!(over_edge(&with_low), 1, "only (floor, none) is left");
    assert!(with_low.iter().any(|p| p.order == 0 && p.pts.len() == 3 && (p.pts[1][0] - 5.0).abs() < 1e-9));
}

#[test]
fn reflective_ceiling_adds_folded_paths_around_the_jamb() {
    let sc = room_fc(1.0, 0.05, vec![Wall::full([5.0, 0.0], [5.0, 4.0], 0)]);
    let (src, lis) = ([2.0, 1.0, 1.2], [7.0, 1.0, 1.0]);
    let p = paths_n(&sc, src, lis, 1);
    let at_jamb: Vec<&Path> = p.iter().filter(|x| x.order == 1 && x.pts.len() == 3 && (x.pts[1][0] - 5.0).abs() < 1e-9 && (x.pts[1][1] - 4.0).abs() < 1e-9).collect();
    // The jamb is a vertical edge up to the ceiling: of the two combinations only the one whose diffraction
    // point stays below the ceiling exists. Here S* = (2, 1, 4.8) -> L gives z_E < 3 (the mirror image
    // S -> L* = (7, 1, 5) would need z_E > 3).
    assert_eq!(at_jamb.len(), 1, "(ceiling, none)");
    let refl = mat(0.05).refl()[0];
    let d2 = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).hypot(a[1] - b[1]);
    let jamb = [5.0, 4.0];
    let (ds, dl) = (d2([src[0], src[1]], jamb), d2([lis[0], lis[1]], jamb));
    {
        let d = at_jamb[0];
        let (zs, zl) = (2.0 * H - src[2], lis[2]);
        let ez = zs + (zl - zs) * ds / (ds + dl);
        assert!(ez > 0.0 && ez < H);
        let r = (ds * ds + (ez - zs).powi(2)).sqrt() + (dl * dl + (ez - zl).powi(2)).sqrt();
        let direct = (d2([src[0], src[1]], [lis[0], lis[1]]).powi(2) + (zl - zs).powi(2)).sqrt();
        // UTD, n = 2: the partition leaves the jamb in direction 3 pi / 2; S* is at 225 degrees, L at
        // atan2(-3, 2) = -56.31 degrees = 303.69 degrees: phi_s = 7 pi / 4, phi_l = 33.69 degrees. The edge is vertical,
        // sin b = (plan distance S-jamb) / r1.
        let (r1, r2) = ((ds * ds + (ez - zs).powi(2)).sqrt(), (dl * dl + (ez - zl).powi(2)).sqrt());
        let phi_l = (-3.0f64).atan2(2.0).rem_euclid(2.0 * PI) - 1.5 * PI;
        let a = band_rms(0, 7.0 * PI / 4.0, phi_l, 2.0, r1, r2, ds / r1);
        let want = a * refl * 10f64.powf(-ism::AIR_DB_PER_M[0] * r / 20.0) / r;
        let _ = direct;
        assert!((d.r - r).abs() < 1e-9 && (d.gains[0] - want).abs() < 1e-9 * want, "{} vs {}", d.gains[0], want);
        // It arrives from the jamb (z_E about 2.7 m, above the 1 m ear height).
        assert!(d.dir[2] > 0.0 && d.dir[0] < 0.0, "{:?}", d.dir);
    }
}

#[test]
fn lit_floor_path_keeps_its_gain_and_gets_a_negative_diffracted_path() {
    // Same scene as the floor-path boundary test: at x = 3.55 both the direct line (z = 0.62 over the top edge) and the
    // floor-reflected line (z = 0.54) clear the 0.5 m partition, just before the floor boundary at x = 3.6.
    let sc = room_fc(0.05, 1.0, vec![Wall::partial([3.0, 0.0], [3.0, 5.0], 0, 0.0, 0.5)]);
    let (src, lis) = ([2.0, 2.5, 0.3], [3.55, 2.5, 1.0]);
    let p = paths_n(&sc, src, lis, 1);
    let plain = ism::compute_paths(&sc, src, lis, 1);
    let floor = |p: &[Path]| p.iter().find(|x| x.order == 1 && x.pts.len() == 2 && x.dir[2] < 0.0).cloned().unwrap();
    assert_eq!(floor(&p).gains, floor(&plain).gains, "the ISM floor path is not attenuated");
    let over_top: Vec<&Path> = p.iter().filter(|x| x.order == 1 && x.pts.len() == 3 && (x.pts[1][0] - 3.0).abs() < 1e-9).collect();
    assert_eq!(over_top.len(), 1, "(floor, none) or (none, floor) on the ISM side");
    assert!(over_top[0].gains.iter().all(|&g| g < 0.0), "{:?}", over_top[0].gains);
    // The direct path is lit too: negative path over the edge, geometric path untouched.
    let direct = |p: &[Path]| p.iter().find(|x| is_direct(x)).unwrap().gains;
    assert_eq!(direct(&p), direct(&plain));
    assert!(p.iter().any(|x| x.order == 0 && x.pts.len() == 3 && x.gains.iter().all(|&g| g < 0.0)));
}

#[test]
fn etc_of_a_receiver_on_a_rigid_floor_follows_the_ir_plus_6_db() {
    // Same scene as `receiver_on_a_rigid_floor_doubles_the_diffracted_amplitude`: the (none, floor) path coincides with the
    // direct diffracted one to within millimetres, so at 125 Hz the ETC energy of the pair is 4x (+6 dB), like the IR.
    let part = || vec![Wall::partial([5.0, 0.0], [5.0, 5.0], 0, 0.0, 2.0)];
    let (src, lis) = ([2.0, 2.5, 1.5], [8.0, 2.5, 0.005]);
    let hard = paths_n(&room_fc(0.01, 1.0, part()), src, lis, 1);
    let soft = paths_n(&room_fc(1.0, 1.0, part()), src, lis, 1);
    let d0 = soft.iter().find(|p| p.order == 0 && p.pts.len() == 3 && (p.pts[1][0] - 5.0).abs() < 1e-9).unwrap().r;
    let diff_only = |p: &[Path]| -> Vec<Path> { p.iter().filter(|x| x.pts.len() == 3 && (x.pts[1][0] - 5.0).abs() < 1e-9 && x.order <= 1 && (x.r - d0).abs() < 0.05).cloned().collect() };
    let band0 = |p: &[Path]| crate::metrics::build_etc(p, &crate::rays::Hist::empty(600)).e[..600].iter().sum::<f64>();
    let db = 10.0 * (band0(&diff_only(&hard)) / band0(&diff_only(&soft))).log10();
    assert!((db - 6.0).abs() < 1.0, "ETC {db:.2} dB");
}
