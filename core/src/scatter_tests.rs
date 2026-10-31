//! Per-band scattering coefficient: reflection factor, unbiasedness of the band-weighted specular/Lambert
//! branches in the ray tracer, and the 1 kHz band in the heat map.

use crate::heat::{grid_for, HeatParams, HeatTracer};
use crate::ism::{Bands, Material, Scene, Wall, NB};
use crate::rays;

const S_NONUNIFORM: [f64; NB] = [0.0, 0.1, 0.3, 0.5, 0.8, 1.0];
// Moderate spread for the Monte Carlo comparison: the branch weights (1 - s_b)/(1 - p) and s_b/p are
// unbiased for any spread, but their variance explodes when one band is purely specular next to a
// purely diffuse one (the 0.0 and 1.0 bands above), which would need millions of rays for a few %.
const S_SPREAD: [f64; NB] = [0.1, 0.2, 0.35, 0.5, 0.65, 0.8];

fn shoebox(m: Material) -> Scene {
    let c = [[0.0, 0.0], [10.0, 0.0], [10.0, 7.0], [0.0, 7.0]];
    let walls = (0..4).map(|i| Wall::full(c[i], c[(i + 1) % 4], 0)).collect();
    Scene { walls, materials: vec![m], height: 3.0, floor_mat: 0, ceil_mat: 0, caps: vec![] }
}

/// Late histogram energy per band, summed over all bins.
fn late_energy(sc: &Scene, n_rays: usize, seed: u64) -> [f64; NB] {
    let p = rays::RayParams { n_rays, t_max: 1.5, ism_order: 3, radius: 0.5, seed, ..Default::default() };
    let (hist, _) = rays::trace(sc, [2.5, 3.5, 1.5], [7.0, 2.0, 1.2], &p);
    let mut e = [0.0; NB];
    for k in 0..hist.nbins {
        for b in 0..NB {
            e[b] += hist.e[k * NB + b];
        }
    }
    e
}

#[test]
fn refl_is_per_band() {
    let alpha = Bands([0.05, 0.1, 0.2, 0.3, 0.5, 0.7]);
    let m = Material::new(alpha, Bands(S_NONUNIFORM));
    let r = m.refl();
    for b in 0..NB {
        let want = ((1.0 - alpha[b]) * (1.0 - S_NONUNIFORM[b])).sqrt();
        assert!((r[b] - want).abs() < 1e-15, "band {b}: {} vs {want}", r[b]);
    }
    // From<f64> is a splat.
    assert_eq!(Material::new(0.1, 0.3).scatter, Bands::splat(0.3));
}

#[test]
fn nonuniform_scattering_is_unbiased_per_band() {
    let alpha = 0.2;
    let nonuni = shoebox(Material::new(Bands::splat(alpha), Bands(S_SPREAD)));
    let n = 300_000;
    for seed in [11u64, 21, 31] {
        let e = late_energy(&nonuni, n, seed);
        for b in 0..NB {
            let uni = shoebox(Material::new(Bands::splat(alpha), Bands::splat(S_SPREAD[b])));
            let want = late_energy(&uni, n, seed + 100)[b];
            let rel = e[b] / want - 1.0;
            println!("seed {seed} band {b} (s = {}): non-uniform {:.4e} uniform {:.4e} ({:+.2}%)", S_SPREAD[b], e[b], want, 100.0 * rel);
            assert!(rel.abs() < 0.04, "seed {seed} band {b}: {:+.2}% off the uniform-s run", 100.0 * rel);
        }
    }
}

#[test]
fn heat_map_uses_the_1khz_band() {
    let (x0, y0, cell, nx, ny) = grid_for([0.0, 0.0, 10.0, 7.0], 0.5, 4000);
    let p = HeatParams { x0, y0, cell, nx, ny, ear_z: 1.2, n_rays: 20_000, t_max: 1.0, seed: 5, dir: Default::default() };
    let run = |s: Bands| {
        let sc = shoebox(Material::new(Bands::splat(0.2), s));
        let mut t = HeatTracer::new(&sc, [2.5, 3.5, 1.5], &p);
        t.step(p.n_rays);
        t.snapshot().iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    };
    let mut s = Bands(S_NONUNIFORM);
    s[3] = 0.4;
    let a = run(s);
    assert_eq!(a, run(Bands::splat(0.4)), "heat map must depend on the 1 kHz scattering only");
    assert_ne!(a, run(Bands::splat(0.9)));
}
