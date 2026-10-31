//! Heat map: ONE ray trace from the source with a track-length estimator.
//!
//! Every ray segment deposits its energy times the length it spends inside a grid cell's horizontal
//! footprint, restricted to the ear-height slab z in [ear-0.5, ear+0.5] m, divided by the cell volume:
//! an estimate of the energy density in the cell (fluence rate x time). Direct sound is included
//! (every ray starts at the source) and so is every specular/diffuse reflection: this is an
//! energy-density estimate, not a point receiver, so it ignores the sphere/rain split of the IR tracer.
//!
//! Walls transmit like in `rays.rs` (unbiased roulette between transmission and reflection with the
//! 1 kHz coefficients), so rooms behind partitions receive energy; the estimator needs no change.
//!
//! Approximations: a single scalar energy using the 1 kHz absorption and air attenuation; arrival
//! time is measured at the segment centre; "early/late" is relative to the direct-sound arrival at
//! the cell centre (distance / c). Three time bins per cell: < 50 ms, 50-80 ms, >= 80 ms after the
//! direct sound (for C50 / D50 / C80).

use crate::geom::{sphere_dir, MAX_BOUNCES};
use crate::kernel::{trace_ray, Ctx, Ray, RayModel};
use crate::ism::{Directivity, Scene, AIR_DB_PER_M, SPEED_OF_SOUND};
use crate::rays::{random_rotation, Geo, Rng};
use std::f64::consts::PI;

const SLAB_HALF: f64 = 0.5;
pub const BINS: usize = 3;

#[derive(Clone, Copy, Debug)]
pub struct HeatParams {
    pub x0: f64,
    pub y0: f64,
    pub cell: f64,
    pub nx: usize,
    pub ny: usize,
    pub ear_z: f64,
    pub n_rays: usize,
    /// Maximum travel time, seconds.
    pub t_max: f64,
    pub seed: u64,
    /// Source directivity; the 1 kHz band (index 3) weights each ray's energy.
    pub dir: Directivity,
}

/// Grid covering the walls' bounding box with cells of at least `min_cell` metres and at most
/// `max_cells` cells. Returns (x0, y0, cell, nx, ny).
pub fn grid_for(bbox: [f64; 4], min_cell: f64, max_cells: usize) -> (f64, f64, f64, usize, usize) {
    let (w, h) = ((bbox[2] - bbox[0]).max(0.1), (bbox[3] - bbox[1]).max(0.1));
    let mut cell = min_cell;
    while (w / cell).ceil() * (h / cell).ceil() > max_cells as f64 {
        cell *= 1.1;
    }
    (bbox[0], bbox[1], cell, (w / cell).ceil() as usize, (h / cell).ceil() as usize)
}

pub struct HeatTracer {
    geo: Geo,
    nw: usize,
    hgt: f64,
    /// Reflection factor (1 - alpha_eff) / (1 - p_t) per surface (1 kHz).
    oma: Vec<f64>,
    /// Transmission probability per surface and the energy factor tau / p_t.
    pt: Vec<f64>,
    tw: Vec<f64>,
    scat: Vec<f64>,
    rng: Rng,
    rot: [[f64; 3]; 3],
    src: [f64; 3],
    p: HeatParams,
    e0: f64,
    k_air: f64,
    /// Direct-sound arrival time at each cell centre.
    dtime: Vec<f32>,
    acc: Vec<f64>, // [cell][BINS]
    next: usize,
}

impl HeatTracer {
    pub fn new(scene: &Scene, src: [f64; 3], p: &HeatParams) -> HeatTracer {
        let geo = Geo::new(scene, 12);
        let nw = geo.walls.len();
        let mut oma = Vec::with_capacity(nw + 2);
        let mut pt = Vec::with_capacity(nw + 2);
        let mut tw = Vec::with_capacity(nw + 2);
        let mut scat = Vec::with_capacity(nw + 2);
        for m in scene.surface_materials() {
            let (ae, t) = (m.alpha_eff()[3], m.tau_c()[3]); // 1 kHz band
            let p_t = if t > 0.0 { t / (t + (1.0 - ae)) } else { 0.0 };
            oma.push(if p_t < 1.0 { (1.0 - ae) / (1.0 - p_t) } else { 0.0 });
            pt.push(p_t);
            tw.push(if p_t > 0.0 { t / p_t } else { 0.0 });
            scat.push(m.scatter[3].clamp(0.0, 1.0));
        }
        let mut rng = Rng::new(p.seed);
        let rot = random_rotation(&mut rng);
        let mut dtime = vec![0.0f32; p.nx * p.ny];
        for iy in 0..p.ny {
            for ix in 0..p.nx {
                let c = [p.x0 + (ix as f64 + 0.5) * p.cell, p.y0 + (iy as f64 + 0.5) * p.cell, p.ear_z];
                let d = ((c[0] - src[0]).powi(2) + (c[1] - src[1]).powi(2) + (c[2] - src[2]).powi(2)).sqrt();
                dtime[iy * p.nx + ix] = (d / SPEED_OF_SOUND) as f32;
            }
        }
        HeatTracer {
            geo,
            nw,
            hgt: scene.height,
            oma,
            pt,
            tw,
            scat,
            rng,
            rot,
            src,
            p: *p,
            e0: 4.0 * PI / p.n_rays.max(1) as f64,
            k_air: AIR_DB_PER_M[3] * std::f64::consts::LN_10 / 10.0,
            dtime,
            acc: vec![0.0; p.nx * p.ny * BINS],
            next: 0,
        }
    }

    pub fn done(&self) -> usize {
        self.next
    }
    pub fn total(&self) -> usize {
        self.p.n_rays
    }

    /// Per cell [E(<50 ms), E(50-80 ms), E(>=80 ms)] for the rays traced so far, scaled to represent all rays.
    pub fn snapshot(&self) -> Vec<f32> {
        let scale = if self.next == 0 { 0.0 } else { self.p.n_rays as f64 / self.next as f64 };
        self.acc.iter().map(|v| (v * scale) as f32).collect()
    }

    pub fn step(&mut self, count: usize) -> usize {
        let end = (self.next + count).min(self.p.n_rays);
        let HeatTracer { geo, nw, hgt, oma, pt, tw, scat, rng, rot, src, p, e0, k_air, dtime, acc, next } = self;
        let max_dist = SPEED_OF_SOUND * p.t_max;
        let (zlo, zhi) = ((p.ear_z - SLAB_HALF).max(0.0), (p.ear_z + SLAB_HALF).min(*hgt));
        let slab = (zhi - zlo).max(0.1);
        let ctx = Ctx { geo, nw: *nw, hgt: *hgt, max_dist };
        let mut model = HeatModel {
            oma, pt, tw, scat, p, dtime, acc, k_air: *k_air, max_dist, thr: *e0 * 1e-5,
            zlo, zhi, vol: p.cell * p.cell * slab,
        };
        for i in *next..end {
            let d = sphere_dir(i, rot);
            trace_ray(&ctx, &mut model, rng, Ray::new::<HeatModel>(*src, d, if p.dir.is_omni() { *e0 } else { *e0 * p.dir.energy(d).0[3] }));
        }
        *next = end;
        end
    }
}

/// Ray behaviour of the heat map: scalar (1 kHz) energy, track-length deposition per segment.
struct HeatModel<'a> {
    oma: &'a [f64],
    pt: &'a [f64],
    tw: &'a [f64],
    scat: &'a [f64],
    p: &'a HeatParams,
    dtime: &'a [f32],
    acc: &'a mut [f64],
    k_air: f64,
    max_dist: f64,
    thr: f64,
    zlo: f64,
    zhi: f64,
    vol: f64,
}

impl RayModel for HeatModel<'_> {
    type E = f64;
    const RECIP_DZ: bool = false;
    // `>` MAX_BOUNCES, and after the roulette draw (differs from rays.rs; kept for bit-identical output).
    const BOUNCE_LIMIT: u32 = MAX_BOUNCES + 1;
    const CAP_BEFORE_ROULETTE: bool = false;

    #[inline]
    fn on_segment(&mut self, _ctx: &Ctx, ray: &Ray<f64>, s: f64) {
        let s_eff = s.min(self.max_dist - ray.trav);
        self.deposit(ray.pos, ray.d, s_eff, ray.e, ray.trav);
    }
    #[inline]
    fn p_transmit(&self, surf: usize) -> f64 {
        self.pt[surf]
    }
    #[inline]
    fn transmit_energy(&self, e: &mut f64, surf: usize) {
        *e *= self.tw[surf];
    }
    #[inline]
    fn reflect_energy(&self, e: &mut f64, surf: usize) {
        *e *= self.oma[surf];
    }
    #[inline]
    fn scatter(&self, surf: usize) -> f64 {
        self.scat[surf]
    }
    #[inline]
    fn on_reflect(&mut self, _ctx: &Ctx, _ray: &Ray<f64>, _surf: usize, _n3: [f64; 3]) {}
    #[inline]
    fn weak(&self, ray: &Ray<f64>) -> bool {
        ray.e < self.thr
    }
    #[inline]
    fn double(e: &mut f64) {
        *e *= 2.0;
    }
}

impl HeatModel<'_> {
    /// Track-length deposit of one segment (start `p0`, unit direction `d`, length `s`).
    fn deposit(&mut self, p0: [f64; 3], d: [f64; 3], s: f64, e: f64, trav: f64) {
        let (zlo, zhi, vol) = (self.zlo, self.zhi, self.vol);
        if s <= 0.0 {
            return;
        }
        // Clip to the ear-height slab.
        let (mut u0, mut u1) = (0.0f64, 1.0f64);
        let dz = d[2] * s;
        if dz.abs() < 1e-12 {
            if p0[2] < zlo || p0[2] > zhi {
                return;
            }
        } else {
            let a = (zlo - p0[2]) / dz;
            let b = (zhi - p0[2]) / dz;
            u0 = u0.max(a.min(b));
            u1 = u1.min(a.max(b));
            if u0 >= u1 {
                return;
            }
        }
        let len3 = s * (u1 - u0);
        let t_mid_dist = trav + s * 0.5 * (u0 + u1);
        let w = e * (-self.k_air * t_mid_dist).exp() * len3 / vol; // energy density contribution of the whole piece
        let t_mid = t_mid_dist / SPEED_OF_SOUND;
        let q0 = [p0[0] + d[0] * s * u0, p0[1] + d[1] * s * u0];
        let q1 = [p0[0] + d[0] * s * u1, p0[1] + d[1] * s * u1];
        let (nx, ny, cell) = (self.p.nx as isize, self.p.ny as isize, self.p.cell);
        let (gx, gy) = (self.p.x0, self.p.y0);
        let (dx, dy) = (q1[0] - q0[0], q1[1] - q0[1]);
        let mut ix = (((q0[0] - gx) / cell).floor() as isize).clamp(0, nx - 1);
        let mut iy = (((q0[1] - gy) / cell).floor() as isize).clamp(0, ny - 1);
        let add = |ix: isize, iy: isize, frac: f64, acc: &mut [f64], dtime: &[f32]| {
            let c = (iy * nx + ix) as usize;
            let rel = t_mid - dtime[c] as f64;
            let bin = if rel < 0.05 { 0 } else if rel < 0.08 { 1 } else { 2 };
            acc[c * BINS + bin] += w * frac;
        };
        if dx.abs() < 1e-12 && dy.abs() < 1e-12 {
            add(ix, iy, 1.0, self.acc, self.dtime);
            return;
        }
        // 2D DDA over the footprint in the segment parameter tau in [0, 1].
        let (sx, sy) = (if dx > 0.0 { 1isize } else { -1 }, if dy > 0.0 { 1isize } else { -1 });
        let next_edge = |i: isize, sgn: isize, o: f64, pp: f64, dd: f64| -> (f64, f64) {
            if dd.abs() < 1e-12 {
                return (f64::INFINITY, f64::INFINITY);
            }
            let edge = o + (i + if sgn > 0 { 1 } else { 0 }) as f64 * cell;
            ((edge - pp) / dd, cell / dd.abs())
        };
        let (mut tx, dtx) = next_edge(ix, sx, gx, q0[0], dx);
        let (mut ty, dty) = next_edge(iy, sy, gy, q0[1], dy);
        let mut tau = 0.0f64;
        loop {
            let t_next = tx.min(ty).min(1.0);
            if ix >= 0 && iy >= 0 && ix < nx && iy < ny {
                add(ix, iy, t_next - tau, self.acc, self.dtime);
            }
            if t_next >= 1.0 {
                break;
            }
            tau = t_next;
            if tx < ty {
                ix += sx;
                tx += dtx;
            } else {
                iy += sy;
                ty += dty;
            }
            if ix < 0 || iy < 0 || ix >= nx || iy >= ny {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ism::{Bands, Material, Wall};

    fn shoebox() -> Scene {
        let c = [[0.0, 0.0], [10.0, 0.0], [10.0, 7.0], [0.0, 7.0]];
        let walls = (0..4).map(|i| Wall::full(c[i], c[(i + 1) % 4], 0)).collect();
        Scene { walls, materials: vec![Material::new(Bands::splat(0.2), 0.5)], height: 3.0, floor_mat: 0, ceil_mat: 0, caps: vec![] }
    }

    #[test]
    fn spl_decays_near_source_and_is_flat_far_away_and_c50_higher_near() {
        let sc = shoebox();
        let src = [2.5, 3.5, 1.5];
        let (x0, y0, cell, nx, ny) = grid_for([0.0, 0.0, 10.0, 7.0], 0.5, 4000);
        let p = HeatParams { x0, y0, cell, nx, ny, ear_z: 1.2, n_rays: 200_000, t_max: 1.5, seed: 1, dir: Directivity::default() };
        let mut t = HeatTracer::new(&sc, src, &p);
        t.step(p.n_rays);
        let acc = t.snapshot();
        let tot = |c: usize| (acc[c * BINS] + acc[c * BINS + 1] + acc[c * BINS + 2]) as f64;
        let db = |c: usize| 10.0 * tot(c).max(1e-30).log10();
        let c50 = |c: usize| 10.0 * ((acc[c * BINS] as f64) / ((acc[c * BINS + 1] + acc[c * BINS + 2]) as f64)).log10();
        // Cells by distance from the source (horizontal).
        let mut by: Vec<(f64, usize)> = (0..nx * ny)
            .map(|c| {
                let (ix, iy) = (c % nx, c / nx);
                let (x, y) = (x0 + (ix as f64 + 0.5) * cell, y0 + (iy as f64 + 0.5) * cell);
                (((x - src[0]).powi(2) + (y - src[1]).powi(2)).sqrt(), c)
            })
            .collect();
        by.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let near: Vec<usize> = by.iter().filter(|(r, _)| *r < 0.8).map(|x| x.1).collect();
        let mid: Vec<usize> = by.iter().filter(|(r, _)| *r > 1.8 && *r < 2.4).map(|x| x.1).collect();
        let far: Vec<usize> = by.iter().filter(|(r, _)| *r > 4.0 && *r < 7.0).map(|x| x.1).collect();
        let mean = |v: &[usize], f: &dyn Fn(usize) -> f64| v.iter().map(|&c| f(c)).sum::<f64>() / v.len() as f64;
        let (n_db, m_db, f_db) = (mean(&near, &db), mean(&mid, &db), mean(&far, &db));
        let spread = far.iter().map(|&c| db(c)).fold((f64::MAX, f64::MIN), |a, v| (a.0.min(v), a.1.max(v)));
        println!("SPL near {n_db:.1} mid {m_db:.1} far {f_db:.1} dB; far spread {:.1}..{:.1}", spread.0, spread.1);
        println!("C50 near {:.1} mid {:.1} far {:.1} dB", mean(&near, &c50), mean(&mid, &c50), mean(&far, &c50));
        assert!(n_db > m_db + 3.0 && m_db > f_db, "level must fall off with distance near the source");
        assert!(spread.1 - spread.0 < 6.0, "far field should be roughly flat: {:.1}..{:.1}", spread.0, spread.1);
        assert!(mean(&near, &c50) > mean(&far, &c50) + 3.0, "clarity is higher near the source");
    }

    #[test]
    fn chunked_equals_single() {
        let sc = shoebox();
        let (x0, y0, cell, nx, ny) = grid_for([0.0, 0.0, 10.0, 7.0], 0.5, 4000);
        let p = HeatParams { x0, y0, cell, nx, ny, ear_z: 1.2, n_rays: 6000, t_max: 1.0, seed: 3, dir: Default::default() };
        let mut a = HeatTracer::new(&sc, [2.5, 3.5, 1.5], &p);
        a.step(6000);
        let mut b = HeatTracer::new(&sc, [2.5, 3.5, 1.5], &p);
        for c in [1000, 1, 2999, 2000] {
            b.step(c);
        }
        assert_eq!(a.snapshot(), b.snapshot());
    }
}
