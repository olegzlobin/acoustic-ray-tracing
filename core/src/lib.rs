//! Acoustic core: image-source early reflections + stochastic late tail -> 4-channel FOA IR.
//! C ABI, no dependencies. Memory protocol (single-threaded):
//!   1. JS calls `alloc(bytes)`, writes inputs into wasm memory, then calls `set_scene` / compute.
//!   2. JS reads outputs through the `*_ptr/*_len` getters and COPIES them out (memory may grow
//!      and detach views on the next call). `dealloc` frees input buffers.
//! Progressive pipeline (all calls are cheap to interrupt between steps):
//!   `compute_early`  ISM taps -> short early IR (+ paths for drawing, split time), ISM tree cached
//!   `late_begin`     start a chunked ray trace;   `late_step(n)` trace n more rays
//!   `late_snapshot`  synthesise the tail from the rays traced so far -> full IR, metrics, plot
//!   `prewarm_step`   build the band-noise cache one buffer at a time
//! Coordinates and Ambisonic axis mapping are documented in `ism.rs`.

pub mod dsp;
pub(crate) mod geom;
pub(crate) mod kernel;
pub mod ism;
pub mod metrics;
pub mod heat;
pub mod plan;
pub mod rays;

use ism::{Bands, Directivity, IsmCache, Material, Path, Scene, Wall, NB};
use std::cell::RefCell;

const MAX_VIZ_PATHS: usize = 2000;
/// Longest IR; the metrics compensate the truncation (see `metrics::analyze`).
pub const MAX_IR_S: f64 = 8.0;
/// Early/late split: 80 ms after the first arrival or last ISM tap + 5 ms, capped at 150 ms.
const SPLIT_AFTER_DIRECT_S: f64 = 0.08;
const SPLIT_CAP_S: f64 = 0.15;

#[derive(Default)]
struct State {
    scene: Scene,
    scene_raw: (Vec<f32>, Vec<f32>, [f64; 4]),
    scene_ver: u64,
    /// `scene_stats` of the scene version it was computed for (it is O(n^2) in walls).
    stats: Option<(u64, Option<metrics::SceneStats>)>,
    noise: dsp::NoiseCache,
    /// One pipeline per source slot: ISM cache, early stage result and ray tracer.
    slots: Vec<Slot>,
    heat: Option<heat::HeatTracer>,
    heat_grid: (f64, f64, f64, usize, usize),
    out: Output,
    /// Third-order Ambisonics binaural decoding filters (16 ACN channels x `hrir_taps`), set by `set_hrir`.
    hrir: Vec<f32>,
    hrir_taps: usize,
    /// Source directivity of the next `compute_early` / `late_begin` / `heat_begin` (see `set_directivity`).
    dir: Directivity,
    /// Edge diffraction of the direct sound and of floor / ceiling reflections in `compute_early` (default on, see `set_diffraction`).
    diffraction: bool,
}

#[derive(Default)]
struct Slot {
    ism: IsmCache,
    early: Option<Early>,
    tracer: Option<rays::RayTracer>,
    viz: Vec<f32>,
    viz_count: usize,
    total_paths: usize,
}

const MAX_SLOTS: usize = 16;
// ---- binary layouts shared with the TypeScript side (`src/layout.ts`, checked at load via `layout`)
/// Floats per wall in `set_scene`: x1, y1, x2, y2, material index, z0, z1 (metres above the floor; z1 may be
/// huge = up to the ceiling).
const WALL_STRIDE: usize = 7;
/// Floats per material in `set_scene`: 6 alpha, 6 scattering coefficients, 6 transmission losses (dB).
const MAT_STRIDE: usize = 3 * NB;
/// Floats before the polyline of a packed ISM path: order, energy, nPts, crossedWalls.
const PATH_HEADER: usize = 4;


#[derive(Default)]
pub struct Output {
    /// 4 channels (W,Y,Z,X) concatenated, `ir_len` samples each.
    pub ir: Vec<f32>,
    pub ir_len: usize,
    /// Binaural early IR of the last `binaural_early` (L then R, equal lengths).
    pub bin: Vec<f32>,
    /// Packed ISM paths for drawing: [order, energy, nPts, crossedWalls, x0,y0, ...].
    pub viz: Vec<f32>,
    pub viz_count: usize,
    pub total_paths: usize,
    /// Metrics table, NROWS x NM.
    pub metrics: Vec<f32>,
    /// [nbins, ETC dB x 7, Schroeder dB x 7]
    pub plot: Vec<f32>,
    /// Packed traced ray polylines: [nPts, x0,y0,...].
    pub ray_viz: Vec<f32>,
    pub ray_steps: u64,
    /// Heat map accumulators: per cell [E(<50 ms), E(50-80 ms), E(>=80 ms)].
    pub heat: Vec<f32>,
    /// Packed room-analysis faces (`plan::pack_faces`).
    pub plan: Vec<f32>,
    /// Total IR length (samples) of the full IR, and the early/late split time in seconds.
    pub total_len: usize,
    pub split_s: f64,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State { diffraction: true, ..State::default() });
}

pub struct RunParams {
    pub sample_rate: f64,
    pub max_order: u32,
    /// IR length in seconds; <= 0 means automatic (see `auto_length`).
    pub ir_len_s: f64,
    pub n_rays: usize,
    pub radius: f64,
    pub viz_rays: usize,
    pub dir: Directivity,
    /// Edge diffraction of the direct sound (`set_diffraction`).
    pub diffraction: bool,
}

/// min(5 s, 1.2 x Eyring RT60 averaged over 500 Hz and 1 kHz), at least `ism_end` seconds.
/// Open geometry (no closed loop) falls back to 1 s.
pub fn auto_length(stats: Option<&metrics::SceneStats>, ism_end: f64) -> f64 {
    let t = match stats {
        Some(s) => 1.2 * 0.5 * (s.eyring(2) + s.eyring(3)),
        None => 1.0,
    };
    t.min(MAX_IR_S).max(ism_end)
}

/// Result of the early (image-source) stage.
pub struct Early {
    pub paths: Vec<Path>,
    pub stats: Option<metrics::SceneStats>,
    /// Full IR length in samples and seconds.
    pub n: usize,
    pub t_total: f64,
    pub n_ism: usize,
    /// ISM-only IR (4 channels, `n_ism` samples each).
    pub ir: Vec<f32>,
    /// ISM-only third-order IR (16 channels, `n_ism` samples each).
    pub split_s: f64,
    pub fs: f64,
}

/// Early/late split time: max(first arrival + 80 ms, last ISM tap + 5 ms), capped at 150 ms.
pub fn split_time(paths: &[Path]) -> f64 {
    let first = paths.iter().map(|p| p.delay()).fold(f64::MAX, f64::min);
    let last = paths.iter().map(|p| p.delay()).fold(0.0, f64::max);
    if paths.is_empty() {
        return SPLIT_AFTER_DIRECT_S;
    }
    (first + SPLIT_AFTER_DIRECT_S).max(last + 0.005).min(SPLIT_CAP_S)
}

/// Scale each path's band gains by the source pattern. The emission direction is the first plan leg
/// (source -> first reflection point or listener) in azimuth; its elevation magnitude is that of `dir`
/// (the unfolded path is straight, mirroring only flips the sign). Omni leaves the paths untouched.
pub fn apply_directivity(paths: &mut [Path], dir: &Directivity) {
    if dir.is_omni() {
        return;
    }
    for p in paths.iter_mut() {
        let el = p.dir[2].abs().min(1.0).asin();
        let leg = match p.pts.as_slice() {
            [a, b, ..] => Some((b[0] - a[0], b[1] - a[1])),
            _ => None,
        };
        // Degenerate (zero-length or missing) leg: fall back to the azimuth of the unfolded direction (listener -> image, so reversed).
        let az = match leg {
            Some((dx, dy)) if dx * dx + dy * dy > 1e-18 => dy.atan2(dx),
            _ if p.dir[0] * p.dir[0] + p.dir[1] * p.dir[1] > 1e-18 => (-p.dir[1]).atan2(-p.dir[0]),
            _ => dir.facing,
        };
        let cos = (el.cos() * (az - dir.facing).cos()).clamp(-1.0, 1.0);
        for b in 0..NB {
            p.gains.0[b] *= dir.gain(b, cos);
        }
    }
}

/// Stage 1: image sources (tree from `cache`) and the early IR.
pub fn compute_early(scene: &Scene, cache: &mut IsmCache, scene_ver: u64, stats: Option<metrics::SceneStats>, src: [f64; 3], lis: [f64; 3], rp: &RunParams) -> Early {
    let fs = rp.sample_rate;
    let max_order = rp.max_order.min(3);
    let (nodes, edges) = cache.tree_and_edges(scene, scene_ver, [src[0], src[1]], max_order, rp.diffraction);
    let mut paths = ism::compute_paths_with_edges(scene, nodes, edges, src, lis, max_order);
    apply_directivity(&mut paths, &rp.dir);
    let ism_end = paths.iter().map(|p| p.delay()).fold(0.0, f64::max) + 0.05;
    let t_total = if rp.ir_len_s > 0.0 { rp.ir_len_s.min(MAX_IR_S) } else { auto_length(stats.as_ref(), ism_end) };
    let n = ((t_total * fs).ceil() as usize).max(256);
    let n_ism = dsp::ir_samples(&paths, fs, t_total).min(n);
    let ir = dsp::synth_ir(&paths, fs, n_ism);
    let split_s = split_time(&paths);
    Early { paths, stats, n, t_total, n_ism, ir, split_s, fs }
}

pub fn ray_params(early: &Early, max_order: u32, rp: &RunParams) -> rays::RayParams {
    rays::RayParams {
        n_rays: rp.n_rays,
        t_max: early.n as f64 / early.fs,
        ism_order: max_order.min(3),
        radius: rp.radius,
        viz_rays: rp.viz_rays,
        dir: rp.dir,
        ..Default::default()
    }
}

/// Stage 2 result: full IR (ISM + tail from `hist`), metrics and plot data.
/// `limit_s > 0` synthesises only the first `limit_s` seconds of the IR (cheap preview for the early
/// chain); metrics and plot always cover the whole histogram.
pub fn finish(early: &Early, hist: &rays::Hist, with_tail: bool, noise: &mut dsp::NoiseCache, ray_viz: Vec<f32>, limit_s: f64) -> Output {
    let (n_full, fs) = (early.n, early.fs);
    let n = if limit_s > 0.0 { ((limit_s * fs).ceil() as usize).clamp(1, n_full) } else { n_full };
    let ni = early.n_ism.min(n);
    let mut ir = vec![0.0f32; 4 * n];
    for c in 0..4 {
        ir[c * n..c * n + ni].copy_from_slice(&early.ir[c * early.n_ism..c * early.n_ism + ni]);
    }
    if with_tail {
        let tail = dsp::synth_tail(hist, fs, n, noise);
        for (o, t) in ir.iter_mut().zip(tail.iter()) {
            *o += *t;
        }
    }
    let etc = metrics::build_etc(&early.paths, hist);
    Output {
        ir,
        ir_len: n,
        metrics: metrics::table(&etc, early.stats.as_ref()),
        plot: metrics::plot_data(&etc),
        ray_viz,
        ray_steps: hist.steps,
        total_len: n_full,
        split_s: early.split_s,
        ..Default::default()
    }
}

fn viz_paths(paths: &[Path]) -> (Vec<f32>, usize) {
    // Strongest first, capped.
    let mut idx: Vec<usize> = (0..paths.len()).collect();
    idx.sort_by(|&a, &b| paths[b].energy().partial_cmp(&paths[a].energy()).unwrap_or(std::cmp::Ordering::Equal));
    idx.truncate(MAX_VIZ_PATHS);
    let mut viz = Vec::new();
    for &i in &idx {
        let p = &paths[i];
        viz.extend_from_slice(&[p.order as f32, p.energy() as f32, p.pts.len() as f32, p.crossed as f32]);
        debug_assert_eq!(PATH_HEADER, 4);
        for pt in &p.pts {
            viz.push(pt[0] as f32);
            viz.push(pt[1] as f32);
        }
    }
    (viz, idx.len())
}

/// `scene_stats` for scene version `ver`, recomputed only when the version changed.
fn cached_stats(scene: &Scene, ver: u64, cache: &mut Option<(u64, Option<metrics::SceneStats>)>) -> Option<metrics::SceneStats> {
    match cache {
        Some((v, st)) if *v == ver => st.clone(),
        _ => {
            let st = metrics::scene_stats(scene);
            *cache = Some((ver, st.clone()));
            st
        }
    }
}

/// Whole pipeline in one go (tests / benchmarks): early + all rays + tail + metrics.
pub fn run(scene: &Scene, noise: &mut dsp::NoiseCache, src: [f64; 3], lis: [f64; 3], rp: &RunParams) -> Output {
    let mut cache = IsmCache::default();
    let early = compute_early(scene, &mut cache, 0, metrics::scene_stats(scene), src, lis, rp);
    let p = ray_params(&early, rp.max_order, rp);
    let mut tr = rays::RayTracer::new(scene, src, lis, &p);
    tr.step(rp.n_rays);
    let hist = tr.snapshot();
    let (viz, vc) = viz_paths(&early.paths);
    let mut out = finish(&early, &hist, rp.n_rays > 0, noise, tr.viz().to_vec(), 0.0);
    out.viz = viz;
    out.viz_count = vc;
    out.total_paths = early.paths.len();
    out
}

// ------------------------------------------------------------------ C ABI

/// Layout constants for the TypeScript side, by index: bands, floats per wall, floats per material,
/// path header floats, metrics columns, metrics rows, heat-map accumulators per cell, source slots, then the
/// `OUT_*` output kinds (ir, paths, metrics, plot, rayviz, heat, plan), then the floats before a packed face's ring,
/// then `OUT_BIN`.
#[no_mangle]
pub extern "C" fn layout(i: u32) -> u32 {
    [NB, WALL_STRIDE, MAT_STRIDE, PATH_HEADER, metrics::NM, metrics::NROWS, heat::BINS, MAX_SLOTS]
        .iter()
        .map(|&v| v as u32)
        .chain([OUT_IR, OUT_PATHS, OUT_METRICS, OUT_PLOT, OUT_RAYVIZ, OUT_HEAT, OUT_PLAN, plan::FACE_HEADER as u32, OUT_BIN])
        .nth(i as usize)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn alloc(bytes: usize) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(bytes.max(1), 16).unwrap();
    unsafe { std::alloc::alloc(layout) }
}

/// # Safety
/// `ptr` must come from `alloc(bytes)` with the same size.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, bytes: usize) {
    let layout = std::alloc::Layout::from_size_align(bytes.max(1), 16).unwrap();
    std::alloc::dealloc(ptr, layout);
}

/// walls: n_walls x [x1,y1,x2,y2,materialId,z0,z1] f32 (z0/z1 are clamped to the room height); mats: n_mats x [a125..a4k, s125..s4k, TL125..TL4k]
/// f32 (18 each; TL = transmission loss in dB, +inf = opaque). `transmission` = 0 treats every
/// material as opaque (tau = 0), otherwise tau = 10^(-TL/10) and alpha_eff = max(alpha, tau).
/// Identical scenes keep the scene version, so cached image-source trees stay valid.
///
/// # Safety
/// Pointers must reference valid f32 arrays of the stated sizes.
#[no_mangle]
pub unsafe extern "C" fn set_scene(
    walls_ptr: *const f32,
    n_walls: usize,
    mats_ptr: *const f32,
    n_mats: usize,
    height: f64,
    floor_mat: u32,
    ceil_mat: u32,
    transmission: u32,
) {
    let w = std::slice::from_raw_parts(walls_ptr, n_walls * WALL_STRIDE);
    let m = std::slice::from_raw_parts(mats_ptr, n_mats * MAT_STRIDE);
    let raw = (w.to_vec(), m.to_vec(), [height, floor_mat as f64, ceil_mat as f64, (transmission != 0) as u32 as f64]);
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if s.scene_raw == raw && s.scene_ver > 0 {
            return;
        }
        let walls: Vec<Wall> = w
            .chunks_exact(WALL_STRIDE)
            .map(|c| Wall::partial([c[0] as f64, c[1] as f64], [c[2] as f64, c[3] as f64], c[4] as usize, c[5] as f64, c[6] as f64))
            .collect();
        let materials = m
            .chunks_exact(MAT_STRIDE)
            .map(|c| {
                let alpha = Bands::from_fn(|b| c[b] as f64);
                let tau = if transmission != 0 { Bands::from_fn(|b| ism::tl_to_tau(c[2 * NB + b] as f64)) } else { Bands::ZERO };
                Material { alpha, scatter: Bands::from_fn(|b| c[NB + b] as f64), tau }
            })
            .collect();
        s.scene = Scene::new(walls, materials, height, floor_mat as usize, ceil_mat as usize);
        s.scene_raw = raw;
        s.scene_ver += 1;
    });
}

/// Room analysis of a wall list (rows as in `set_scene`; the material column is ignored): result in
/// `out_ptr(OUT_PLAN)`. Independent of the scene state. Returns the number of faces.
///
/// # Safety
/// `walls_ptr` must reference `n_walls * WALL_STRIDE` valid f32.
#[no_mangle]
pub unsafe extern "C" fn plan_analyze(walls_ptr: *const f32, n_walls: usize) -> u32 {
    let w = std::slice::from_raw_parts(walls_ptr, n_walls * WALL_STRIDE);
    let walls: Vec<Wall> = w.chunks_exact(WALL_STRIDE).map(|c| Wall::full([c[0] as f64, c[1] as f64], [c[2] as f64, c[3] as f64], 0)).collect();
    let plan = plan::analyze(&walls);
    STATE.with(|s| s.borrow_mut().out.plan = plan::pack_faces(&plan));
    plan.faces.len() as u32
}

fn rp(sample_rate: f64, max_order: u32, ir_len_s: f64, dir: Directivity, diffraction: bool) -> RunParams {
    RunParams { sample_rate, max_order, ir_len_s, n_rays: 0, radius: 0.4, viz_rays: 0, dir, diffraction }
}

/// Stage 1. Returns the number of valid ISM paths. `ir_len_s <= 0` selects the automatic IR length.
/// Output: early IR (`ir_*`, `ir_len()` samples), ISM paths (`paths_*`), `split_s()`, `total_len()`.
#[export_name = "compute_early"]
pub extern "C" fn ffi_compute_early(
    slot: u32,
    sx: f64,
    sy: f64,
    sz: f64,
    lx: f64,
    ly: f64,
    lz: f64,
    sample_rate: f64,
    max_order: u32,
    ir_len_s: f64,
) -> u32 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = &mut *s;
        let p = rp(sample_rate, max_order, ir_len_s, st.dir, st.diffraction);
        let ver = st.scene_ver;
        let stats = cached_stats(&st.scene, st.scene_ver, &mut st.stats);
        let State { scene, slots, out, .. } = st;
        while slots.len() <= (slot as usize).min(MAX_SLOTS - 1) {
            slots.push(Slot::default());
        }
        let sl = &mut slots[(slot as usize).min(MAX_SLOTS - 1)];
        let early = compute_early(scene, &mut sl.ism, ver, stats, [sx, sy, sz], [lx, ly, lz], &p);
        let (viz, vc) = viz_paths(&early.paths);
        sl.viz = viz.clone();
        sl.viz_count = vc;
        sl.total_paths = early.paths.len();
        *out = Output {
            ir: early.ir.clone(),
            ir_len: early.n_ism,
            viz,
            viz_count: vc,
            total_paths: early.paths.len(),
            total_len: early.n,
            split_s: early.split_s,
            ..Default::default()
        };
        sl.tracer = None;
        let n = early.paths.len() as u32;
        sl.early = Some(early);
        n
    })
}

/// Source directivity for the following `compute_early`, `late_begin` and `heat_begin`: facing azimuth
/// (radians CCW from +x), `NB` per-band alphas and the gain floor. See `ism::Directivity`.
/// # Safety
/// `alpha_ptr` must point to `NB` (6) f32 values.
#[no_mangle]
pub unsafe extern "C" fn set_directivity(facing: f64, alpha_ptr: *const f32, floor: f64) {
    let a = std::slice::from_raw_parts(alpha_ptr, NB);
    STATE.with(|s| s.borrow_mut().dir = Directivity { facing, alpha: std::array::from_fn(|b| a[b] as f64), floor });
}

/// Edge diffraction of the direct sound and of floor / ceiling reflections for the following `compute_early` (nonzero = on, the default).
#[no_mangle]
pub extern "C" fn set_diffraction(on: u32) {
    STATE.with(|s| s.borrow_mut().diffraction = on != 0);
}

/// Load the binaural decoding filters: 16 ACN channels of `taps` samples each, at the sample rate the
/// following requests use.
/// # Safety
/// `ptr` must point to `16 * taps` floats.
#[no_mangle]
pub unsafe extern "C" fn set_hrir(ptr: *const f32, taps: usize) {
    let f = std::slice::from_raw_parts(ptr, 16 * taps).to_vec();
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.hrir = f;
        s.hrir_taps = taps;
    });
}

/// Binaural early IR of a slot's last `compute_early` for a head turned by `yaw`: the image-source paths
/// through the HRTFs, windowed like the early part (1 until `split - fade_s`, raised-cosine to 0 at the
/// split). Returns the samples per ear (0 without filters or an early result); see `OUT_BIN`.
#[no_mangle]
pub extern "C" fn binaural_early(slot: u32, yaw: f64, fade_s: f64) -> u32 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = &mut *s;
        let taps = st.hrir_taps;
        let Some(early) = st.slots.get((slot as usize).min(MAX_SLOTS - 1)).and_then(|sl| sl.early.as_ref()) else {
            st.out.bin.clear();
            return 0;
        };
        if taps == 0 {
            st.out.bin.clear();
            return 0;
        }
        let (fs, split) = (early.fs, early.split_s);
        let start = split - fade_s;
        let win = |t: f64| {
            if t <= start {
                1.0
            } else if t >= split {
                0.0
            } else {
                0.5 * (1.0 + (std::f64::consts::PI * (t - start) / fade_s.max(1e-9)).cos())
            }
        };
        let n = (split * fs).ceil() as usize + 1;
        st.out.bin = dsp::synth_binaural(&early.paths, fs, n, &st.hrir, taps, yaw, win);
        (n + taps) as u32
    })
}

/// Stage 2a: start a chunked ray trace for the pose of the last `compute_early`.
#[no_mangle]
pub extern "C" fn late_begin(slot: u32, sx: f64, sy: f64, sz: f64, lx: f64, ly: f64, lz: f64, max_order: u32, n_rays: u32, radius: f64, viz_rays: u32) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = &mut *s;
        let State { scene, slots, .. } = st;
        let Some(sl) = slots.get_mut((slot as usize).min(MAX_SLOTS - 1)) else { return };
        let Some(early) = sl.early.as_ref() else { return };
        // radius <= 0: automatic. The sphere must grow with the room, otherwise big halls get too few
        // detections: 0.4 m at 210 m^3, scaling with the cube root of the volume (0.3 .. 2.5 m).
        let radius = if radius > 0.0 { radius } else { early.stats.as_ref().map_or(0.4, |s| (0.4 * (s.volume / 210.0).cbrt()).clamp(0.3, 2.5)) };
        let p = RunParams { sample_rate: early.fs, max_order, ir_len_s: 0.0, n_rays: n_rays as usize, radius, viz_rays: viz_rays as usize, dir: st.dir, diffraction: st.diffraction };
        let rpar = ray_params(early, max_order, &p);
        sl.tracer = Some(rays::RayTracer::new(scene, [sx, sy, sz], [lx, ly, lz], &rpar));
    })
}

/// Stage 2b: trace up to `count` more rays; returns the number traced so far.
#[no_mangle]
pub extern "C" fn late_step(slot: u32, count: u32) -> u32 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.slots.get_mut((slot as usize).min(MAX_SLOTS - 1)).and_then(|sl| sl.tracer.as_mut()).map_or(0, |t| t.step(count as usize) as u32)
    })
}

/// Stage 2c: synthesise the tail from the rays traced so far. `limit_s > 0` restricts the IR to its
/// first `limit_s` seconds (cheap preview; `ir_len()` < `total_len()`). Output: full IR (`ir_len()` =
/// total samples), `OUT_METRICS`, `OUT_PLOT`, `OUT_RAYVIZ`. Valid at any time, also for partial traces
/// (the histogram is rescaled to the full ray count). Returns the number of rays used.
#[no_mangle]
pub extern "C" fn late_snapshot(slot: u32, limit_s: f64) -> u32 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = &mut *s;
        let State { slots, noise, out, .. } = st;
        let Some(sl) = slots.get_mut((slot as usize).min(MAX_SLOTS - 1)) else { return 0 };
        let Some(early) = sl.early.as_ref() else { return 0 };
        let (hist, viz, done) = match sl.tracer.as_ref() {
            Some(t) => (t.snapshot(), t.viz().to_vec(), t.done()),
            None => (rays::Hist::empty((early.t_total / rays::BIN_S).ceil() as usize + 1), Vec::new(), 0),
        };
        let mut o = finish(early, &hist, done > 0, noise, viz, limit_s);
        o.viz = sl.viz.clone();
        o.viz_count = sl.viz_count;
        o.total_paths = sl.total_paths;
        *out = o;
        done as u32
    })
}

/// Pre-warm the band-noise cache for `max_len_s` seconds: call repeatedly until it returns 0.
/// Each call builds one of the 24 noise buffers (about 10 ms).
#[no_mangle]
pub extern "C" fn prewarm_step(sample_rate: f64, max_len_s: f64) -> u32 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.noise.prepare(sample_rate, (max_len_s * sample_rate) as usize);
        s.noise.build_step() as u32
    })
}

/// Heat map, step 1: start a track-length ray trace from the source for the ear-height slab.
/// Grid: cells >= `min_cell` m, at most `max_cells` cells, covering the walls' bounding box.
/// Returns nx * 65536 + ny (0 if there are no walls); the geometry is read with `heat_x0()` etc.
#[no_mangle]
pub extern "C" fn heat_begin(sx: f64, sy: f64, sz: f64, ear_z: f64, n_rays: u32, min_cell: f64, max_cells: u32) -> u32 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = &mut *s;
        if st.scene.walls.is_empty() {
            st.heat = None;
            return 0;
        }
        let bbox = rays::Geo::new(&st.scene, 12).bbox;
        let (x0, y0, cell, nx, ny) = heat::grid_for(bbox, min_cell.max(0.1), max_cells as usize);
        let stats = cached_stats(&st.scene, st.scene_ver, &mut st.stats);
        let t_max = auto_length(stats.as_ref(), 0.1).min(3.0);
        let p = heat::HeatParams { x0, y0, cell, nx, ny, ear_z, n_rays: n_rays as usize, t_max, seed: 0x1234_5678_9ABC_DEF1, dir: st.dir };
        st.heat_grid = (x0, y0, cell, nx, ny);
        st.heat = Some(heat::HeatTracer::new(&st.scene, [sx, sy, sz], &p));
        (nx * 65536 + ny) as u32
    })
}

/// Heat map, step 2: trace up to `count` more rays; returns the number traced so far.
#[no_mangle]
pub extern "C" fn heat_step(count: u32) -> u32 {
    STATE.with(|s| s.borrow_mut().heat.as_mut().map_or(0, |h| h.step(count as usize) as u32))
}

/// Heat map, step 3: copy the (rescaled) accumulators to `out_ptr(OUT_HEAT)`.
#[no_mangle]
pub extern "C" fn heat_snapshot() -> u32 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = &mut *s;
        let Some(h) = st.heat.as_ref() else { return 0 };
        st.out.heat = h.snapshot();
        h.done() as u32
    })
}

/// Grid origin x, origin y, cell size of the current heat map.
#[no_mangle]
pub extern "C" fn heat_x0() -> f64 {
    STATE.with(|s| s.borrow().heat_grid.0)
}
#[no_mangle]
pub extern "C" fn heat_y0() -> f64 {
    STATE.with(|s| s.borrow().heat_grid.1)
}
#[no_mangle]
pub extern "C" fn heat_cell() -> f64 {
    STATE.with(|s| s.borrow().heat_grid.2)
}

/// Output buffers readable through `out_ptr(kind)` / `out_len(kind)` (f32 elements); `OUT_*` kinds are
/// mirrored by `OutKind` in `src/layout.ts`.
/// IR channels (W,Y,Z,X) concatenated, 4 x `ir_len()` samples.
const OUT_IR: u32 = 0;
/// Packed ISM path list: per path [order, energy, nPts, crossedWalls, x0, y0, ...].
const OUT_PATHS: u32 = 1;
/// Metrics table, 7 rows (bands + broadband) x 8 columns (EDT,T20,T30,C50,C80,D50,Sabine,Eyring).
const OUT_METRICS: u32 = 2;
/// [nbins, ETC dB x 7 rows, Schroeder dB x 7 rows].
const OUT_PLOT: u32 = 3;
/// Traced ray polylines: [nPts, x0, y0, ...].
const OUT_RAYVIZ: u32 = 4;
/// Heat map accumulators, 3 floats per cell (row-major, y up).
const OUT_HEAT: u32 = 5;
/// Room-analysis faces: `[nFaces, per face region, depth, area, nPts, x0, y0, ...]`.
const OUT_PLAN: u32 = 6;
/// Binaural early IR of the last `binaural_early`: L then R, `out_len / 2` samples each.
const OUT_BIN: u32 = 7;

fn out_slice(o: &Output, kind: u32) -> &[f32] {
    match kind {
        OUT_IR => &o.ir,
        OUT_PATHS => &o.viz,
        OUT_METRICS => &o.metrics,
        OUT_PLOT => &o.plot,
        OUT_RAYVIZ => &o.ray_viz,
        OUT_HEAT => &o.heat,
        OUT_PLAN => &o.plan,
        OUT_BIN => &o.bin,
        _ => &[],
    }
}
/// Address of output buffer `kind` (valid until the next call that recomputes it).
#[no_mangle]
pub extern "C" fn out_ptr(kind: u32) -> *const f32 {
    STATE.with(|s| out_slice(&s.borrow().out, kind).as_ptr())
}
/// Length in f32 elements of output buffer `kind`.
#[no_mangle]
pub extern "C" fn out_len(kind: u32) -> u32 {
    STATE.with(|s| out_slice(&s.borrow().out, kind).len() as u32)
}
/// Samples per channel of the current `ir` output.
#[no_mangle]
pub extern "C" fn ir_len() -> u32 {
    STATE.with(|s| s.borrow().out.ir_len as u32)
}
/// Samples per channel of the FULL IR (ISM + tail) for the current pose.
#[no_mangle]
pub extern "C" fn total_len() -> u32 {
    STATE.with(|s| s.borrow().out.total_len as u32)
}
/// Early/late split time (seconds).
#[no_mangle]
pub extern "C" fn split_s() -> f64 {
    STATE.with(|s| s.borrow().out.split_s)
}
/// Total ray-tracer segment count (for benchmarking).
#[no_mangle]
pub extern "C" fn ray_steps() -> f64 {
    STATE.with(|s| s.borrow().out.ray_steps as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn box_scene(w: f64, d: f64, h: f64, alpha: f64, s: f64) -> Scene {
        let c = [[0.0, 0.0], [w, 0.0], [w, d], [0.0, d]];
        let walls = (0..4).map(|i| Wall::full(c[i], c[(i + 1) % 4], 0)).collect();
        let mat = Material::new(Bands::splat(alpha), s);
        Scene { walls, materials: vec![mat], height: h, floor_mat: 0, ceil_mat: 0, caps: vec![] }
    }

    fn l_scene() -> Scene {
        let pts = [[0.0, 0.0], [12.0, 0.0], [12.0, 5.0], [5.0, 5.0], [5.0, 12.0], [0.0, 12.0]];
        let walls = (0..6).map(|i| Wall::full(pts[i], pts[(i + 1) % 6], 0)).collect();
        let mat = Material::new(Bands::splat(0.05), 0.1);
        Scene { walls, materials: vec![mat], height: 3.0, floor_mat: 0, ceil_mat: 0, caps: vec![] }
    }

    fn params(n_rays: usize) -> RunParams {
        RunParams { sample_rate: 48000.0, max_order: 3, ir_len_s: 0.0, n_rays, radius: 0.4, viz_rays: 0, dir: Directivity::default(), diffraction: true }
    }

    #[test]
    fn bench_rays() {
        for (name, sc, src, lis) in [
            ("shoebox plaster-ish a=.05", box_scene(10.0, 7.0, 3.0, 0.05, 0.1), [2.5, 3.5, 1.5], [7.0, 3.5, 1.2]),
            ("L-room a=.05", l_scene(), [9.5, 2.5, 1.5], [2.5, 9.5, 1.2]),
        ] {
            for n in [0usize, 2000, 20000, 50000] {
                let mut noise = dsp::NoiseCache::default();
                // First call includes building the noise cache; time the second one.
                let _ = run(&sc, &mut noise, src, lis, &params(n));
                let t = std::time::Instant::now();
                let o = run(&sc, &mut noise, src, lis, &params(n));
                println!("native {name}: rays {n:6}: {:7.1} ms  IR {:.2}s steps {}", t.elapsed().as_secs_f64() * 1e3, o.ir_len as f64 / 48000.0, o.ray_steps);
                assert!(o.ir.iter().all(|v| v.is_finite()));
            }
        }
    }

    #[test]
    fn bench_trace_concrete() {
        // Ray loop only (no tail synthesis): concrete-like surfaces, 5 s, 20k rays.
        let conc = |sc: Scene| Scene { materials: vec![Material::new(Bands::splat(0.02), 0.05)], ..sc };
        for (name, sc, src, lis) in [
            ("shoebox", conc(box_scene(10.0, 7.0, 3.0, 0.0, 0.0)), [2.5, 3.5, 1.5], [7.0, 3.5, 1.2]),
            ("L-room", conc(l_scene()), [9.5, 2.5, 1.5], [2.5, 9.5, 1.2]),
        ] {
            let p = rays::RayParams { n_rays: 20000, t_max: 5.0, ..Default::default() };
            let t = std::time::Instant::now();
            let (h, _) = rays::trace(&sc, src, lis, &p);
            println!("trace concrete {name}: 20k rays, 5 s: {:.1} ms, {} steps", t.elapsed().as_secs_f64() * 1e3, h.steps);
        }
    }

    #[test]
    fn chunked_trace_is_identical_to_single_run() {
        let sc = box_scene(10.0, 7.0, 3.0, 0.1, 0.3);
        let (src, lis) = ([2.5, 3.5, 1.5], [7.0, 3.5, 1.2]);
        let p = rays::RayParams { n_rays: 6000, t_max: 1.0, ..Default::default() };
        let (single, _) = rays::trace(&sc, src, lis, &p);
        let mut tr = rays::RayTracer::new(&sc, src, lis, &p);
        for chunk in [500, 1000, 1, 2499, 2000] {
            tr.step(chunk);
        }
        assert_eq!(tr.done(), 6000);
        let chunked = tr.snapshot();
        assert_eq!(single.e, chunked.e, "chunked histogram differs from single-run histogram");
    }

    #[test]
    fn prefix_snapshot_is_statistically_consistent() {
        // A 2k-ray prefix (rescaled) must represent the same field as the full 20k run.
        let sc = box_scene(10.0, 7.0, 3.0, 0.2, 0.5);
        let (src, lis) = ([2.5, 3.5, 1.5], [7.0, 3.5, 1.2]);
        let p = rays::RayParams { n_rays: 20000, t_max: 1.0, ..Default::default() };
        let mut tr = rays::RayTracer::new(&sc, src, lis, &p);
        tr.step(2000);
        let coarse = tr.snapshot();
        tr.step(18000);
        let fine = tr.snapshot();
        // Compare band energy in 50 ms windows (1 kHz band).
        let win = |h: &rays::Hist, a: usize, b: usize| -> f64 { (a..b).map(|k| h.e[k * NB + 3]).sum() };
        for (a, b) in [(0, 50), (50, 100), (100, 200), (200, 400)] {
            let (c, f) = (win(&coarse, a, b), win(&fine, a, b));
            println!("window {a}-{b} ms: coarse {c:.4e} fine {f:.4e} ratio {:.3}", c / f);
            // The late window is 14 dB down with only ~2k (thinned) rays in the coarse run: looser.
            let tol = if a >= 200 { 0.4 } else { 0.2 };
            assert!((c / f - 1.0).abs() < tol, "window {a}-{b}: {c} vs {f}");
        }
    }

    #[test]
    fn ism_tree_cache_reuse_and_timing() {
        // 40-wall polygon room: tree build vs validation-only (listener move) cost, order 3.
        let n = 40usize;
        let pts: Vec<[f64; 2]> = (0..n).map(|i| {
            let a = 2.0 * std::f64::consts::PI * i as f64 / n as f64;
            [8.0 * a.cos(), 8.0 * a.sin()]
        }).collect();
        let walls = (0..n).map(|i| Wall::full(pts[i], pts[(i + 1) % n], 0)).collect();
        let sc = Scene { walls, materials: vec![Material::new(Bands::splat(0.1), 0.0)], height: 3.0, floor_mat: 0, ceil_mat: 0, caps: vec![] };
        let rpar = |_: ()| params(0);
        let mut cache = ism::IsmCache::default();
        let src = [1.0, 1.0, 1.5];
        let t = std::time::Instant::now();
        let e1 = compute_early(&sc, &mut cache, 1, metrics::scene_stats(&sc), src, [-2.0, 3.0, 1.2], &rpar(()));
        let t_first = t.elapsed();
        let t = std::time::Instant::now();
        let e2 = compute_early(&sc, &mut cache, 1, metrics::scene_stats(&sc), src, [-2.5, 2.0, 1.2], &rpar(()));
        let t_second = t.elapsed();
        assert_eq!(cache.builds, 1, "listener move must reuse the tree");
        compute_early(&sc, &mut cache, 1, metrics::scene_stats(&sc), [1.5, 1.0, 1.5], [-2.5, 2.0, 1.2], &rpar(()));
        assert_eq!(cache.builds, 2, "source move rebuilds");
        compute_early(&sc, &mut cache, 2, metrics::scene_stats(&sc), [1.5, 1.0, 1.5], [-2.5, 2.0, 1.2], &rpar(()));
        assert_eq!(cache.builds, 3, "scene change rebuilds");
        // Cached result equals a from-scratch computation.
        let fresh = ism::compute_paths(&sc, src, [-2.5, 2.0, 1.2], 3);
        assert_eq!(fresh.len(), e2.paths.len());
        // Timing of the stages separately.
        let t = std::time::Instant::now();
        let nodes = ism::build_tree(&sc.walls, [1.0, 1.0], 3);
        let t_build = t.elapsed();
        let t = std::time::Instant::now();
        let _ = ism::compute_paths_with_tree(&sc, &nodes, src, [-2.5, 2.0, 1.2], 3);
        let t_valid = t.elapsed();
        println!("ISM 40 walls order 3: {} nodes, {} paths; tree build {:?}, validation only {:?}; early call first {:?} (tree built) vs listener-move {:?}", nodes.len(), e1.paths.len(), t_build, t_valid, t_first, t_second);
    }

    #[test]
    fn tail_energy_follows_histogram() {
        let sc = box_scene(10.0, 7.0, 3.0, 0.2, 0.5);
        let (src, lis) = ([2.5, 3.5, 1.5], [7.0, 3.5, 1.2]);
        let p = rays::RayParams { n_rays: 20000, t_max: 0.8, ..Default::default() };
        let (hist, _) = rays::trace(&sc, src, lis, &p);
        let fs = 48000.0;
        let n = (0.8 * fs) as usize;
        let mut nc = dsp::NoiseCache::default();
        let tail = dsp::synth_tail(&hist, fs, n, &mut nc);
        // Limited synthesis equals the prefix of the full one.
        let part = dsp::synth_tail(&hist, fs, 4800, &mut nc);
        assert_eq!(&tail[..4800], &part[..4800]);
        let spb = fs / 1000.0;
        for (a, b) in [(20usize, 60usize), (60, 150), (150, 300), (300, 600)] {
            let w: f64 = tail[(a as f64 * spb) as usize..(b as f64 * spb) as usize].iter().map(|v| (*v as f64).powi(2)).sum();
            let h: f64 = (a..b).map(|k| (0..NB).map(|bd| hist.e[k * NB + bd]).sum::<f64>()).sum();
            println!("tail {a}-{b} ms: synthesized W energy {w:.4e}, histogram {h:.4e}, ratio {:.3}", w / h);
            assert!((w / h - 1.0).abs() < 0.15);
        }
    }

    #[test]
    fn concert_hall_traces_every_ray() {
        // Regression check for the "final 38 ms" observation: a big, fairly absorbing hall is just
        // cheap (few bounces per ray), all rays are traced and the final histogram is complete.
        let c = [[0.0, 0.0], [40.0, 0.0], [40.0, 25.0], [0.0, 25.0]];
        let walls = (0..4).map(|i| Wall::full(c[i], c[(i + 1) % 4], 0)).collect();
        let plaster = Material::new([0.01, 0.02, 0.02, 0.03, 0.04, 0.05], 0.1);
        let seats = Material::new([0.39, 0.57, 0.8, 0.94, 0.92, 0.87], 0.5);
        let sc = Scene { walls, materials: vec![plaster, seats], height: 18.0, floor_mat: 1, ceil_mat: 0, caps: vec![] };
        let p = rays::RayParams { n_rays: 20000, t_max: 2.9, radius: 1.7, ..Default::default() };
        let t = std::time::Instant::now();
        let mut tr = rays::RayTracer::new(&sc, [5.0, 12.5, 1.5], [25.0, 12.5, 1.2], &p);
        let done = tr.step(20000);
        let h = tr.snapshot();
        println!("concert hall: {done} rays, {} segments ({:.1} per ray), {} lost, {:.1} ms", h.steps, h.steps as f64 / done as f64, h.lost, t.elapsed().as_secs_f64() * 1e3);
        assert_eq!(done, 20000);
        assert_eq!(h.lost, 0);
        assert!(h.e.iter().sum::<f64>() > 0.0);
    }

    #[test]
    fn shoebox_t30_matches_eyring() {
        let sc = box_scene(10.0, 7.0, 3.0, 0.2, 0.5);
        let mut noise = dsp::NoiseCache::default();
        let o = run(&sc, &mut noise, [2.5, 3.5, 1.5], [7.0, 3.5, 1.2], &params(50000));
        let st = metrics::scene_stats(&sc).unwrap();
        for b in [2usize, 3] {
            let t30 = o.metrics[b * metrics::NM + 2] as f64;
            let eyr = st.eyring(b);
            let sab = st.sabine(b);
            println!("band {b}: T30 {t30:.3}  Eyring {eyr:.3}  Sabine {sab:.3}  EDT {:.3}", o.metrics[b * metrics::NM]);
            assert!((t30 / eyr - 1.0).abs() < 0.15, "T30 {t30} vs Eyring {eyr}");
        }
    }

    #[test]
    fn late_energy_matches_diffuse_field_estimate() {
        // Total detected energy (ISM + rays) in the units where a tap's energy is 1/r^2 and the
        // source energy is 4 pi. The receiver sphere measures the fluence rate c*w, so a diffuse
        // field released with E0 = 4 pi contributes  integral c w dt = 4 E0 / A = 16 pi / A.
        // Barron's revised theory removes the part before the first reflections:
        // E_rev = 16 pi / A * exp(-13.8 t_d / T60), t_d = direct arrival time.
        let sc = box_scene(10.0, 7.0, 3.0, 0.2, 0.5);
        let (src, lis) = ([2.5, 3.5, 1.5], [7.0, 3.5, 1.2]);
        let paths = ism::compute_paths(&sc, src, lis, 3);
        let p = rays::RayParams { n_rays: 50000, t_max: 2.0, ..Default::default() };
        let (hist, _) = rays::trace(&sc, src, lis, &p);
        let etc = metrics::build_etc(&paths, &hist);
        let st = metrics::scene_stats(&sc).unwrap();
        let b = 3; // 1 kHz (air is small)
        let total: f64 = etc.e[b * etc.nbins..(b + 1) * etc.nbins].iter().sum();
        let r_direct2 = (4.5f64).powi(2) + 0.09;
        let t_d = r_direct2.sqrt() / 343.0;
        let a_eff = -st.surface * (1.0f64 - st.absorption[b] / st.surface).ln();
        let expect = 1.0 / r_direct2 + 16.0 * std::f64::consts::PI / a_eff * (-13.8 * t_d / st.eyring(b)).exp();
        println!("total {total:.4}  expected {expect:.4}  ratio {:.3}", total / expect);
        assert!((total / expect - 1.0).abs() < 0.15);
    }

    const SPEAKER: [f64; NB] = [0.95, 0.85, 0.7, 0.55, 0.4, 0.3];

    fn speaker(facing: f64) -> Directivity {
        Directivity { facing, alpha: SPEAKER, floor: 0.1 }
    }

    fn early_with(dir: Directivity, src: [f64; 3], lis: [f64; 3]) -> Early {
        let sc = box_scene(10.0, 7.0, 3.0, 0.2, 0.0);
        let rp = RunParams { dir, ..params(0) };
        compute_early(&sc, &mut IsmCache::default(), 0, None, src, lis, &rp)
    }

    #[test]
    fn omni_directivity_leaves_paths_and_rays_unchanged() {
        let (src, lis) = ([2.5, 3.5, 1.5], [7.0, 2.0, 1.2]);
        let base = early_with(Directivity::default(), src, lis);
        let turned = early_with(Directivity { facing: 2.0, ..Default::default() }, src, lis);
        assert_eq!(base.paths.len(), turned.paths.len());
        for (a, b) in base.paths.iter().zip(&turned.paths) {
            assert_eq!(a.gains, b.gains);
        }
        assert_eq!(base.ir, turned.ir);
        let sc = box_scene(10.0, 7.0, 3.0, 0.2, 0.0);
        let p = rays::RayParams { n_rays: 3000, t_max: 0.5, ..Default::default() };
        let q = rays::RayParams { dir: Directivity { facing: 2.0, ..Default::default() }, ..p };
        let (h1, _) = rays::trace(&sc, src, lis, &p);
        let (h2, _) = rays::trace(&sc, src, lis, &q);
        assert_eq!(h1.e, h2.e);
    }

    #[test]
    fn speaker_facing_listener_keeps_direct_gain_and_facing_away_hits_floor() {
        let (src, lis) = ([2.5, 3.5, 1.5], [7.5, 3.5, 1.5]); // same height: theta = 0 toward the listener
        let base = early_with(Directivity::default(), src, lis);
        let direct = |e: &Early| e.paths.iter().find(|p| p.order == 0).unwrap().gains;
        let to = early_with(speaker(0.0), src, lis);
        for b in 0..NB {
            assert!((direct(&to).0[b] - direct(&base).0[b]).abs() < 1e-12, "band {b}");
        }
        let away = early_with(speaker(std::f64::consts::PI), src, lis);
        assert!((direct(&away).0[5] / direct(&base).0[5] - 0.1).abs() < 1e-12);
        // 125 Hz: 0.95 - 0.05 = 0.9
        assert!((direct(&away).0[0] / direct(&base).0[0] - 0.9).abs() < 1e-12);
    }

    #[test]
    fn ism_gains_follow_first_leg_and_elevation() {
        let (src, lis) = ([2.5, 3.5, 1.5], [7.0, 2.0, 1.2]);
        let facing = 0.7;
        let base = early_with(Directivity::default(), src, lis);
        let dir = speaker(facing);
        let d = early_with(dir, src, lis);
        assert!(d.paths.len() > 10);
        for (a, b) in base.paths.iter().zip(&d.paths) {
            let (p0, p1) = (a.pts[0], a.pts[1]);
            let az = (p1[1] - p0[1]).atan2(p1[0] - p0[0]);
            let el = a.dir[2].abs().asin();
            let cos = el.cos() * (az - facing).cos();
            for k in 0..NB {
                let g = (SPEAKER[k] + (1.0 - SPEAKER[k]) * cos).max(0.1);
                assert!((b.gains.0[k] - a.gains.0[k] * g).abs() < 1e-12 * a.gains.0[k].max(1e-30), "order {} band {k}", a.order);
            }
        }
    }

    #[test]
    fn directional_rays_reduce_energy_behind_the_source() {
        let sc = box_scene(10.0, 7.0, 3.0, 0.2, 0.0);
        let (src, lis) = ([2.5, 3.5, 1.5], [7.0, 3.5, 1.2]);
        let tot = |dir: Directivity| {
            let p = rays::RayParams { n_rays: 20000, t_max: 0.4, dir, ..Default::default() };
            let (h, _) = rays::trace(&sc, src, lis, &p);
            (0..h.nbins).map(|k| h.e[k * NB + 5]).sum::<f64>()
        };
        let (omni, fwd) = (tot(Directivity::default()), tot(speaker(0.0)));
        // Mean over the sphere of g^2 at 4 kHz is well below 1 for the speaker pattern.
        assert!(fwd < 0.8 * omni, "{fwd} vs {omni}");
        assert!(fwd > 0.1 * omni);
    }

    #[test]
    fn no_double_counting_of_ism_paths() {
        // Purely specular walls: every ray of order <= 3 is an ISM path, so the histogram must stay
        // empty until the earliest order-4 arrival (minus the receiver sphere's time spread).
        let sc = box_scene(10.0, 7.0, 3.0, 0.2, 0.0);
        let (src, lis) = ([2.5, 3.5, 1.5], [7.0, 3.5, 1.2]);
        let paths = ism::compute_paths(&sc, src, lis, 4);
        let t4 = paths.iter().filter(|p| p.order == 4).map(|p| p.delay()).fold(f64::MAX, f64::min);
        let p = rays::RayParams { n_rays: 40000, t_max: 0.3, ism_order: 3, ..Default::default() };
        let (hist, _) = rays::trace(&sc, src, lis, &p);
        let guard = ((t4 - 0.4 / 343.0) / rays::BIN_S) as usize - 1;
        let early: f64 = hist.e[..guard * NB].iter().sum();
        let after: f64 = hist.e[guard * NB..].iter().sum();
        println!("earliest order-4 path {:.1} ms; hist energy before {early:.3e}, after {after:.3e}", t4 * 1e3);
        assert!(early == 0.0, "energy before first order-4 arrival: {early}");
        assert!(after > 0.0);
    }
}


#[cfg(test)]
mod tx_tests;

#[cfg(test)]
mod height_tests;

#[cfg(test)]
mod diffraction_tests;

#[cfg(test)]
mod scatter_tests;

#[cfg(test)]
mod utd_tests;
