// BRAS validation: geometry, windowing and metrics of RS1 (single reflection) and RS5 (diffraction), applied identically
// to a measured and a simulated impulse response (see bands.ts). No file or core access here.

import { db10, findPeak, windowedBandEnergy } from './bands';
import { BAND_HZ, C_CORE, C_MEAS, FS, NB, RS1_LS, RS1_MP, RS5_LS, RS5_MP, RS5_REF, RS5_WALL_H, RS5_WALL_X } from './bras-constants';
import type { P3 } from '../scene';

/** Search range of the abs-peak around the geometric arrival time (s). */
export const PEAK_TOL = 0.0005;
/** Short window (BRAS documentation method): Hann half-windows before / after the peak (s). */
export const PRE = 0.0006;
export const POST = 0.0018;
/** RS1 long window: starts this long after the direct peak (s) and ends no later than LONG_POST_MAX after the reflection. */
export const LONG_GUARD = 0.001;
export const LONG_POST_MAX = 0.006;
/** RS5 long window: end after the first arrival (s). */
export const RS5_LONG_POST = 0.008;

const dist = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Is band b usable for a window of total length `len` s? Rule: len >= 2.4 ms * 500 Hz / fc (the 2.4 ms window is valid from 500 Hz); 125 Hz never. */
export const bandValid = (b: number, len: number) => b >= 1 && len >= (0.0024 * 500) / BAND_HZ[b] - 1e-9;

// ---------------------------------------------------------------- RS1

export interface Rs1Geometry {
  ls: number;
  mp: number;
  specular: boolean;
  /** Direct and reflected path length (m), plan angle of incidence (deg from the normal). */
  rDirect: number;
  rRefl: number;
  angle: number;
  /** Nearest tabulated angle (30, 45, 60). */
  angleNominal: 30 | 45 | 60;
  /** Reflection point x (m). */
  xRefl: number;
}

/** Geometry of the pair LSn-MPm in rigid coordinates (surface at z = 0); null if the mic position is unknown (MP04...). */
export function rs1Geometry(ls: number, mp: number): Rs1Geometry | null {
  const s = RS1_LS[ls];
  const m = RS1_MP[mp];
  if (!s || !m) return null;
  const rDirect = dist(s, m);
  const rRefl = dist(s, [m[0], m[1], -m[2]]);
  const xRefl = s[0] + ((m[0] - s[0]) * s[2]) / (s[2] + m[2]);
  const angle = (Math.atan2(xRefl - s[0], s[2]) * 180) / Math.PI;
  const angleNominal = ([30, 45, 60] as const).reduce((a, b) => (Math.abs(b - angle) < Math.abs(a - angle) ? b : a));
  return { ls, mp, specular: ls === mp, rDirect, rRefl, angle, angleNominal, xRefl };
}

export interface Rs1Analysis {
  /** Actual direct and reflection peak times (s) and amplitudes. */
  tDirect: number;
  tRefl: number;
  vDirect: number;
  vRefl: number;
  /** Peak amplitude / rms of the first 2 ms of the IR (before anything arrives); Infinity for noiseless sims. */
  snr: number;
  /** Band energies (dB, arbitrary reference) of the short and the long window; long is null if the gap is too short. */
  short: number[];
  long: number[] | null;
  /** Distance (s) of the window start from the direct peak: > 0 means the direct sound is excluded. */
  marginShort: number;
  marginLong: number | null;
  longPre: number;
  longPost: number;
}

export function analyseRs1(x: ArrayLike<number>, g: Rs1Geometry, c: number, fs = FS): Rs1Analysis {
  const d = findPeak(x, fs, g.rDirect / c, PEAK_TOL);
  const r = findPeak(x, fs, g.rRefl / c, PEAK_TOL);
  const n0 = Math.round(0.002 * fs);
  let ss = 0;
  for (let i = 0; i < n0; i++) ss += x[i] * x[i];
  const rms = Math.sqrt(ss / n0);
  const gap = (g.rRefl - g.rDirect) / c;
  const longPre = gap - LONG_GUARD;
  const longPost = Math.min(longPre, LONG_POST_MAX);
  const longOk = longPre >= 0.0024;
  const short = windowedBandEnergy(x, fs, r.t, PRE, POST).map(db10);
  return {
    tDirect: d.t,
    tRefl: r.t,
    vDirect: d.v,
    vRefl: r.v,
    snr: rms > 0 ? Math.abs(r.v) / rms : Infinity,
    short,
    long: longOk ? windowedBandEnergy(x, fs, r.t, longPre, longPost).map(db10) : null,
    marginShort: r.t - PRE - d.t,
    marginLong: longOk ? r.t - longPre - d.t : null,
    longPre,
    longPost,
  };
}

/** ΔL (dB) per band of a variant against the rigid IR of the same pair, short or long window. */
export function deltaL(variant: Rs1Analysis, rigid: Rs1Analysis, which: 'short' | 'long'): number[] | null {
  const a = variant[which];
  const b = rigid[which];
  return a && b ? a.map((v, i) => v - b[i]) : null;
}

/** Band flags of the RS1 windows: true = reliable. */
export const rs1Valid = (which: 'short' | 'long', g: Rs1Geometry, c: number): boolean[] => {
  const len = which === 'short' ? PRE + POST : (() => {
    const pre = (g.rRefl - g.rDirect) / c - LONG_GUARD;
    return pre + Math.min(pre, LONG_POST_MAX);
  })();
  return Array.from({ length: NB }, (_, b) => bandValid(b, len));
};

// ---------------------------------------------------------------- RS5

export interface Rs5Geometry {
  ls: number;
  mp: number;
  /** Direct line passes above the partition. */
  visible: boolean;
  /** Height of the direct line above (+) / below (-) the partition top at the partition (m). */
  clearance: number;
  /** Shortest path (direct if visible, else over the top edge), m. */
  r: number;
}

export function rs5Geometry(ls: number, mp: number): Rs5Geometry {
  const s = RS5_LS[ls];
  const m = RS5_MP[mp];
  const f = (RS5_WALL_X - s[0]) / (m[0] - s[0]);
  const zAt = s[2] + (m[2] - s[2]) * f;
  const clearance = zAt - RS5_WALL_H;
  const visible = clearance > 0;
  const r = visible
    ? dist(s, m)
    : Math.hypot(RS5_WALL_X - s[0], RS5_WALL_H - s[2]) + Math.hypot(m[0] - RS5_WALL_X, RS5_WALL_H - m[2]);
  return { ls, mp, visible, clearance, r };
}

export interface Rs5Analysis {
  t: number;
  v: number;
  snr: number;
  short: number[];
  long: number[];
}

export function analyseRs5(x: ArrayLike<number>, g: Rs5Geometry, c: number, fs = FS): Rs5Analysis {
  const p = findPeak(x, fs, g.r / c, PEAK_TOL);
  const n0 = Math.round(0.002 * fs);
  let ss = 0;
  for (let i = 0; i < n0; i++) ss += x[i] * x[i];
  const rms = Math.sqrt(ss / n0);
  return {
    t: p.t,
    v: p.v,
    snr: rms > 0 ? Math.abs(p.v) / rms : Infinity,
    short: windowedBandEnergy(x, fs, p.t, PRE, POST).map(db10),
    long: windowedBandEnergy(x, fs, p.t, PRE, RS5_LONG_POST).map(db10),
  };
}

/** Attenuation re free field A = L(pair) - L(ref) + 20 log10(r / r_ref), per band, for the short and the long window of the pair. */
export function attenuation(pair: Rs5Analysis, g: Rs5Geometry, ref: Rs5Analysis, gRef: Rs5Geometry, which: 'short' | 'long'): number[] {
  const corr = 20 * Math.log10(g.r / gRef.r);
  return pair[which].map((v, i) => v - ref.short[i] + corr);
}

export const RS5_REF_PAIR = RS5_REF;
export { C_CORE, C_MEAS };
