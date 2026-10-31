//! Energy-time curve, Schroeder decay, room-acoustic metrics and Sabine/Eyring predictions.

use crate::ism::{Bands, Path, Scene, AIR_DB_PER_M, NB};
use crate::rays::{Hist, BIN_S};

/// Columns of the metrics table.
pub const NM: usize = 8; // EDT, T20, T30, C50, C80, D50, Sabine, Eyring
/// Rows: 6 octave bands + broadband.
pub const NROWS: usize = NB + 1;

/// ETC rows 0..NB = bands, row NB = broadband (sum of bands). Energies per 1 ms bin.
pub struct Etc {
    pub nbins: usize,
    pub e: Vec<f64>, // [row][bin]
}

/// Frequencies per octave band of the coherent group sum (as the diffraction band gains: log-spaced over [fc / sqrt 2, fc sqrt 2]).
const ETC_SUB: usize = 8;

/// Energy-time curve of the paths and the histogram. Paths without a coherence group (`Path::coh == 0`) add as energies
/// g^2 in their own bin. The members of a group (a geometric path with its lit-zone diffracted paths, or the shadow paths of
/// one edge) are coherent: the band energy of the group is E = mean over `ETC_SUB` sub-frequencies f of
/// |sum_p g_p exp(-j 2 pi f r_p / c)|^2 (>= 0 by construction; signed gains, the lit diffracted paths subtract), distributed
/// to the members' own bins in proportion to g_p^2 (nothing if all gains of the band are 0).
pub fn build_etc(paths: &[Path], hist: &Hist) -> Etc {
    let nb = hist.nbins;
    let mut e = vec![0.0; NROWS * nb];
    for k in 0..nb {
        for b in 0..NB {
            e[b * nb + k] = hist.e[k * NB + b];
        }
    }
    for p in paths.iter().filter(|p| p.coh == 0) {
        let k = (p.delay() / BIN_S) as usize;
        if k < nb {
            for b in 0..NB {
                e[b * nb + k] += p.gains[b] * p.gains[b];
            }
        }
    }
    if paths.iter().any(|p| p.coh != 0) {
        let mut members: Vec<usize> = (0..paths.len()).filter(|&i| paths[i].coh != 0).collect();
        members.sort_by_key(|&i| paths[i].coh);
        for grp in members.chunk_by(|&a, &b| paths[a].coh == paths[b].coh) {
            for b in 0..NB {
                let shares = group_shares(paths, grp, b);
                for (&i, s) in grp.iter().zip(shares) {
                    let k = (paths[i].delay() / BIN_S) as usize;
                    if k < nb {
                        e[b * nb + k] += s;
                    }
                }
            }
        }
    }
    for k in 0..nb {
        e[NB * nb + k] = (0..NB).map(|b| e[b * nb + k]).sum();
    }
    Etc { nbins: nb, e }
}

/// Shares of the group energy of band `b` per member (sum = E_group, each >= 0).
pub(crate) fn group_shares(paths: &[Path], members: &[usize], b: usize) -> Vec<f64> {
    let fc = crate::ism::BAND_HZ[b];
    let mut total = 0.0;
    for i in 0..ETC_SUB {
        let w = 2.0 * std::f64::consts::PI * fc * 2f64.powf(-0.5 + i as f64 / (ETC_SUB - 1) as f64) / crate::ism::SPEED_OF_SOUND;
        let (mut re, mut im) = (0.0, 0.0);
        for &m in members {
            let g = paths[m].gains[b];
            re += g * (w * paths[m].r).cos();
            im -= g * (w * paths[m].r).sin();
        }
        total += re * re + im * im;
    }
    let energy = total / ETC_SUB as f64;
    let sq: f64 = members.iter().map(|&m| paths[m].gains[b] * paths[m].gains[b]).sum();
    if sq <= 0.0 {
        return vec![0.0; members.len()];
    }
    members.iter().map(|&m| energy * paths[m].gains[b] * paths[m].gains[b] / sq).collect()
}

/// Backward-integrated decay in dB re total, one value per bin (starting at `t0`; earlier bins 0 dB).
pub fn schroeder_db(e: &[f64]) -> Vec<f64> {
    schroeder_db_tail(e, 0.0)
}

/// Energy after the end of a TRUNCATED energy-time curve, extrapolated from its late decay
/// (log-linear fit over the last 40% of the curve, 10 ms blocks; Lundeby-style truncation
/// compensation without a noise floor, as the ETC is noiseless). Returns 0 when the curve has
/// already decayed more than 50 dB (truncation is then irrelevant) or has no clear decay.
pub fn tail_energy(e: &[f64]) -> f64 {
    let n = e.len();
    if n < 400 {
        return 0.0;
    }
    let peak = e.iter().cloned().fold(0.0, f64::max);
    let start = n * 6 / 10;
    let blocks = (n - start) / 10;
    if blocks < 4 || peak <= 0.0 {
        return 0.0;
    }
    let (mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0);
    for b in 0..blocks {
        let m = e[start + b * 10..start + b * 10 + 10].iter().sum::<f64>() / 10.0;
        let (x, y) = ((start + b * 10 + 5) as f64, 10.0 * m.max(1e-30).log10());
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
    }
    let nb = blocks as f64;
    let slope = (nb * sxy - sx * sy) / (nb * sxx - sx * sx); // dB per bin (ms)
    if slope >= -1e-4 {
        return 0.0;
    }
    let icpt = (sy - slope * sx) / nb;
    let end_db = icpt + slope * n as f64;
    if end_db < 10.0 * peak.log10() - 50.0 {
        return 0.0;
    }
    let k = -slope * std::f64::consts::LN_10 / 10.0; // 1/ms
    10f64.powf(end_db / 10.0) / (k.exp() - 1.0)
}

pub fn schroeder_db_tail(e: &[f64], tail: f64) -> Vec<f64> {
    let n = e.len();
    let mut s = vec![0.0; n];
    let mut acc = tail;
    for k in (0..n).rev() {
        acc += e[k];
        s[k] = acc;
    }
    let tot = s.first().copied().unwrap_or(0.0).max(1e-300);
    s.iter().map(|v| 10.0 * (v.max(1e-300) / tot).log10()).collect()
}

/// Reverberation time from a linear fit of the Schroeder curve between `hi` and `lo` dB,
/// extrapolated to 60 dB. NaN if the curve does not reach `lo`.
fn rt_fit(sch: &[f64], t0: usize, hi: f64, lo: f64) -> f64 {
    let k0 = match (t0..sch.len()).find(|&k| sch[k] <= hi) {
        Some(k) => k,
        None => return f64::NAN,
    };
    let k1 = match (k0..sch.len()).find(|&k| sch[k] <= lo) {
        Some(k) => k,
        None => return f64::NAN,
    };
    if k1 <= k0 + 1 {
        return f64::NAN;
    }
    let n = (k1 - k0 + 1) as f64;
    let (mut sx, mut sy, mut sxx, mut sxy) = (0.0, 0.0, 0.0, 0.0);
    for k in k0..=k1 {
        let (x, y) = (k as f64 * BIN_S, sch[k]);
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
    }
    let slope = (n * sxy - sx * sy) / (n * sxx - sx * sx); // dB per second
    if slope >= 0.0 { f64::NAN } else { -60.0 / slope }
}

/// Returns [EDT, T20, T30, C50, C80, D50] for one ETC row (NaN where undefined).
pub fn analyze(e: &[f64]) -> [f64; 6] {
    let t0 = match e.iter().position(|&v| v > 0.0) {
        Some(k) => k,
        None => return [f64::NAN; 6],
    };
    let tc = tail_energy(&e[t0..]);
    let sch = schroeder_db_tail(&e[t0..], tc);
    let sum = |a: usize, b: usize| e[(t0 + a).min(e.len())..(t0 + b).min(e.len())].iter().sum::<f64>() + if b >= e.len() { tc } else { 0.0 };
    let total = sum(0, e.len());
    let clarity = |ms: usize| {
        let (early, late) = (sum(0, ms), sum(ms, e.len()));
        if early > 0.0 && late > 0.0 { 10.0 * (early / late).log10() } else { f64::NAN }
    };
    [
        rt_fit(&sch, 0, 0.0, -10.0),
        rt_fit(&sch, 0, -5.0, -25.0),
        rt_fit(&sch, 0, -5.0, -35.0),
        clarity(50),
        clarity(80),
        if total > 0.0 { sum(0, 50) / total } else { f64::NAN },
    ]
}

// ------------------------------------------------------------------ Sabine / Eyring

#[derive(Clone)]
pub struct SceneStats {
    pub volume: f64,
    pub surface: f64,
    pub floor_area: f64,
    /// Absorption area per band, m^2.
    pub absorption: Bands,
}

/// Floor area and surface statistics from the planar analysis of the walls (`plan::analyze`): the
/// room faces give the floor area (pillars are subtracted), every wall piece contributes once per
/// side facing a room, so partitions and free-standing baffles count both faces. `None` if the walls
/// enclose no room.
pub fn scene_stats(scene: &Scene) -> Option<SceneStats> {
    let w = &scene.walls;
    if w.len() < 3 {
        return None;
    }
    let plan = crate::plan::analyze(w);
    let floor_area = plan.floor_area();
    if plan.rooms().next().is_none() || floor_area < 1e-6 {
        return None;
    }
    let h = scene.height;
    let mut absorption = Bands::ZERO;
    let mut perimeter = 0.0;
    for (i, wl) in w.iter().enumerate() {
        let len = ((wl.p2[0] - wl.p1[0]).powi(2) + (wl.p2[1] - wl.p1[1]).powi(2)).sqrt();
        let m = scene.mat(wl.mat);
        let ae = m.alpha_eff();
        // A wall whose pieces all have the same number of room sides is counted whole.
        let pieces = &plan.pieces[i];
        let uniform = pieces.first().map_or(true, |p| pieces.iter().all(|q| q.1 == p.1));
        let parts: Vec<(f64, f64)> = if uniform { vec![(len, pieces.first().map_or(0.0, |p| p.1 as f64))] } else { pieces.iter().map(|&(l, k)| (l, k as f64)).collect() };
        for (l, faces) in parts {
            perimeter += faces * l;
            absorption += ae * (faces * l * h);
        }
    }
    let (fl, ce) = (scene.mat(scene.floor_mat).without_tx().alpha_eff(), scene.mat(scene.ceil_mat).without_tx().alpha_eff());
    absorption += (fl + ce) * floor_area;
    Some(SceneStats { volume: floor_area * h, surface: perimeter * h + 2.0 * floor_area, floor_area, absorption })
}

impl SceneStats {
    /// Air term 4 m V per band (m = energy attenuation in Np/m = dB/m / (10 log10 e)).
    fn air(&self, b: usize) -> f64 {
        4.0 * AIR_DB_PER_M[b] / (10.0 * std::f64::consts::E.log10()) * self.volume
    }
    pub fn sabine(&self, b: usize) -> f64 {
        0.1611 * self.volume / (self.absorption[b] + self.air(b))
    }
    pub fn eyring(&self, b: usize) -> f64 {
        let abar = (self.absorption[b] / self.surface).clamp(0.0, 0.999999);
        0.1611 * self.volume / (-self.surface * (1.0 - abar).ln() + self.air(b))
    }
}

/// Fill the metrics table: rows = bands + broadband; columns EDT,T20,T30,C50,C80,D50,Sabine,Eyring.
/// Broadband Sabine/Eyring are the mean of the 500 Hz and 1 kHz bands.
pub fn table(etc: &Etc, stats: Option<&SceneStats>) -> Vec<f32> {
    let mut out = vec![f32::NAN; NROWS * NM];
    for r in 0..NROWS {
        let m = analyze(&etc.e[r * etc.nbins..(r + 1) * etc.nbins]);
        for c in 0..6 {
            out[r * NM + c] = m[c] as f32;
        }
        if let Some(s) = stats {
            let (sab, eyr) = if r < NB { (s.sabine(r), s.eyring(r)) } else { ((s.sabine(2) + s.sabine(3)) / 2.0, (s.eyring(2) + s.eyring(3)) / 2.0) };
            out[r * NM + 6] = sab as f32;
            out[r * NM + 7] = eyr as f32;
        }
    }
    out
}

/// Plot payload: [nbins, ETC dB x NROWS, Schroeder dB x NROWS]. ETC in absolute dB (floor -200).
pub fn plot_data(etc: &Etc) -> Vec<f32> {
    let nb = etc.nbins;
    let mut out = Vec::with_capacity(1 + 2 * NROWS * nb);
    out.push(nb as f32);
    for r in 0..NROWS {
        for k in 0..nb {
            out.push((10.0 * etc.e[r * nb + k].max(1e-20).log10()) as f32);
        }
    }
    for r in 0..NROWS {
        let row = &etc.e[r * nb..(r + 1) * nb];
        let t0 = row.iter().position(|&v| v > 0.0).unwrap_or(0);
        let s = schroeder_db_tail(&row[t0..], tail_energy(&row[t0..]));
        for k in 0..nb {
            out.push(if k < t0 { 0.0 } else { s[k - t0] as f32 });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exponential_decay_metrics() {
        // Energy decaying 60 dB in T = 1 s, impulse at bin 5: EDT = T20 = T30 = 1 s.
        let t = 1.0;
        let e: Vec<f64> = (0..3000)
            .map(|k| if k < 5 { 0.0 } else { (-(k - 5) as f64 * BIN_S * 6.0 * std::f64::consts::LN_10 / t).exp() })
            .collect();
        let m = analyze(&e);
        for i in 0..3 {
            assert!((m[i] - t).abs() < 0.03, "metric {i} = {}", m[i]);
        }
        // D50 for this decay = 1 - 10^(-6*0.05/T)
        let d50 = 1.0 - 10f64.powf(-6.0 * 0.05 / t);
        assert!((m[5] - d50).abs() < 0.02);
    }

    #[test]
    fn truncated_decay_is_compensated() {
        // 60 dB in T = 12 s, but only 8 s of IR (-40 dB at the end): the raw Schroeder curve plunges
        // at the end and under-reads T30; with the tail compensation it recovers ~12 s. (A 5 s IR could
        // not reach -35 dB of true decay at all: T30 is then reported as unavailable, T20 still works.)
        let t = 12.0;
        let e: Vec<f64> = (0..8000)
            .map(|k| if k < 5 { 0.0 } else { (-(k - 5) as f64 * BIN_S * 6.0 * std::f64::consts::LN_10 / t).exp() })
            .collect();
        let raw = {
            let sch = schroeder_db(&e[5..]);
            rt_fit(&sch, 0, -5.0, -35.0)
        };
        let m = analyze(&e);
        println!("truncated T=12 s decay at 8 s: raw T30 {raw:.2}, compensated T30 {:.2}, EDT {:.2}", m[2], m[0]);
        assert!(raw.is_nan() || raw < t * 0.99, "raw fit should be biased low: {raw}");
        assert!((m[2] - t).abs() / t < 0.06, "compensated T30 = {}", m[2]);
    }

    #[test]
    fn sabine_eyring_shoebox() {
        let sc = crate::ism::Scene {
            walls: vec![
                crate::ism::Wall::full([0.0, 0.0], [10.0, 0.0], 0),
                crate::ism::Wall::full([10.0, 0.0], [10.0, 7.0], 0),
                crate::ism::Wall::full([10.0, 7.0], [0.0, 7.0], 0),
                crate::ism::Wall::full([0.0, 7.0], [0.0, 0.0], 0),
            ],
            materials: vec![crate::ism::Material::new(Bands::splat(0.2), 0.0)],
            height: 3.0,
            floor_mat: 0,
            ceil_mat: 0,
            caps: vec![],
        };
        let s = scene_stats(&sc).unwrap();
        assert!((s.volume - 210.0).abs() < 1e-9 && (s.surface - 242.0).abs() < 1e-9);
        // Sabine without air: 0.1611*210/(0.2*242) = 0.699 s (air lowers it slightly at HF only).
        assert!((s.sabine(2) - 0.699).abs() < 0.01);
        assert!(s.eyring(2) < s.sabine(2));
        // Open geometry -> None
        let mut open = sc.clone();
        open.walls.pop();
        assert!(scene_stats(&open).is_none());
    }

    #[test]
    fn pillar_area_is_subtracted() {
        use crate::ism::Wall;
        let c0 = [[0.0, 0.0], [10.0, 0.0], [10.0, 7.0], [0.0, 7.0]];
        let mut sc = Scene {
            walls: (0..4).map(|i| Wall::full(c0[i], c0[(i + 1) % 4], 0)).collect(),
            materials: vec![crate::ism::Material::new(Bands::splat(0.2), 0.0)],
            height: 3.0,
            floor_mat: 0,
            ceil_mat: 0,
            caps: vec![],
        };
        let c = [[4.0, 3.0], [6.0, 3.0], [6.0, 5.0], [4.0, 5.0]];
        for i in 0..4 {
            sc.walls.push(Wall::full(c[i], c[(i + 1) % 4], 0));
        }
        let s = scene_stats(&sc).unwrap();
        assert!((s.floor_area - 66.0).abs() < 1e-9);
        assert!((s.volume - 198.0).abs() < 1e-9);
        assert!((s.surface - (42.0 * 3.0 + 2.0 * 66.0)).abs() < 1e-9);
        // A free-standing wall adds its two faces but no floor area.
        sc.walls.push(Wall::full([1.0, 1.0], [3.0, 1.0], 0));
        let b = scene_stats(&sc).unwrap();
        assert!((b.floor_area - 66.0).abs() < 1e-9);
        assert!((b.surface - s.surface - 2.0 * 2.0 * 3.0).abs() < 1e-9);
    }

    fn scene_of(walls: &[[f64; 4]]) -> Scene {
        use crate::ism::{Material, Wall};
        Scene {
            walls: walls.iter().map(|w| Wall::full([w[0], w[1]], [w[2], w[3]], 0)).collect(),
            materials: vec![Material::new(Bands::splat(0.2), 0.0)],
            height: 3.0,
            floor_mat: 0,
            ceil_mat: 0,
            caps: vec![],
        }
    }

    #[test]
    fn partitions_split_the_plan_without_opening_it() {
        let shell = [[0.0, 0.0, 8.0, 0.0], [8.0, 0.0, 8.0, 4.0], [8.0, 4.0, 0.0, 4.0], [0.0, 4.0, 0.0, 0.0]];
        let plain = scene_stats(&scene_of(&shell)).unwrap();
        // Partition ending on the middle of the north and south walls (T-junctions).
        let mut t = shell.to_vec();
        t.push([4.0, 0.0, 4.0, 4.0]);
        let st = scene_stats(&scene_of(&t)).unwrap();
        assert!((st.floor_area - 32.0).abs() < 1e-9 && (st.volume - plain.volume).abs() < 1e-9);
        assert!((st.surface - (plain.surface + 2.0 * 4.0 * 3.0)).abs() < 1e-9);
        // Partition joined at shared vertices (degree-3 junctions) gives the same statistics.
        let v = [
            [0.0, 0.0, 4.0, 0.0], [4.0, 0.0, 8.0, 0.0], [8.0, 0.0, 8.0, 4.0], [8.0, 4.0, 4.0, 4.0], [4.0, 4.0, 0.0, 4.0], [0.0, 4.0, 0.0, 0.0], [4.0, 0.0, 4.0, 4.0],
        ];
        let sv = scene_stats(&scene_of(&v)).unwrap();
        assert!((sv.surface - st.surface).abs() < 1e-9 && (sv.floor_area - 32.0).abs() < 1e-9);
        for b in 0..NB {
            assert!((sv.absorption[b] - st.absorption[b]).abs() < 1e-9);
        }
        // A wall sticking out of the room adds nothing: neither of its sides faces a room.
        let mut o = shell.to_vec();
        o.push([8.0, 2.0, 10.0, 2.0]);
        assert!((scene_stats(&scene_of(&o)).unwrap().surface - plain.surface).abs() < 1e-9);
    }
}
