//! UTD wedge diffraction coefficient (Kouyoumjian-Pathak, rigid faces) for a point source, port of
//! `tools/diffraction/utd.py` (`utd_A`, transition function `F` through the Abramowitz-Stegun 7.3.32 / 7.3.33
//! auxiliary Fresnel functions).
//!
//! Time convention exp(+j w t): the free field is exp(-jkR) / R and the diffracted pressure is
//! p_d = A / (r1 + r2) * exp(-jk (r1 + r2)),
//! A = D * sqrt((r1 + r2) / (r1 r2)),
//! D = -exp(-j pi / 4) / (2 n sqrt(2 pi k) sin b) * sum of 4 terms cot((pi +- beta) / (2 n)) F(k L a(beta)).
//! The core needs only |A| (the phase of the diffracted path is the delay of its length), so the sum is
//! accumulated as a complex number and the constant phase factor of D is dropped.
//!
//! Angles: `phi_s`, `phi_l` of the source / listener measured from face 0 inside the open (air) sector, in
//! (0, n pi); n = open wedge angle / pi (thin screen 2, 270 degree corner 1.5); r1 = |S - E|, r2 = |E - L| (3D),
//! sin b = sine of the angle between the edge and S - E.

use super::diffraction::BAND_HZ;
use super::{NB, SPEED_OF_SOUND};
use std::f64::consts::PI;

/// Frequencies per octave band over which the band amplitude is averaged (log-spaced over [fc / sqrt 2, fc sqrt 2]).
pub const SUB_FREQS: usize = 8;

/// |sin| below which a term sits on a shadow / reflection boundary (cot -> infinity, F -> 0).
const SING_TOL: f64 = 1e-12;

/// Abramowitz & Stegun 7.3.32 / 7.3.33 auxiliary functions f, g (|error| < 2e-3).
fn aux_fg(x: f64) -> (f64, f64) {
    let f = (1.0 + 0.926 * x) / (2.0 + 1.792 * x + 3.104 * x * x);
    let g = 1.0 / (2.0 + 4.142 * x + 3.492 * x * x + 6.670 * x * x * x);
    (f, g)
}

/// One term cot((pi + sign beta) / (2 n)) F(X) with X = k L a_sign(beta), as (re, im).
fn term(beta: f64, n: f64, sign: f64, kl: f64) -> (f64, f64) {
    let arg = (PI + sign * beta) / (2.0 * n);
    let big_n = ((beta + sign * PI) / (2.0 * PI * n)).round_ties_even();
    let a = 2.0 * ((2.0 * n * PI * big_n - beta) / 2.0).cos().powi(2);
    let x = kl * a;
    let sin = arg.sin();
    if sin.abs() < SING_TOL {
        // Exactly on a boundary: cot ~ 2 n sign / eps, F ~ sqrt(pi k L) |eps| (1 + j) / 2 with a ~ eps^2 / 2, so the
        // product tends to sign n sqrt(pi k L) (1 + j) (limit from the eps > 0 side; the other side flips the sign).
        let c = sign * n * (PI * kl).sqrt();
        return (c, c);
    }
    let cot = arg.cos() / sin;
    let amp = (2.0 * PI * x).sqrt();
    let (f, g) = aux_fg((2.0 * x / PI).sqrt());
    (cot * amp * f, cot * amp * g)
}

/// |A|^2 at wavenumber `k`.
pub fn a_sq(phi_s: f64, phi_l: f64, n: f64, r1: f64, r2: f64, sinb: f64, k: f64) -> f64 {
    let kl = k * r1 * r2 * sinb * sinb / (r1 + r2);
    let (bm, bp) = (phi_l - phi_s, phi_l + phi_s);
    let (mut re, mut im) = (0.0, 0.0);
    for (beta, sign) in [(bm, 1.0), (bm, -1.0), (bp, 1.0), (bp, -1.0)] {
        let (tr, ti) = term(beta, n, sign, kl);
        re += tr;
        im += ti;
    }
    let d2 = (re * re + im * im) / (4.0 * n * n * 2.0 * PI * k * sinb * sinb);
    d2 * (r1 + r2) / (r1 * r2)
}

/// Band amplitude sqrt(mean |A|^2) over `SUB_FREQS` log-spaced frequencies of octave band `b`.
pub fn band_rms(b: usize, phi_s: f64, phi_l: f64, n: f64, r1: f64, r2: f64, sinb: f64) -> f64 {
    debug_assert!(b < NB);
    let fc = BAND_HZ[b];
    let mut acc = 0.0;
    for i in 0..SUB_FREQS {
        let f = fc * 2f64.powf(-0.5 + i as f64 / (SUB_FREQS - 1) as f64);
        acc += a_sq(phi_s, phi_l, n, r1, r2, sinb, 2.0 * PI * f / SPEED_OF_SOUND);
    }
    (acc / SUB_FREQS as f64).sqrt()
}
