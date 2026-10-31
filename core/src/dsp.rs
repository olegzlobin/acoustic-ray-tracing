//! Band filterbank and FOA impulse-response synthesis.

use crate::ism::{Bands, Path, NB};
use crate::rays::{Hist, Rng};
use std::f64::consts::PI;

/// Band centre frequencies (Hz).
pub const BAND_FC: Bands = Bands([125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0]);

#[derive(Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2], // a1, a2 (a0 normalised to 1)
}

/// 2nd-order Butterworth (Q = 1/sqrt 2) low- or high-pass, RBJ cookbook.
fn butter2(fc: f64, fs: f64, highpass: bool) -> Biquad {
    let w0 = 2.0 * PI * fc / fs;
    let (s, c) = w0.sin_cos();
    let alpha = s / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
    let a0 = 1.0 + alpha;
    let (b0, b1, b2) = if highpass {
        ((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0)
    } else {
        ((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0)
    };
    Biquad { b: [b0 / a0, b1 / a0, b2 / a0], a: [-2.0 * c / a0, (1.0 - alpha) / a0] }
}

/// Sections of band `b`: lowest = LP at fc*sqrt2, highest = HP at fc/sqrt2, others HP+LP at the octave edges.
fn band_sections(b: usize, fs: f64) -> Vec<Biquad> {
    let fc = BAND_FC[b];
    let lo = fc / std::f64::consts::SQRT_2;
    let hi = fc * std::f64::consts::SQRT_2;
    let mut v = Vec::new();
    if b > 0 && lo < 0.45 * fs {
        v.push(butter2(lo, fs, true));
    }
    if b < NB - 1 && hi < 0.45 * fs {
        v.push(butter2(hi, fs, false));
    }
    v
}

fn run_pass(sec: &Biquad, x: &mut [f32], reverse: bool) {
    let (mut z1, mut z2) = (0.0f64, 0.0f64);
    let mut step = |v: &mut f32| {
        let xi = *v as f64;
        let y = sec.b[0] * xi + z1;
        z1 = sec.b[1] * xi - sec.a[0] * y + z2;
        z2 = sec.b[2] * xi - sec.a[1] * y;
        *v = y as f32;
    };
    if reverse {
        x.iter_mut().rev().for_each(&mut step);
    } else {
        x.iter_mut().for_each(&mut step);
    }
}

/// Zero-phase band filtering: every section is applied forward then backward.
pub fn filter_band(b: usize, fs: f64, x: &mut [f32]) {
    for sec in band_sections(b, fs) {
        run_pass(&sec, x, false);
        run_pass(&sec, x, true);
    }
}

/// FOA gains ACN order [W, Y, Z, X], SN3D, from a unit world-frame direction
/// (x = front, y = left, z = up): W=1, Y=sin(az)cos(el), Z=sin(el), X=cos(az)cos(el).
pub fn foa_gains(dir: [f64; 3]) -> [f64; 4] {
    [1.0, dir[1], dir[2], dir[0]]
}

/// IR length in samples: last path delay + 50 ms, capped at `cap_s`.
pub fn ir_samples(paths: &[Path], fs: f64, cap_s: f64) -> usize {
    let last = paths.iter().map(|p| p.delay()).fold(0.0, f64::max);
    let secs = (last + 0.05).min(cap_s.max(0.01));
    ((secs * fs).ceil() as usize).max(256)
}

/// Third-order Ambisonics gains, ACN order, SN3D (AmbiX), from a unit world-frame direction
/// (x = front, y = left, z = up). The first four equal `foa_gains`.
pub fn toa_gains(dir: [f64; 3]) -> [f64; 16] {
    let [x, y, z] = dir;
    let s3 = 3f64.sqrt();
    [
        1.0,
        y,
        z,
        x,
        s3 * x * y,
        s3 * y * z,
        (3.0 * z * z - 1.0) / 2.0,
        s3 * x * z,
        s3 / 2.0 * (x * x - y * y),
        (5.0f64 / 8.0).sqrt() * y * (3.0 * x * x - y * y),
        15f64.sqrt() * x * y * z,
        (3.0f64 / 8.0).sqrt() * y * (5.0 * z * z - 1.0),
        z * (5.0 * z * z - 3.0) / 2.0,
        (3.0f64 / 8.0).sqrt() * x * (5.0 * z * z - 1.0),
        15f64.sqrt() / 2.0 * z * (x * x - y * y),
        (5.0f64 / 8.0).sqrt() * x * (x * x - 3.0 * y * y),
    ]
}

/// Per path: 2-tap fractional delay x band gain x encoder gains, zero-phase band filter, sum over
/// bands. `nch` channels concatenated, `n` samples each.
fn synth_paths<const C: usize>(paths: &[Path], fs: f64, n: usize, encode: impl Fn([f64; 3]) -> [f64; C]) -> Vec<f32> {
    // [band][channel][n]
    let mut bands = vec![0.0f32; NB * C * n];
    for p in paths {
        let pos = p.delay() * fs;
        let i = pos.floor() as usize;
        if i + 1 >= n {
            continue;
        }
        let frac = (pos - i as f64) as f32;
        let g = encode(p.dir);
        for b in 0..NB {
            for c in 0..C {
                let a = (p.gains[b] * g[c]) as f32;
                let o = (b * C + c) * n + i;
                // Linear 2-tap fractional delay.
                bands[o] += a * (1.0 - frac);
                bands[o + 1] += a * frac;
            }
        }
    }
    let mut out = vec![0.0f32; C * n];
    for b in 0..NB {
        for c in 0..C {
            let buf = &mut bands[(b * C + c) * n..(b * C + c + 1) * n];
            filter_band(b, fs, buf);
            for (o, v) in out[c * n..(c + 1) * n].iter_mut().zip(buf.iter()) {
                *o += *v;
            }
        }
    }
    out
}

/// Returns 4 channels (W,Y,Z,X) concatenated, each `n` samples.
pub fn synth_ir(paths: &[Path], fs: f64, n: usize) -> Vec<f32> {
    synth_paths(paths, fs, n, foa_gains)
}

/// Right-ear sign per ACN channel: the negative-m spherical harmonics are antisymmetric about the median
/// plane, so the right ear takes them with the opposite sign (as Omnitone's HOA convolver does).
const TOA_RIGHT_SIGN: [f32; 16] = [1., -1., 1., 1., -1., -1., 1., 1., 1., -1., -1., -1., 1., 1., 1., 1.];

/// Binaural early IR: every path through the HRIR of its direction, decoded from third-order Ambisonics
/// filters `hrir` (16 ACN channels x `taps`, SN3D) with the head turned by `yaw` (the world direction is
/// rotated by -yaw about z), then band-shaped like `synth_ir` (the band filters are linear, so filtering
/// after the HRIR is the same as before it). Paths are weighted by the early window `win(delay)`, so only
/// what the early part keeps is built. Returns L and R concatenated, `n + taps` samples each.
///
/// Same result as encoding into 16 channels and convolving each with its decoding filter, but with 2 x 6
/// band buffers to filter instead of 16 x 6, and no FFT.
pub fn synth_binaural(paths: &[Path], fs: f64, n: usize, hrir: &[f32], taps: usize, yaw: f64, win: impl Fn(f64) -> f64) -> Vec<f32> {
    let m = n + taps;
    let mut bands = vec![0.0f32; NB * 2 * m];
    let (cy, sy) = (yaw.cos(), yaw.sin());
    let mut h = [vec![0.0f32; taps], vec![0.0f32; taps]];
    for p in paths {
        let w = win(p.delay());
        if w <= 0.0 {
            continue;
        }
        let pos = p.delay() * fs;
        let i = pos.floor() as usize;
        if i + 1 >= n {
            continue;
        }
        let frac = (pos - i as f64) as f32;
        let [x, y, z] = p.dir;
        let g = toa_gains([x * cy + y * sy, -x * sy + y * cy, z]);
        h[0].fill(0.0);
        h[1].fill(0.0);
        for k in 0..16 {
            let gl = g[k] as f32;
            if gl == 0.0 {
                continue;
            }
            let gr = gl * TOA_RIGHT_SIGN[k];
            let f = &hrir[k * taps..(k + 1) * taps];
            for t in 0..taps {
                h[0][t] += gl * f[t];
                h[1][t] += gr * f[t];
            }
        }
        for b in 0..NB {
            let a = (p.gains[b] * w) as f32;
            let (a0, a1) = (a * (1.0 - frac), a * frac); // linear 2-tap fractional delay
            for (e, he) in h.iter().enumerate() {
                let o = (b * 2 + e) * m + i;
                let buf = &mut bands[o..o + taps + 1];
                for t in 0..taps {
                    buf[t] += a0 * he[t];
                    buf[t + 1] += a1 * he[t];
                }
            }
        }
    }
    let mut out = vec![0.0f32; 2 * m];
    for b in 0..NB {
        for e in 0..2 {
            let buf = &mut bands[(b * 2 + e) * m..(b * 2 + e + 1) * m];
            filter_band(b, fs, buf);
            for (o, v) in out[e * m..(e + 1) * m].iter_mut().zip(buf.iter()) {
                *o += *v;
            }
        }
    }
    out
}

// ------------------------------------------------------------------ late tail

/// Cached unit noise: 6 bands x 4 FOA channels of seeded white Gaussian noise, band-filtered
/// (zero phase) once, plus its energy per 1 ms bin. Only the per-bin gains change between calls.
/// It can be built incrementally (`prepare` + `build_step`, one buffer of 24 per step) so the
/// worker can pre-warm it between requests.
#[derive(Default)]
pub struct NoiseCache {
    fs: f64,
    n: usize,
    buf: Vec<Vec<f32>>,        // [b*4+c][n], filled up to `buf.len()` of 24
    bin_energy: Vec<Vec<f32>>, // [b*4+c][bin]
}

pub const NOISE_BUFFERS: usize = NB * 4;

fn samples_per_bin(fs: f64) -> f64 {
    fs * crate::rays::BIN_S
}

impl NoiseCache {
    /// Make sure a cache for (fs, >= n samples) is being built; resets it if too small/other rate.
    /// Lengths are rounded up to 0.25 s so small changes do not restart the build.
    pub fn prepare(&mut self, fs: f64, n: usize) {
        if self.fs == fs && self.n >= n && self.n > 0 {
            return;
        }
        self.n = ((n as f64 / (0.25 * fs)).ceil() * 0.25 * fs) as usize;
        self.fs = fs;
        self.buf.clear();
        self.bin_energy.clear();
    }

    pub fn complete(&self) -> bool {
        self.buf.len() == NOISE_BUFFERS
    }

    /// Build the next noise buffer. Returns the number still missing.
    pub fn build_step(&mut self) -> usize {
        let idx = self.buf.len();
        if idx >= NOISE_BUFFERS {
            return 0;
        }
        let (fs, n) = (self.fs, self.n);
        let (b, c) = (idx / 4, idx % 4);
        let spb = samples_per_bin(fs);
        let nbins = (n as f64 / spb).ceil() as usize + 1;
        let mut rng = Rng::new(0xA5A5_0000 + idx as u64 * 7919);
        let mut x: Vec<f32> = (0..n).map(|_| rng.gauss() as f32).collect();
        filter_band(b, fs, &mut x);
        let mut en = vec![0.0f32; nbins];
        for (i, v) in x.iter().enumerate() {
            en[(i as f64 / spb) as usize] += v * v;
        }
        self.buf.push(x);
        self.bin_energy.push(en);
        let _ = c;
        NOISE_BUFFERS - self.buf.len()
    }

    fn ensure(&mut self, fs: f64, n: usize) {
        self.prepare(fs, n);
        while self.build_step() > 0 {}
    }
}

/// Per-sample linear interpolation of per-bin values between bin centres, written into `out`
/// (segment-wise with an incremental ramp, no per-sample division/floor).
fn interp_bins(v: &[f32], spb: f64, out: &mut [f32]) {
    let n = out.len();
    if v.is_empty() {
        out.iter_mut().for_each(|o| *o = 0.0);
        return;
    }
    // Before the first centre: constant.
    let first = ((0.5 * spb).ceil() as usize).min(n);
    out[..first].iter_mut().for_each(|o| *o = v[0]);
    let mut k = 0usize;
    let mut i = first;
    while i < n {
        if k + 1 >= v.len() {
            out[i..].iter_mut().for_each(|o| *o = v[v.len() - 1]);
            return;
        }
        let end = (((k as f64 + 1.5) * spb).ceil() as usize).min(n);
        let (g0, g1) = (v[k], v[k + 1]);
        let step = ((g1 - g0) as f64 / spb) as f32;
        let mut g = (g0 as f64 + (g1 - g0) as f64 * ((i as f64 / spb - 0.5) - k as f64)) as f32;
        for o in out[i..end].iter_mut() {
            *o = g;
            g += step;
        }
        i = end;
        k += 1;
    }
}

/// Synthesise the stochastic tail: 4 channels (W,Y,Z,X) of `n` samples each.
///
/// Per band and channel the cached noise is rescaled by a smooth per-bin gain so that the energy in
/// every 1 ms bin equals the histogram energy. W is the sum of bands. For Y,Z,X: with the smoothed
/// mean arrival direction v (|v| <= 1) channel_c = W v_c + sqrt((1-|v|^2)/3) N_c, N_c being an
/// independent tail with the same band envelopes (SN3D diffuse field: each channel carries 1/3 of W).
pub fn synth_tail(hist: &Hist, fs: f64, n: usize, cache: &mut NoiseCache) -> Vec<f32> {
    cache.ensure(fs, n);
    let spb = samples_per_bin(fs);
    let nb = hist.nbins;
    // Noise sums per channel (sum over bands of gain(t) * noise).
    let mut acc = vec![0.0f32; 4 * n];
    let mut gs = vec![0.0f32; n];
    for b in 0..NB {
        for c in 0..4 {
            let idx = b * 4 + c;
            let en = &cache.bin_energy[idx];
            let g: Vec<f32> = (0..nb)
                .map(|k| {
                    let e = hist.e[k * NB + b];
                    let w = en.get(k).copied().unwrap_or(0.0) as f64;
                    if e > 0.0 && w > 1e-12 { (e / w).sqrt() as f32 } else { 0.0 }
                })
                .collect();
            interp_bins(&g, spb, &mut gs);
            let nz = &cache.buf[idx][..n];
            for ((a, g), x) in acc[c * n..(c + 1) * n].iter_mut().zip(gs.iter()).zip(nz.iter()) {
                *a += g * x;
            }
        }
    }
    // Smoothed mean direction over +-2 bins (energy-weighted sums, so quiet bins weigh little).
    let mut vx = vec![[0.0f32; 3]; nb];
    for k in 0..nb {
        let (lo, hi) = (k.saturating_sub(2), (k + 2).min(nb - 1));
        let (mut s, mut e) = ([0.0f64; 3], 0.0f64);
        for j in lo..=hi {
            for i in 0..3 {
                s[i] += hist.dir[j][i];
            }
            e += (0..NB).map(|b| hist.e[j * NB + b]).sum::<f64>();
        }
        if e > 0.0 {
            let v = [s[0] / e, s[1] / e, s[2] / e];
            let m = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1.0);
            vx[k] = [(v[0] / m) as f32, (v[1] / m) as f32, (v[2] / m) as f32];
        }
    }
    let mut vs: Vec<Vec<f32>> = Vec::with_capacity(3);
    for i in 0..3 {
        let bins: Vec<f32> = vx.iter().map(|v| v[i]).collect();
        let mut o = vec![0.0f32; n];
        interp_bins(&bins, spb, &mut o);
        vs.push(o);
    }
    let mut out = vec![0.0f32; 4 * n];
    for i in 0..n {
        let v = [vs[0][i], vs[1][i], vs[2][i]];
        let d = (1.0 - (v[0] * v[0] + v[1] * v[1] + v[2] * v[2])).max(0.0);
        let sd = (d / 3.0).sqrt();
        let w = acc[i];
        // AmbiX ACN order: W, Y, Z, X  <-  world (x,y,z) = (front, left, up).
        out[i] = w;
        out[n + i] = w * v[1] + sd * acc[n + i];
        out[2 * n + i] = w * v[2] + sd * acc[2 * n + i];
        out[3 * n + i] = w * v[0] + sd * acc[3 * n + i];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mag_at(x: &[f32], f: f64, fs: f64) -> f64 {
        let (mut re, mut im) = (0.0, 0.0);
        for (n, v) in x.iter().enumerate() {
            let ph = 2.0 * PI * f * n as f64 / fs;
            re += *v as f64 * ph.cos();
            im -= *v as f64 * ph.sin();
        }
        (re * re + im * im).sqrt()
    }

    #[test]
    fn filterbank_is_roughly_flat() {
        let fs = 48000.0;
        let n = 16384;
        let mut sum = vec![0.0f32; n];
        for b in 0..NB {
            let mut x = vec![0.0f32; n];
            x[n / 2] = 1.0;
            filter_band(b, fs, &mut x);
            for (s, v) in sum.iter_mut().zip(&x) {
                *s += *v;
            }
        }
        let mut worst = 0.0f64;
        let mut f = 100.0;
        while f <= 8000.0 {
            let db = 20.0 * mag_at(&sum, f, fs).log10();
            println!("{f:8.0} Hz  {db:+.2} dB");
            worst = worst.max(db.abs());
            f *= 1.1;
        }
        assert!(worst < 3.0, "filterbank deviation {worst} dB");
    }

    #[test]
    fn foa_encoding_axes() {
        assert_eq!(foa_gains([1.0, 0.0, 0.0]), [1.0, 0.0, 0.0, 1.0]); // front -> X
        assert_eq!(foa_gains([0.0, 1.0, 0.0]), [1.0, 1.0, 0.0, 0.0]); // left -> Y
        assert_eq!(foa_gains([0.0, 0.0, 1.0]), [1.0, 0.0, 1.0, 0.0]); // up -> Z
    }

    #[test]
    fn toa_first_four_are_foa() {
        let d = [0.3, -0.5, (1.0f64 - 0.34).sqrt()];
        assert_eq!(&toa_gains(d)[..4], &foa_gains(d)[..]);
    }

    #[test]
    fn toa_front_axis() {
        let g = toa_gains([1.0, 0.0, 0.0]);
        let (s3, s38, s58) = (3f64.sqrt(), (3.0f64 / 8.0).sqrt(), (5.0f64 / 8.0).sqrt());
        let want = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0, -0.5, 0.0, s3 / 2.0, 0.0, 0.0, 0.0, 0.0, -s38, 0.0, s58];
        for (a, b) in g.iter().zip(want.iter()) {
            assert!((a - b).abs() < 1e-12, "{g:?}");
        }
    }

    #[test]
    fn binaural_is_symmetric() {
        // Any decoding filters: a frontal path reaches both ears alike, a left path mirrors a right one.
        let taps = 32;
        let hrir: Vec<f32> = (0..16 * taps).map(|i| ((i * 7919 % 97) as f32 - 48.0) / 97.0).collect();
        let fs = 48000.0;
        let path = |dir: [f64; 3]| Path { order: 0, r: 3.0, gains: Bands::splat(0.3), dir, pts: vec![], crossed: 0, coh: 0 };
        let n = 1024;
        let one = |dir, yaw| synth_binaural(&[path(dir)], fs, n, &hrir, taps, yaw, |_| 1.0);
        let m = n + taps;
        let front = one([1.0, 0.0, 0.0], 0.0);
        for i in 0..m {
            assert!((front[i] - front[m + i]).abs() < 1e-6);
        }
        let (l, r) = (one([0.0, 1.0, 0.0], 0.0), one([0.0, -1.0, 0.0], 0.0));
        for i in 0..m {
            assert!((l[i] - r[m + i]).abs() < 1e-6 && (l[m + i] - r[i]).abs() < 1e-6);
        }
        // Head turned left by 90 degrees: a source on the world left is in front.
        let turned = one([0.0, 1.0, 0.0], std::f64::consts::FRAC_PI_2);
        for i in 0..m {
            assert!((turned[i] - front[i]).abs() < 1e-5 && (turned[m + i] - front[m + i]).abs() < 1e-5);
        }
    }
}
