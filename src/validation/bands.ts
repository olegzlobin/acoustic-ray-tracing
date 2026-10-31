// Band analysis for the BRAS validation: asymmetric Hann window around a peak, zero-padded FFT and the
// energy per octave band 125 Hz .. 4 kHz (edges fc/sqrt2 .. fc*sqrt2). The same functions are applied to the
// measured and to the simulated impulse responses.

import { BAND_HZ, NB } from './bras-constants';

/** In-place radix-2 complex FFT (length a power of two). */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  if (n & (n - 1)) throw new Error('fft: length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Default FFT size: 2.7 Hz bin spacing at 44.1 kHz. */
export const NFFT = 16384;

/**
 * Energy per octave band of `x` (zero-padded to `nfft`): one-sided spectrum, scaled so that the sum over all
 * bins equals sum(x^2) (Parseval); bins in [fc/sqrt2, fc*sqrt2).
 */
export function bandEnergies(x: ArrayLike<number>, fs: number, nfft = NFFT): number[] {
  if (x.length > nfft) throw new Error('bandEnergies: signal longer than the FFT');
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < x.length; i++) re[i] = x[i];
  fft(re, im);
  const out = new Array<number>(NB).fill(0);
  for (let k = 1; k < nfft / 2; k++) {
    const f = (k * fs) / nfft;
    for (let b = 0; b < NB; b++) {
      if (f >= BAND_HZ[b] / Math.SQRT2 && f < BAND_HZ[b] * Math.SQRT2) {
        out[b] += (2 * (re[k] * re[k] + im[k] * im[k])) / nfft;
        break;
      }
    }
  }
  return out;
}

/** Bandwidth of the octave band b (Hz). */
export const bandWidth = (b: number) => BAND_HZ[b] * (Math.SQRT2 - 1 / Math.SQRT2);

/**
 * Asymmetric Hann window around time `t0` (s): rising half over `pre` seconds before, falling half over `post`
 * seconds after. Returns the windowed segment (starting at sample `start`) of the first channel `x`.
 */
export function windowSegment(x: ArrayLike<number>, fs: number, t0: number, pre: number, post: number): { seg: Float64Array; start: number } {
  const start = Math.max(0, Math.ceil((t0 - pre) * fs));
  const end = Math.min(x.length - 1, Math.floor((t0 + post) * fs));
  const seg = new Float64Array(Math.max(0, end - start + 1));
  for (let i = start; i <= end; i++) {
    const t = i / fs - t0;
    const w = t < 0 ? 0.5 * (1 + Math.cos((Math.PI * t) / pre)) : 0.5 * (1 + Math.cos((Math.PI * t) / post));
    seg[i - start] = x[i] * w;
  }
  return { seg, start };
}

/** Band energies (linear) of the window `pre`/`post` around `t0`. */
export function windowedBandEnergy(x: ArrayLike<number>, fs: number, t0: number, pre: number, post: number): number[] {
  return bandEnergies(windowSegment(x, fs, t0, pre, post).seg, fs);
}

export const db10 = (e: number) => 10 * Math.log10(e);

/** Index and time (s) of the abs-peak of `x` within t0 +- tol (s). */
export function findPeak(x: ArrayLike<number>, fs: number, t0: number, tol: number): { i: number; t: number; v: number } {
  const lo = Math.max(0, Math.round((t0 - tol) * fs));
  const hi = Math.min(x.length - 1, Math.round((t0 + tol) * fs));
  let best = lo;
  for (let i = lo; i <= hi; i++) if (Math.abs(x[i]) > Math.abs(x[best])) best = i;
  return { i: best, t: best / fs, v: x[best] };
}
