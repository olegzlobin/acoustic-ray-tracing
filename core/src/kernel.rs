//! Shared ray-bounce kernel: propagation of ONE ray through the 2.5D scene (vertical walls + floor and
//! ceiling). Used by the IR tracer (`rays.rs`) and the heat map (`heat.rs`); what a ray does along its
//! way (histogram + receiver sphere + diffuse rain, or track-length deposition) is plugged in through
//! the [`RayModel`] trait. `trace_ray` is generic, so each model gets its own monomorphised, fully
//! inlined copy (no dynamic dispatch in the hot loop).
//!
//! The kernel owns: nearest surface (walls through the grid, floor, ceiling), advancing, the
//! transmission/reflection Russian roulette, the specular/Lambert choice, direction re-normalisation,
//! the bounce cap and the low-energy roulette. The RNG is consumed in the order
//!   thin (model) -> transmission draw -> scatter draw [-> lambert draws] -> energy roulette draw,
//! (`scatter_energy` draws nothing, so per-band scattering weights leave the order unchanged)
//! and the two models differ in a few places that are bit-exact requirements (see the associated
//! constants); do not reorder without regenerating the golden digests.
//!
//! Hook points for later physics (e.g. diffraction): `on_segment` sees every free-flight segment,
//! `on_hit` every surface hit (position, normal, surface) before the transmit/reflect decision. A
//! secondary source is a new [`Ray`] traced with another `trace_ray` call, so a model can collect
//! them in `on_hit` and the driver loop can drain its queue after the primary ray finishes.

use crate::geom::{normalize, offset, reflect, surface_normal, NONE, OFFSET};
use crate::rays::{lambert, Geo, Rng};

/// Read-only scene data of a trace.
pub(crate) struct Ctx<'a> {
    pub geo: &'a Geo,
    /// Number of walls; the floor is surface `nw`, the ceiling `nw + 1`, cap faces follow.
    pub nw: usize,
    pub hgt: f64,
    /// Maximum travel distance (m).
    pub max_dist: f64,
}

/// Mutable state of one ray. `E` is the energy type (per band or scalar).
pub(crate) struct Ray<E> {
    pub pos: [f64; 3],
    pub d: [f64; 3],
    pub e: E,
    /// Distance travelled so far.
    pub trav: f64,
    /// Surface the ray just left (not tested for the next hit), `NONE` for none.
    pub skip: usize,
    pub bounces: u32,
    /// 1/d[2], maintained only when `RayModel::RECIP_DZ`.
    pub inv_dz: f64,
}

impl<E> Ray<E> {
    pub fn new<M: RayModel<E = E>>(pos: [f64; 3], d: [f64; 3], e: E) -> Ray<E> {
        Ray { pos, d, e, trav: 0.0, skip: NONE, bounces: 0, inv_dz: if M::RECIP_DZ { 1.0 / d[2] } else { 0.0 } }
    }
}

pub(crate) trait RayModel {
    type E: Copy;
    /// Distance to floor/ceiling as `dz * (1/d[2])` with a maintained reciprocal (`true`) or `dz / d[2]`.
    /// Both are kept because they differ in the last bit.
    const RECIP_DZ: bool;
    /// The ray ends when its bounce count reaches this value (transmissions count as bounces).
    const BOUNCE_LIMIT: u32;
    /// Check the cap before (`true`) or after (`false`) the low-energy roulette draw.
    const CAP_BEFORE_ROULETTE: bool;

    /// Start of every free-flight segment iteration.
    #[inline]
    fn on_step(&mut self) {}
    /// The ray left the scene without hitting anything.
    #[inline]
    fn on_lost(&mut self) {}
    /// Free flight of length `s` from `ray.pos` along `ray.d` (before advancing).
    fn on_segment(&mut self, ctx: &Ctx, ray: &Ray<Self::E>, s: f64);
    /// Population thinning after reaching `ray.trav`; `false` kills the ray.
    #[inline]
    fn thin(&mut self, _ray: &mut Ray<Self::E>, _rng: &mut Rng) -> bool {
        true
    }
    /// Surface hit at `ray.pos` (not yet offset) with normal `n3`, before the transmit/reflect decision.
    #[inline]
    fn on_hit(&mut self, _ctx: &Ctx, _ray: &Ray<Self::E>, _surf: usize, _n3: [f64; 3]) {}
    /// Probability of passing through `surf` (0 = opaque; no random number is drawn then).
    fn p_transmit(&self, surf: usize) -> f64;
    /// Energy factor of a transmission / of a reflection.
    fn transmit_energy(&self, e: &mut Self::E, surf: usize);
    fn reflect_energy(&self, e: &mut Self::E, surf: usize);
    /// After a transmission (`ray.pos` already behind the wall).
    #[inline]
    fn on_transmit(&mut self, _ray: &Ray<Self::E>) {}
    /// Diffuse share of reflections at `surf`.
    fn scatter(&self, surf: usize) -> f64;
    /// After a reflection was accepted (`ray.pos` offset in front of the surface, energy already scaled).
    fn on_reflect(&mut self, ctx: &Ctx, ray: &Ray<Self::E>, surf: usize, n3: [f64; 3]);
    /// Energy factor of the branch just chosen (specular or Lambert), applied right after the choice,
    /// before renormalisation and termination (per-band scattering: keeps the band expectation).
    #[inline]
    fn scatter_energy(&self, _e: &mut Self::E, _surf: usize, _specular: bool) {}
    /// Outcome of the specular/Lambert choice.
    #[inline]
    fn on_scatter(&mut self, _specular: bool) {}
    /// Energy is negligible: subject to the unbiased roulette.
    fn weak(&self, ray: &Ray<Self::E>) -> bool;
    fn double(e: &mut Self::E);
}

/// Trace `ray` until it dies. Mirrors the former per-file loops step for step.
#[inline(always)]
pub(crate) fn trace_ray<M: RayModel>(ctx: &Ctx, m: &mut M, rng: &mut Rng, mut ray: Ray<M::E>) {
    let (geo, nw, hgt) = (ctx.geo, ctx.nw, ctx.hgt);
    loop {
        m.on_step();
        // Nearest surface.
        let (pos, d, inv_dz) = (ray.pos, ray.d, ray.inv_dz);
        let vdist = |dz: f64| if M::RECIP_DZ { dz * inv_dz } else { dz / d[2] };
        let (s_vert, vsurf) = if d[2] > 1e-12 {
            (vdist(hgt - pos[2]), nw + 1)
        } else if d[2] < -1e-12 {
            (vdist(-pos[2]), nw)
        } else {
            (f64::INFINITY, NONE)
        };
        // Cap faces (horizontal, after floor and ceiling): nearest one before the floor/ceiling.
        let cap_hit = if geo.caps.is_empty() { None } else { geo.nearest_cap(pos, d, s_vert.min(1e9), ray.skip) };
        let (s, surf) = match geo.nearest3(pos, d, s_vert.min(1e9), ray.skip) {
            Some((sw, wi)) => match cap_hit {
                Some((sc, ci)) if sc < sw => (sc, ci),
                _ => (sw, wi),
            },
            None => match cap_hit {
                Some(hit) => hit,
                None => {
                    if vsurf == NONE || !s_vert.is_finite() {
                        m.on_lost();
                        return;
                    }
                    let (hx, hy) = (pos[0] + s_vert * d[0], pos[1] + s_vert * d[1]);
                    if !geo.inside_bbox(hx, hy) {
                        m.on_lost();
                        return;
                    }
                    (s_vert.max(0.0), vsurf)
                }
            },
        };

        m.on_segment(ctx, &ray, s);

        // Advance to the hit point.
        ray.trav += s;
        if ray.trav >= ctx.max_dist {
            return;
        }
        ray.pos = [pos[0] + s * d[0], pos[1] + s * d[1], pos[2] + s * d[2]];
        if !m.thin(&mut ray, rng) {
            return;
        }
        // Surface normal facing the incoming ray.
        let n3 = surface_normal(geo, surf, nw, d);
        ray.bounces += 1;
        m.on_hit(ctx, &ray, surf, n3);
        let p_t = m.p_transmit(surf);
        if p_t > 0.0 && rng.f64() < p_t {
            // Transmission: same direction, continue just behind the wall. Not a reflection.
            m.transmit_energy(&mut ray.e, surf);
            ray.pos = offset(ray.pos, n3, -OFFSET);
            m.on_transmit(&ray);
            ray.skip = surf;
            if ray.bounces >= M::BOUNCE_LIMIT {
                return;
            }
            continue;
        }
        ray.pos = offset(ray.pos, n3, OFFSET);
        m.reflect_energy(&mut ray.e, surf);
        m.on_reflect(ctx, &ray, surf, n3);

        // Next direction.
        let sc = m.scatter(surf);
        if rng.f64() < 1.0 - sc {
            ray.d = reflect(ray.d, n3);
            if M::RECIP_DZ && surf >= nw {
                ray.inv_dz = -ray.inv_dz; // floor/ceiling: dz flips sign, walls leave dz unchanged
            }
            m.scatter_energy(&mut ray.e, surf, true);
            m.on_scatter(true);
        } else {
            ray.d = lambert(n3, rng);
            if M::RECIP_DZ {
                ray.inv_dz = 1.0 / ray.d[2];
            }
            m.scatter_energy(&mut ray.e, surf, false);
            m.on_scatter(false);
        }
        if ray.bounces & 15 == 0 {
            // Re-normalise against drift.
            ray.d = normalize(ray.d);
            if M::RECIP_DZ {
                ray.inv_dz = 1.0 / ray.d[2];
            }
        }
        ray.skip = if surf < nw || surf >= nw + 2 { surf } else { NONE };

        // Termination: bounce cap, and Russian roulette once the energy is negligible.
        if M::CAP_BEFORE_ROULETTE && ray.bounces >= M::BOUNCE_LIMIT {
            return;
        }
        if m.weak(&ray) {
            if rng.f64() < 0.5 {
                M::double(&mut ray.e);
            } else {
                return;
            }
        }
        if !M::CAP_BEFORE_ROULETTE && ray.bounces >= M::BOUNCE_LIMIT {
            return;
        }
    }
}
