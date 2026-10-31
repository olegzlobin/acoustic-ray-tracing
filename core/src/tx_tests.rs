//! Sound transmission through walls: regression (tau = 0 reproduces the pre-transmission results
//! bit for bit), analytic checks (ISM, rays, level difference between two rooms), double counting
//! and a timing bench.

use crate::ism::{self, tl_to_tau, Bands, Material, Scene, Wall, NB};
use crate::{dsp, heat, rays};

// ---------------------------------------------------------------- helpers

fn poly(pts: &[[f64; 2]], mat: usize) -> Vec<Wall> {
    let n = pts.len();
    (0..n).map(|i| Wall::full(pts[i], pts[(i + 1) % n], mat)).collect()
}

fn fnv_f64(x: &mut u64, v: f64) {
    *x ^= v.to_bits();
    *x = x.wrapping_mul(0x100000001b3);
}
const FNV0: u64 = 0xcbf29ce484222325;

pub(crate) fn hist_digest(h: &rays::Hist) -> u64 {
    let mut x = FNV0;
    h.e.iter().for_each(|&v| fnv_f64(&mut x, v));
    h.dir.iter().for_each(|d| d.iter().for_each(|&v| fnv_f64(&mut x, v)));
    x
}

pub(crate) fn paths_digest(paths: &[ism::Path]) -> u64 {
    let mut x = FNV0;
    for p in paths {
        fnv_f64(&mut x, p.order as f64);
        fnv_f64(&mut x, p.r);
        p.gains.iter().for_each(|&v| fnv_f64(&mut x, v));
        p.dir.iter().for_each(|&v| fnv_f64(&mut x, v));
        p.pts.iter().for_each(|q| {
            fnv_f64(&mut x, q[0]);
            fnv_f64(&mut x, q[1]);
        });
    }
    x
}

pub(crate) fn f32_digest(v: &[f32]) -> u64 {
    let mut x = FNV0;
    for &a in v {
        x ^= a.to_bits() as u64;
        x = x.wrapping_mul(0x100000001b3);
    }
    x
}

type Case = (&'static str, Scene, [f64; 3], [f64; 3], usize, f64);

fn l_scene() -> Scene {
    let m = Material::new(Bands::splat(0.05), 0.1);
    Scene {
        walls: poly(&[[0.0, 0.0], [12.0, 0.0], [12.0, 5.0], [5.0, 5.0], [5.0, 12.0], [0.0, 12.0]], 0),
        materials: vec![m],
        height: 3.0,
        floor_mat: 0,
        ceil_mat: 0,
        caps: vec![],
    }
}

fn shoebox_scene() -> Scene {
    Scene {
        walls: poly(&[[0.0, 0.0], [10.0, 0.0], [10.0, 7.0], [0.0, 7.0]], 0),
        materials: vec![Material::new(Bands::splat(0.2), 0.5)],
        height: 3.0,
        floor_mat: 0,
        ceil_mat: 0,
        caps: vec![],
    }
}

fn cathedral_scene() -> Scene {
    let pts = [[0.0, 9.0], [40.0, 9.0], [40.0, 0.0], [52.0, 0.0], [52.0, 9.0], [70.0, 9.0], [70.0, 21.0], [52.0, 21.0], [52.0, 30.0], [40.0, 30.0], [40.0, 21.0], [0.0, 21.0]];
    Scene {
        walls: poly(&pts, 0),
        materials: vec![Material::new([0.02, 0.02, 0.03, 0.04, 0.05, 0.05], 0.15), Material::new([0.01, 0.01, 0.01, 0.01, 0.02, 0.02], 0.03)],
        height: 25.0,
        floor_mat: 1,
        ceil_mat: 0,
        caps: vec![],
    }
}

fn pillar_scene() -> Scene {
    let mut sc = shoebox_scene();
    sc.walls.extend(poly(&[[4.0, 3.0], [6.0, 3.0], [6.0, 5.0], [4.0, 5.0]], 0));
    sc.walls.push(Wall::full([8.0, 1.0], [8.0, 3.0], 0));
    sc
}

fn cases() -> Vec<Case> {
    vec![
        ("shoebox", shoebox_scene(), [2.5, 3.5, 1.5], [7.0, 3.5, 1.2], 6000, 1.0),
        ("L-room", l_scene(), [9.5, 2.5, 1.5], [2.5, 9.5, 1.2], 6000, 1.0),
        ("cathedral", cathedral_scene(), [6.0, 15.0, 1.6], [30.0, 15.0, 1.6], 6000, 3.0),
        ("pillar+baffle", pillar_scene(), [2.0, 4.0, 1.5], [8.0, 4.0, 1.5], 6000, 1.0),
    ]
}

/// Two rectangular rooms side by side with a drywall-like partition (optionally with a doorway gap).
/// Room A: x in [0, wa], room B: x in [wa, wa + wb], y in [0, d]. Material 0 = walls, 1 = partition.
fn two_rooms(wa: f64, wb: f64, d: f64, h: f64, wall: Material, part: Material, gap: Option<(f64, f64)>) -> Scene {
    let x = wa + wb;
    let mut walls = poly(&[[0.0, 0.0], [x, 0.0], [x, d], [0.0, d]], 0);
    match gap {
        None => walls.push(Wall::full([wa, 0.0], [wa, d], 1)),
        Some((y0, y1)) => {
            walls.push(Wall::full([wa, 0.0], [wa, y0], 1));
            walls.push(Wall::full([wa, y1], [wa, d], 1));
        }
    }
    Scene { walls, materials: vec![wall, part], height: h, floor_mat: 0, ceil_mat: 0, caps: vec![] }
}

// ---------------------------------------------------------------- 1. tau = 0 regression

// Digests recorded from the implementation BEFORE transmission existed (opaque walls). The new code
// must reproduce them exactly when every tau is 0: same ISM paths and IR, same ray histogram
// (including the RNG stream), same heat map.
const GOLDEN: [(&str, u64, u64, u64, u64, u64, u64); 4] = [
    // name, paths(order 3), IR(24000), hist digest, steps, heat digest
    ("shoebox", 0x1fff0f1d5acb2886, 0x71b1cc0921a95443, 0x5c8ba4cd5e0a556e, 140375, 0x3c8909ac6d7288b7, 63),
    ("L-room", 0x8fa7092d744939bc, 0x4619437cdd2e9c10, 0x6a6ec7608bd4ee18, 163442, 0x1e13a34101773a0e, 15),
    ("cathedral", 0xfd955bd2e901d12f, 0xdcfe970c5118588f, 0x3808c657b1518ef1, 116438, 0xfb9bd6ec307073f7, 59),
    ("pillar+baffle", 0xa52f18346efd586b, 0x58d6c6f28ef7f2e3, 0xa9b0332eafd26658, 154689, 0xfa5fb39c2fbb9583, 27),
];

fn check_regression(cases: &[Case]) {
    for ((name, sc, src, lis, n, tmax), g) in cases.iter().zip(GOLDEN.iter()) {
        assert_eq!(name, &g.0);
        let paths = ism::compute_paths(sc, *src, *lis, 3);
        assert_eq!(paths.len(), g.6 as usize, "{name}: path count");
        assert!(paths.iter().all(|p| p.crossed == 0));
        assert_eq!(paths_digest(&paths), g.1, "{name}: ISM paths differ from the opaque-wall implementation");
        let ir = dsp::synth_ir(&paths, 48000.0, 24000);
        assert_eq!(f32_digest(&ir), g.2, "{name}: IR differs");
        let p = rays::RayParams { n_rays: *n, t_max: *tmax, ..Default::default() };
        let (h, _) = rays::trace(sc, *src, *lis, &p);
        assert_eq!(hist_digest(&h), g.3, "{name}: ray histogram differs");
        assert_eq!(h.steps, g.4, "{name}: ray step count differs");
        let bb = rays::Geo::new(sc, 12).bbox;
        let (x0, y0, cell, nx, ny) = heat::grid_for(bb, 0.5, 4000);
        let hp = heat::HeatParams { x0, y0, cell, nx, ny, ear_z: 1.2, n_rays: 6000, t_max: 1.0, seed: 5, dir: Default::default() };
        let mut ht = heat::HeatTracer::new(sc, *src, &hp);
        ht.step(6000);
        assert_eq!(f32_digest(&ht.snapshot()), g.5, "{name}: heat map differs");
    }
}

#[test]
fn tau_zero_reproduces_the_opaque_implementation() {
    check_regression(&cases());
}

#[test]
fn transmission_switched_off_through_set_scene_is_opaque() {
    // Materials carry a finite TL, but transmission = 0 must turn them into the opaque case.
    let sc = shoebox_scene();
    let walls: Vec<f32> = sc.walls.iter().flat_map(|w| [w.p1[0] as f32, w.p1[1] as f32, w.p2[0] as f32, w.p2[1] as f32, 0.0, 0.0, 1e9]).collect();
    let mut mats = vec![0.2f32; NB];
    mats.extend([0.5f32; NB]);
    mats.extend([20.0f32; NB]);
    for (flag, want_tau) in [(0u32, 0.0), (1, 0.01)] {
        unsafe { crate::set_scene(walls.as_ptr(), 4, mats.as_ptr(), 1, 3.0, 0, 0, flag) };
        let tau = crate::STATE.with(|s| s.borrow().scene.materials[0].tau[2]);
        assert!((tau - want_tau).abs() < 1e-12, "flag {flag}: tau {tau}");
    }
    // Infinite TL is opaque too.
    assert_eq!(tl_to_tau(f64::INFINITY), 0.0);
    assert_eq!(tl_to_tau(0.0), 1.0);
}

// ---------------------------------------------------------------- 2. ISM through a wall

fn free_wall_scene(tl: f64, n_walls: usize) -> Scene {
    // n parallel walls at x = 2, 3, 4, ... long enough to be crossed by the direct path.
    let walls = (0..n_walls).map(|i| Wall::full([2.0 + i as f64, -50.0], [2.0 + i as f64, 50.0], 0)).collect();
    Scene { walls, materials: vec![Material { alpha: Bands::splat(0.99), scatter: Bands::splat(0.0), tau: Bands::splat(tl_to_tau(tl)) }], height: 3.0, floor_mat: 0, ceil_mat: 0, caps: vec![] }
}

#[test]
fn ism_direct_amplitude_through_wall_is_sqrt_tau() {
    let (src, lis) = ([0.0, 0.0, 1.5], [10.0, 0.0, 1.5]);
    let free = ism::compute_paths(&Scene { walls: vec![], materials: vec![], height: 3.0, floor_mat: 0, ceil_mat: 0, caps: vec![] }, src, lis, 0);
    assert_eq!(free.len(), 1);
    // One wall of 20 dB: amplitude x 0.1 in every band.
    let p = ism::compute_paths(&free_wall_scene(20.0, 1), src, lis, 0);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].crossed, 1);
    assert_eq!(p[0].r, free[0].r);
    for b in 0..NB {
        assert!((p[0].gains[b] / free[0].gains[b] - 0.1).abs() < 1e-12, "band {b}");
    }
    // Three walls: x 0.001; five walls of 20 dB are -100 dB, below the -80 dB cutoff: dropped.
    let p = ism::compute_paths(&free_wall_scene(20.0, 3), src, lis, 0);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].crossed, 3);
    assert!((p[0].gains[3] / free[0].gains[3] - 1e-3).abs() < 1e-12);
    assert!(ism::compute_paths(&free_wall_scene(20.0, 5), src, lis, 0).is_empty());
    // Opaque (tau = 0) wall: rejected like before.
    let mut op = free_wall_scene(20.0, 1);
    op.materials[0].tau = Bands::ZERO;
    assert!(ism::compute_paths(&op, src, lis, 0).is_empty());
    // Frequency dependent: amplitude follows sqrt(tau_b).
    let mut fd = free_wall_scene(20.0, 1);
    fd.materials[0].tau = Bands([1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6]);
    let p = ism::compute_paths(&fd, src, lis, 0);
    for b in 0..NB {
        assert!((p[0].gains[b] / free[0].gains[b] - fd.materials[0].tau[b].sqrt()).abs() < 1e-9 * (1.0 + 1.0 / fd.materials[0].tau[b].sqrt()));
    }
}

#[test]
fn alpha_eff_is_at_least_tau() {
    // tau > alpha: the reflection factor uses alpha_eff = tau.
    let m = Material { alpha: Bands::splat(0.1), scatter: Bands::splat(0.0), tau: Bands::splat(0.5) };
    assert_eq!(m.alpha_eff(), Bands::splat(0.5));
    assert!((m.refl()[0] - 0.5f64.sqrt()).abs() < 1e-12);
    // And floor/ceiling ignore tau.
    assert_eq!(m.without_tx().alpha_eff(), Bands::splat(0.1));
}

// ---------------------------------------------------------------- 3. rays through a wall

/// Source | partition (x = 2) | listener (x = 4) | back wall (x = 6). Everything else absorbs. The only
/// ray path with order >= 1 that reaches the listener early is  source -> (through the partition) ->
/// back wall -> listener  (unfolded length 8 m, order 1), whose energy is tau (1 - alpha_back) / r^2.
/// The rays must reproduce it within the statistical tolerance, whatever the partition's own
/// alpha (= whatever the roulette probability p_t): that is the unbiasedness of the roulette.
#[test]
fn ray_transmission_matches_analytic_and_is_unbiased() {
    let back_alpha = 0.2;
    let tl = 3.0;
    let mut results = vec![];
    for part_alpha in [0.5, 0.95] {
        let part = Material { alpha: Bands::splat(part_alpha), scatter: Bands::splat(0.0), tau: Bands::splat(tl_to_tau(tl)) };
        let back = Material::new(Bands::splat(back_alpha), 0.0);
        let absorb = Material::new(Bands::splat(1.0), 0.0);
        let walls = vec![
            Wall::full([2.0, -50.0], [2.0, 50.0], 0),
            Wall::full([6.0, -50.0], [6.0, 50.0], 1),
        ];
        let sc = Scene { walls, materials: vec![part, back, absorb], height: 3.0, floor_mat: 2, ceil_mat: 2, caps: vec![] };
        let (src, lis) = ([0.0, 0.0, 1.5], [4.0, 0.0, 1.5]);
        let paths = ism::compute_paths(&sc, src, lis, 1);
        let b1 = paths.iter().find(|p| p.order == 1 && p.crossed == 1 && (p.r - 8.0).abs() < 1e-9).expect("ISM path through the partition");
        let expect = b1.gains[3] * b1.gains[3];
        let analytic = tl_to_tau(tl) * (1.0 - back_alpha) / 64.0 * 10f64.powf(-ism::AIR_DB_PER_M[3] * 8.0 / 10.0);
        assert!((expect / analytic - 1.0).abs() < 1e-9);
        let p = rays::RayParams { n_rays: 2_000_000, t_max: 0.06, ism_order: 0, radius: 1.0, ..Default::default() };
        let (h, _) = rays::trace(&sc, src, lis, &p);
        // Arrival of the path: 8 m = 23.3 ms; other order >= 1 paths arrive much later (> 40 m).
        let (a, z) = (17usize, 30usize);
        let got: f64 = (a..z).map(|k| h.e[k * NB + 3]).sum();
        println!("partition alpha {part_alpha}: ray energy {got:.4e}, ISM/analytic {expect:.4e}, ratio {:.3}", got / expect);
        results.push(got / expect);
        assert!((got / expect - 1.0).abs() < 0.10, "ratio {}", got / expect);
    }
    assert!((results[0] / results[1] - 1.0).abs() < 0.10, "p_t must not bias the result: {results:?}");
}

// ---------------------------------------------------------------- 4. two-room insulation

/// Level difference between two adjoining rooms. Source in room A, one receiver in each room, all
/// surfaces fully diffuse (s = 1) so the receiver sphere scores nothing and the histogram holds only
/// the diffuse "rain" energy: the reverberant field without the (ISM) direct sound. The total time
/// integrated rain energy at a receiver is proportional to the steady-state energy density there for
/// a white source, so  D = L_A - L_B = 10 log10(E_A / E_B)  must follow the classic insulation law
/// D = TL - 10 log10(S / A_B)  with S the partition area and A_B the absorption area of room B
/// (all its surfaces, the partition included). Receivers sit away from the partition and the
/// direct field through it (rain straight through the wall) is small. +-3 dB is allowed since the
/// law assumes perfectly diffuse fields and Sabine absorption.
#[test]
fn two_room_level_difference_follows_the_insulation_law() {
    let (wa, wb, d, h) = (8.0, 8.0, 6.0, 3.0);
    let alpha = 0.3;
    for tl in [30.0, 40.0] {
        let wall = Material::new(Bands::splat(alpha), 1.0);
        let part = Material { alpha: Bands::splat(alpha), scatter: Bands::splat(1.0), tau: Bands::splat(tl_to_tau(tl)) };
        let sc = two_rooms(wa, wb, d, h, wall, part, None);
        let src = [2.0, 3.0, 1.5];
        let (la, lb) = ([5.0, 1.5, 1.2], [13.0, 4.5, 1.2]);
        let p = rays::RayParams { n_rays: 400_000, t_max: 2.0, ism_order: 3, radius: 0.5, ..Default::default() };
        let total = |lis: [f64; 3]| -> f64 {
            let (hist, _) = rays::trace(&sc, src, lis, &p);
            (0..hist.nbins).map(|k| hist.e[k * NB + 3]).sum()
        };
        let (ea, eb) = (total(la), total(lb));
        let dl = 10.0 * (ea / eb).log10();
        // Absorption area of room B: floor + ceiling + 3 outer walls + partition, all alpha (alpha_eff = alpha).
        let a_b = alpha * (2.0 * wb * d + (2.0 * wb + d) * h + d * h);
        let s_part = d * h;
        let expect = tl - 10.0 * (s_part / a_b).log10();
        println!("TL {tl}: D = {dl:.1} dB, expected {expect:.1} dB (A_B {a_b:.1} m2, S {s_part:.1} m2)");
        assert!((dl - expect).abs() < 3.0, "TL {tl}: D {dl:.2} vs {expect:.2}");
    }
}

// ---------------------------------------------------------------- receiver sphere vs walls

/// Total band-3 (1 kHz) energy of the late histogram for a listener at `lis`.
fn late_energy(sc: &Scene, src: [f64; 3], lis: [f64; 3], n_rays: usize) -> f64 {
    let p = rays::RayParams { n_rays, t_max: 1.5, ism_order: 3, radius: 0.5, ..Default::default() };
    let (hist, _) = rays::trace(sc, src, lis, &p);
    (0..hist.nbins).map(|k| hist.e[k * NB + 3]).sum()
}

#[test]
fn receiver_sphere_does_not_hear_through_an_opaque_partition() {
    // Source in room A, listener in room B 0.15 m from the partition: the sphere (r = 0.5 m) pokes
    // into room A but must not score rays travelling there.
    let (alpha, wa) = (0.3, 8.0);
    let wall = Material::new(Bands::splat(alpha), 0.3);
    let part = Material { alpha: Bands::splat(alpha), scatter: Bands::splat(0.3), tau: Bands::ZERO };
    let sc = two_rooms(wa, 8.0, 6.0, 3.0, wall, part, None);
    let e = late_energy(&sc, [2.0, 3.0, 1.5], [wa + 0.15, 3.0, 1.2], 100_000);
    println!("opaque partition, listener 0.15 m behind it: late energy {e:.3e}");
    assert!(e == 0.0, "energy leaked through an opaque partition: {e:e}");
}

#[test]
fn no_level_jump_next_to_a_transmitting_partition() {
    let (alpha, wa) = (0.3, 8.0);
    let wall = Material::new(Bands::splat(alpha), 0.3);
    let part = Material { alpha: Bands::splat(alpha), scatter: Bands::splat(0.3), tau: Bands::splat(tl_to_tau(30.0)) };
    let sc = two_rooms(wa, 8.0, 6.0, 3.0, wall, part, None);
    let src = [2.0, 3.0, 1.5];
    let (near, far) = (late_energy(&sc, src, [wa + 0.15, 3.0, 1.2], 400_000), late_energy(&sc, src, [wa + 1.5, 3.0, 1.2], 400_000));
    let dl = 10.0 * (near / far).log10();
    println!("TL 30 dB: level 0.15 m vs 1.5 m behind the partition: {dl:+.1} dB");
    assert!(dl.abs() < 4.0, "near-wall jump of {dl:.1} dB");
}

// ---------------------------------------------------------------- 5. double counting

#[test]
fn no_double_counting_with_transmitting_walls() {
    // Specular walls, all with finite TL, plus a transmitting free-standing partition inside the room:
    // ISM paths of order <= 3 include the legs through the partition, so rays of order <= 3 (any
    // number of transmissions) must not score: the histogram stays empty until the earliest order-4
    // arrival.
    let mat = Material { alpha: Bands::splat(0.2), scatter: Bands::splat(0.0), tau: Bands::splat(tl_to_tau(15.0)) };
    let mut sc = Scene { walls: poly(&[[0.0, 0.0], [10.0, 0.0], [10.0, 7.0], [0.0, 7.0]], 0), materials: vec![mat], height: 3.0, floor_mat: 0, ceil_mat: 0, caps: vec![] };
    sc.walls.push(Wall::full([5.0, 1.0], [5.0, 6.0], 0));
    let (src, lis) = ([2.5, 3.5, 1.5], [7.0, 3.5, 1.2]);
    let paths = ism::compute_paths(&sc, src, lis, 4);
    assert!(paths.iter().any(|p| p.order <= 3 && p.crossed > 0), "the test must exercise transmitted ISM paths");
    // Every path above -80 dB counts; the ISM drops the rest, rays with that little energy are irrelevant.
    let t4 = paths.iter().filter(|p| p.order == 4).map(|p| p.delay()).fold(f64::MAX, f64::min);
    let p = rays::RayParams { n_rays: 60000, t_max: 0.3, ism_order: 3, ..Default::default() };
    let (hist, _) = rays::trace(&sc, src, lis, &p);
    let guard = ((t4 - 0.4 / 343.0) / rays::BIN_S) as usize - 1;
    let early: f64 = hist.e[..guard * NB].iter().sum();
    let after: f64 = hist.e[guard * NB..].iter().sum();
    println!("earliest order-4 path {:.1} ms; hist energy before {early:.3e}, after {after:.3e}", t4 * 1e3);
    assert!(early == 0.0, "energy before the first order-4 arrival: {early}");
    assert!(after > 0.0);
}

// ---------------------------------------------------------------- heat map

#[test]
fn heat_map_shows_energy_behind_a_partition_only_with_transmission() {
    let wall = Material::new(Bands::splat(0.2), 0.3);
    let run = |tl: Option<f64>| -> (f64, f64) {
        let part = Material { alpha: Bands::splat(0.2), scatter: Bands::splat(0.3), tau: Bands::splat(tl.map_or(0.0, tl_to_tau)) };
        let sc = two_rooms(6.0, 6.0, 5.0, 3.0, wall, part, None);
        let (x0, y0, cell, nx, ny) = heat::grid_for([0.0, 0.0, 12.0, 5.0], 0.5, 4000);
        let hp = heat::HeatParams { x0, y0, cell, nx, ny, ear_z: 1.2, n_rays: 100_000, t_max: 1.5, seed: 1, dir: Default::default() };
        let mut t = heat::HeatTracer::new(&sc, [2.0, 2.5, 1.5], &hp);
        t.step(hp.n_rays);
        let acc = t.snapshot();
        let (mut a, mut b) = (0.0, 0.0);
        for c in 0..nx * ny {
            let x = x0 + ((c % nx) as f64 + 0.5) * cell;
            let e: f64 = (0..heat::BINS).map(|k| acc[c * heat::BINS + k] as f64).sum();
            if x < 6.0 {
                a += e;
            } else {
                b += e;
            }
        }
        (a, b)
    };
    let (_, closed) = run(None);
    let (a, open) = run(Some(20.0));
    println!("heat energy behind the partition: opaque {closed:.3e}, TL 20 dB {open:.3e}; room A {a:.3e}");
    assert!(closed < 1e-9 * a, "no energy may leak through an opaque partition: {closed:e}");
    assert!(open > 0.0 && open < 0.1 * a);
}

// ---------------------------------------------------------------- bench

#[test]
fn bench_transmission() {
    // Ray trace time (20k rays, 5 s) for opaque scenes (tau = 0) and with preset-like transmission.
    let tx = |mut sc: Scene, tl: [f64; NB]| {
        for m in sc.materials.iter_mut() {
            m.tau = Bands(tl.map(tl_to_tau));
        }
        sc
    };
    let plaster = [35.0, 40.0, 45.0, 50.0, 55.0, 58.0];
    let two = |tlp: f64| {
        let wall = Material::new([0.02, 0.02, 0.02, 0.03, 0.04, 0.05], 0.1);
        let part = Material { alpha: Bands::splat(0.1), scatter: Bands::splat(0.1), tau: Bands::splat(tl_to_tau(tlp)) };
        two_rooms(6.0, 5.0, 4.0, 2.8, wall, part, Some((1.0, 2.0)))
    };
    let mut scenes: Vec<(String, Scene, [f64; 3], [f64; 3])> = vec![];
    for (name, sc, src, lis, _, _) in cases().into_iter().take(3) {
        scenes.push((format!("{name} opaque"), sc.clone(), src, lis));
        scenes.push((format!("{name} TL plaster"), tx(sc, plaster), src, lis));
    }
    scenes.push(("two rooms+doorway opaque partition".into(), {
        let mut s = two(30.0);
        s.materials[1].tau = Bands::ZERO;
        s
    }, [2.0, 2.0, 1.4], [8.0, 2.0, 1.2]));
    scenes.push(("two rooms+doorway TL30 drywall".into(), two(30.0), [2.0, 2.0, 1.4], [8.0, 2.0, 1.2]));
    for (name, sc, src, lis) in scenes {
        let p = rays::RayParams { n_rays: 20000, t_max: 5.0, ..Default::default() };
        let mut best = f64::MAX;
        let mut steps = 0;
        for _ in 0..7 {
            let t = std::time::Instant::now();
            let (h, _) = rays::trace(&sc, src, lis, &p);
            best = best.min(t.elapsed().as_secs_f64() * 1e3);
            steps = h.steps;
        }
        println!("BENCH {name}: {best:.1} ms (best of 7), {steps} segments");
    }
}
