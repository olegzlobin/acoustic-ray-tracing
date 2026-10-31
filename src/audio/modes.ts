// Low-frequency room modes. Geometric acoustics (image sources + rays) has no standing waves, so below the
// Schroeder frequency f_s = 2000 sqrt(T/V) a small room sounds too smooth in the bass. Here the low part of the IR
// (below the crossover f_c) is replaced by the modal response of an equivalent rectangular room:
//   - the box keeps the floor area of the room face that holds the listener (plan sides from the face's bounding box,
//     scaled by k = sqrt(A_face / A_bbox)) and the room height; source and listener are mapped into it;
//   - modes (nx, ny, nz) up to 1.5 f_c, each a damped sine weighted by shape(source) * shape(listener) / omega;
//   - zero-phase 4th-order Linkwitz-Riley split at f_c (forward/backward Butterworth-2: |LP| = 1/(1+(f/f_c)^4),
//     HP = x - LP, so HP + LP = x exactly); the geometric IR keeps only its HP part, the modal IR its LP part;
//   - level: the modal IR is scaled so that its energy, averaged over listener positions, equals the energy of the
//     low-passed geometric W channel (the spatial average of the squared mode shape is analytic).
// Pure functions; the worker applies them (worker-jobs.ts). Nothing here touches the DOM or the core.

import { pointInRing, type Plan } from '../editor/plan-faces';
import { WALL_STRIDE } from '../layout';
import type { P3 } from '../scene';

export const SOUND_SPEED = 343;
/** Below this Schroeder frequency (big halls) the modes are off. */
export const MODES_MIN_FS = 60;
/** The crossover never goes above this. */
export const MODES_FC_MAX = 200;
/** Reverberation time (s) when nothing better is known. */
export const DEFAULT_T = 0.6;
/** The modal IR is cut where its envelope has dropped by this factor (1e-5 = -100 dB). */
const ENVELOPE_CUT = 11.5; // in time constants tau
const TAU_PER_T = 1 / 6.91;

/** Equivalent rectangular room: sides, the floor area it preserves, and source / listener inside it. */
export interface Box {
  lx: number;
  ly: number;
  lz: number;
  /** Floor area of the room face (= lx * ly). */
  area: number;
  src: P3;
  lis: P3;
  /** Real source-listener distance (m), for the onset delay. */
  dist: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function ringBounds(ring: [number, number][]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * Box of the room face containing the listener (smallest such room face); no such face: the bounding box of the walls
 * (rows of `walls` as in `ComputeRequest.scene.walls`). null: nothing to build a box from.
 */
export function equivalentBox(plan: Plan, walls: Float32Array, height: number, src: P3, lis: P3): Box | null {
  let face: { ring: [number, number][]; area: number } | null = null;
  for (const f of plan.faces) {
    if (f.region !== 'room' || !pointInRing([lis[0], lis[1]], f.ring)) continue;
    if (!face || f.area < face.area) face = f;
  }
  let b: ReturnType<typeof ringBounds>;
  let area: number;
  if (face && face.ring.length >= 3) {
    b = ringBounds(face.ring);
    area = face.area;
  } else {
    const pts: [number, number][] = [];
    for (let i = 0; i + 3 < walls.length; i += WALL_STRIDE) pts.push([walls[i], walls[i + 1]], [walls[i + 2], walls[i + 3]]);
    if (!pts.length) return null;
    b = ringBounds(pts);
    area = (b.x1 - b.x0) * (b.y1 - b.y0);
  }
  const bboxArea = (b.x1 - b.x0) * (b.y1 - b.y0);
  if (!(bboxArea > 0) || !(area > 0) || !(height > 0)) return null;
  const k = Math.sqrt(Math.min(1, area / bboxArea));
  const lx = (b.x1 - b.x0) * k;
  const ly = (b.y1 - b.y0) * k;
  const map = (p: P3): P3 => [clamp((p[0] - b.x0) * k, 0, lx), clamp((p[1] - b.y0) * k, 0, ly), clamp(p[2], 0, height)];
  return { lx, ly, lz: height, area: lx * ly, src: map(src), lis: map(lis), dist: Math.hypot(src[0] - lis[0], src[1] - lis[1], src[2] - lis[2]) };
}

/** Schroeder frequency (Hz) for reverberation time `T` (s) and volume `V` (m^3). */
export const schroederFreq = (T: number, V: number) => 2000 * Math.sqrt(T / V);

/** T30 at 125 Hz of the core metrics (7 rows x 8 cols), else Sabine 125 Hz, else null. */
export function reverbTime(metrics: ArrayLike<number>): number | null {
  const ok = (v: number) => Number.isFinite(v) && v > 0.05 && v < 60;
  if (metrics.length >= 8 && ok(metrics[2])) return metrics[2];
  if (metrics.length >= 8 && ok(metrics[6])) return metrics[6];
  return null;
}

export interface Mode {
  n: [number, number, number];
  /** Frequency, Hz. */
  f: number;
  /** Normalisation weight w = eps / omega. */
  w: number;
  /** Mean of the squared shape over the room: product of (1 for n = 0, 1/2 otherwise). */
  avg: number;
  /** w * shape(source). */
  aS: number;
  /** Shape at the listener. */
  psiL: number;
}

const shape = (n: [number, number, number], l: [number, number, number], p: P3) =>
  Math.cos((n[0] * Math.PI * p[0]) / l[0]) * Math.cos((n[1] * Math.PI * p[1]) / l[1]) * Math.cos((n[2] * Math.PI * p[2]) / l[2]);

/** Frequency of mode `n` of a box. */
export const modeFreq = (n: ArrayLike<number>, lx: number, ly: number, lz: number) => (SOUND_SPEED / 2) * Math.hypot(n[0] / lx, n[1] / ly, n[2] / lz);

/** All modes of the box with 0 < f <= fmax, ascending in frequency, with source / listener shapes. */
export function listModes(box: Box, fmax: number): Mode[] {
  const { lx, ly, lz } = box;
  const l: [number, number, number] = [lx, ly, lz];
  const out: Mode[] = [];
  const mx = Math.floor((2 * lx * fmax) / SOUND_SPEED);
  const my = Math.floor((2 * ly * fmax) / SOUND_SPEED);
  const mz = Math.floor((2 * lz * fmax) / SOUND_SPEED);
  for (let i = 0; i <= mx; i++)
    for (let j = 0; j <= my; j++)
      for (let k = 0; k <= mz; k++) {
        if (!i && !j && !k) continue;
        const n: [number, number, number] = [i, j, k];
        const f = modeFreq(n, lx, ly, lz);
        if (f > fmax) continue;
        const eps = (i ? 2 : 1) * (j ? 2 : 1) * (k ? 2 : 1);
        const w = eps / (2 * Math.PI * f);
        out.push({ n, f, w, avg: (i ? 0.5 : 1) * (j ? 0.5 : 1) * (k ? 0.5 : 1), aS: w * shape(n, l, box.src), psiL: shape(n, l, box.lis) });
      }
  return out.sort((a, b) => a.f - b.f);
}

/** Everything fixed for one (room, source, listener): box, crossover and modes. Reverberation time enters later (`applyModes`). */
export interface ModeSetup {
  box: Box;
  /** Schroeder frequency the crossover was derived from. */
  fs: number;
  /** Crossover frequency, Hz. */
  fc: number;
  fmax: number;
  modes: Mode[];
}

/** Modes for `box` at reverberation time `T`; null (off) for big halls (f_s < 60 Hz) or when no mode fits. */
export function planModes(box: Box, T: number): ModeSetup | null {
  const fs = schroederFreq(T, box.area * box.lz);
  if (!(fs >= MODES_MIN_FS)) return null;
  const fc = Math.min(fs, MODES_FC_MAX);
  const fmax = 1.5 * fc;
  const modes = listModes(box, fmax);
  return modes.length ? { box, fs, fc, fmax, modes } : null;
}

// ---------------------------------------------------------------- crossover

/** Zero-phase low-pass in place: 2nd-order Butterworth forward and backward, |H| = 1 / (1 + (f/fc)^4). */
export function lowpassZP(x: Float32Array, fc: number, fs: number): void {
  const K = Math.tan((Math.PI * Math.min(fc, 0.45 * fs)) / fs);
  const norm = 1 / (1 + Math.SQRT2 * K + K * K);
  const b0 = K * K * norm;
  const b1 = 2 * b0;
  const a1 = 2 * (K * K - 1) * norm;
  const a2 = (1 - Math.SQRT2 * K + K * K) * norm;
  const n = x.length;
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    const y = b0 * v + s1;
    s1 = b1 * v - a1 * y + s2;
    s2 = b0 * v - a2 * y;
    x[i] = y;
  }
  s1 = 0; s2 = 0;
  for (let i = n - 1; i >= 0; i--) {
    const v = x[i];
    const y = b0 * v + s1;
    s1 = b1 * v - a1 * y + s2;
    s2 = b0 * v - a2 * y;
    x[i] = y;
  }
}

/** Complementary pair: `lp + hp === x` (up to float rounding). */
export function crossover(x: Float32Array, fc: number, fs: number): { lp: Float32Array; hp: Float32Array } {
  const lp = x.slice();
  lowpassZP(lp, fc, fs);
  const hp = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) hp[i] = x[i] - lp[i];
  return { lp, hp };
}

/** High-pass `x` in place at `fc` (what is left after removing the zero-phase low-pass); returns the removed low part (a view of `scratch` when given). */
export function highpassInPlace(x: Float32Array, fc: number, fs: number, scratch?: Float32Array): Float32Array {
  const lp = scratch && scratch.length >= x.length ? scratch.subarray(0, x.length) : new Float32Array(x.length);
  lp.set(x);
  lowpassZP(lp, fc, fs);
  for (let i = 0; i < x.length; i++) x[i] -= lp[i];
  return lp;
}

/** Magnitude of the zero-phase low-pass at `f`. */
export const lowpassGain = (f: number, fc: number) => 1 / (1 + (f / fc) ** 4);

// ---------------------------------------------------------------- modal response

/** Envelope time constant (amplitude) for reverberation time T. */
export const modeTau = (T: number) => T * TAU_PER_T;

/**
 * Raw modal IR (before the crossover): sum of w_n psi_n(S) psi_n(L) sin(omega_n t) exp(-t/tau), starting at sample
 * `delay`, `n` samples long. Synthesised at a low rate (6 x the highest mode) by resonator recursion and interpolated
 * with a windowed sinc, which is far cheaper than a sine per mode per sample.
 */
export function modalRaw(setup: ModeSetup, T: number, fs: number, n: number, delay = 0): Float32Array {
  const out = new Float32Array(n);
  const tau = modeTau(T);
  const nm = Math.min(n - delay, Math.ceil(ENVELOPE_CUT * tau * fs));
  if (nm <= 0) return out;
  const D = Math.max(1, Math.floor(fs / (6 * setup.fmax)));
  const dt = D / fs;
  const nd = Math.ceil(nm / D) + 1;
  const y = new Float64Array(nd);
  const decay = Math.exp(-dt / tau);
  for (const m of setup.modes) {
    const a = m.aS * m.psiL;
    if (a === 0) continue;
    const wd = 2 * Math.PI * m.f * dt;
    const rr = decay * Math.cos(wd);
    const ri = decay * Math.sin(wd);
    let zr = 1, zi = 0;
    for (let k = 0; k < nd; k++) {
      y[k] += a * zi;
      const t = zr * rr - zi * ri;
      zi = zr * ri + zi * rr;
      zr = t;
    }
  }
  if (D === 1) {
    for (let i = 0; i < nm; i++) out[delay + i] = y[i];
    return out;
  }
  // Windowed-sinc interpolation, half width H decimated samples, one kernel row per output phase.
  const H = 8;
  const kern = new Float64Array(D * 2 * H);
  for (let p = 0; p < D; p++)
    for (let q = 0; q < 2 * H; q++) {
      const x = p / D - (q - H + 1); // distance in decimated samples to tap j = i0 - H + 1 + q
      const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      kern[p * 2 * H + q] = s * (0.42 + 0.5 * Math.cos((Math.PI * x) / H) + 0.08 * Math.cos((2 * Math.PI * x) / H)); // Blackman
    }
  for (let i = 0; i < nm; i++) {
    const i0 = Math.floor(i / D);
    const p = i - i0 * D;
    const base = p * 2 * H;
    let acc = 0;
    for (let q = 0; q < 2 * H; q++) {
      const j = i0 - H + 1 + q;
      if (j >= 0 && j < nd) acc += y[j] * kern[base + q];
    }
    out[delay + i] = acc;
  }
  return out;
}

/** Modal IR after the low-pass at f_c (unscaled, see `modalGain`). */
export function modalLow(setup: ModeSetup, T: number, fs: number, n: number, delay = 0): Float32Array {
  const m = modalRaw(setup, T, fs, n, delay);
  lowpassZP(m, setup.fc, fs);
  return m;
}

/**
 * Expected energy (sum of squares of the samples) of `modalLow` averaged over listener positions: the modes are
 * orthogonal in space, so it is the sum of the single-mode energies with the squared listener shape replaced by its
 * spatial mean.
 */
export function modalAvgEnergy(setup: ModeSetup, T: number, fs: number, n: number, delay = 0): number {
  const tau = modeTau(T);
  const len = Math.max(0, n - delay) / fs;
  const decay = 1 - Math.exp((-2 * len) / tau);
  let e = 0;
  for (const m of setup.modes) {
    const w = 2 * Math.PI * m.f;
    // integral of exp(-2t/tau) sin^2(wt): half of (tau/2 (1 - e^-2L/tau) minus the oscillating part)
    const integral = 0.5 * ((tau / 2) * decay - (2 / tau) / (4 / (tau * tau) + 4 * w * w));
    e += m.aS * m.aS * m.avg * lowpassGain(m.f, setup.fc) ** 2 * Math.max(0, integral);
  }
  return e * fs;
}

/** Scale that gives the modal IR the energy of the low-passed geometric IR (on average over listener positions); 0 if either is empty. */
export function modalGain(eGeo: number, eMod: number): number {
  return eGeo > 0 && eMod > 1e-30 ? Math.sqrt(eGeo / eMod) : 0;
}

/** Onset delay of the modal IR (samples): the sound has to reach the listener first. */
export const modeDelay = (setup: ModeSetup, fs: number) => Math.round((setup.box.dist / SOUND_SPEED) * fs);

/**
 * Replace the low end of a full FOA IR (W, Y, Z, X; in place): high-pass all four channels at f_c and add the
 * calibrated modal IR to W. `T` (s) sets the decay. Returns the gain applied to the modal IR.
 */
export function applyModes(setup: ModeSetup, ir: Float32Array[], fs: number, T: number): number {
  const n = ir[0].length;
  const scratch = new Float32Array(n);
  const lpW = highpassInPlace(ir[0], setup.fc, fs, scratch);
  let eGeo = 0;
  for (let i = 0; i < n; i++) eGeo += lpW[i] * lpW[i];
  for (let c = 1; c < ir.length; c++) highpassInPlace(ir[c], setup.fc, fs, scratch);
  const delay = modeDelay(setup, fs);
  const g = modalGain(eGeo, modalAvgEnergy(setup, T, fs, n, delay));
  if (g === 0) return 0;
  const m = modalLow(setup, T, fs, n, delay);
  for (let i = 0; i < n; i++) ir[0][i] += g * m[i];
  return g;
}

/** High-pass the early pieces (ISM FOA IR, binaural L/R) at f_c, in place, so the low end exists only once. */
export function highpassChannels(setup: ModeSetup, chans: Float32Array[], fs: number): void {
  const scratch = new Float32Array(Math.max(0, ...chans.map((c) => c.length)));
  for (const c of chans) highpassInPlace(c, setup.fc, fs, scratch);
}
