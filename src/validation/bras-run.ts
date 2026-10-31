// BRAS validation runner: reads the measured RIRs (BRAS_DIR), simulates the same scenes through the core, analyses both
// with the same code (bras-analysis.ts) and collects everything in one result object (see bras-report.ts for the output).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Core } from '../core-ffi';
import { builtinById } from '../materials';
import type { P3 } from '../scene';
import { analyseRs1, analyseRs5, attenuation, deltaL, rs1Geometry, rs1Valid, rs5Geometry, type Rs1Analysis, type Rs1Geometry, type Rs5Analysis } from './bras-analysis';
import {
  C_CORE, C_MEAS, CSV_OCTAVE_CENTRE_IDX, FS, MAT, MAT_CSV, RS1_LS, RS1_MP, RS1_SURFACE_Z, RS5_LS, RS5_MP, RS5_REF, type Rs1Variant,
} from './bras-constants';
import { buildScene, simulate, type SimMaterial } from './bras-sim';
import { readWav } from './wav';

export const braConfigDir = () => process.env.BRAS_DIR ?? join(homedir(), 'data', 'bras');

/** Directory of the measured wavs of a scene: <BRAS_DIR>/<scene>/1 Scene descriptions/<scene ...>/RIRs/wav (first match). */
function wavDir(root: string, scene: 'RS1' | 'RS5'): string | null {
  const desc = join(root, scene, '1 Scene descriptions');
  if (!existsSync(desc)) return null;
  for (const d of readdirSync(desc)) {
    const p = join(desc, d, 'RIRs', 'wav');
    if (d.startsWith(scene) && existsSync(p)) return p;
  }
  return null;
}

export const braDataPresent = (root = braConfigDir()) => !!wavDir(root, 'RS1') && !!wavDir(root, 'RS5');

// ---------------------------------------------------------------- materials

export const SIM_VARIANTS = {
  Rigid: ['tiles'],
  Absorbing: ['a', 'b'],
  Diffuse: ['c', 'd'],
} as const;
export const SIM_VARIANT_TEXT: Record<string, string> = {
  tiles: 'Tiles (alpha, s from the DB)',
  a: 'RockFon, alpha at 0 deg (tube), s from the DB',
  b: 'RockFon, in-situ alpha matched to the incidence angle, s from the DB',
  c: 'MDF12 diffuser, angle-matched alpha, s = library "diffuser"',
  d: 'MDF12 diffuser, angle-matched alpha, s = 0',
};

const rockfonAngle = { 30: MAT.rockfon30, 45: MAT.rockfon45, 60: MAT.rockfon60 };
const mdfAngle = { 30: MAT.mdf12_30, 45: MAT.mdf12_45, 60: MAT.mdf12_60 };

export function simMaterial(key: string, angle: 30 | 45 | 60): SimMaterial {
  switch (key) {
    case 'tiles': return MAT.tiles;
    case 'a': return MAT.rockfon0;
    case 'b': return rockfonAngle[angle];
    case 'c': return { alpha: mdfAngle[angle].alpha, s: libraryDiffuserS() };
    case 'd': return { alpha: mdfAngle[angle].alpha, s: [0, 0, 0, 0, 0, 0] };
  }
  throw new Error(`unknown sim variant ${key}`);
}

export const libraryDiffuserS = (): SimMaterial['s'] => builtinById('diffuser')!.s.slice(0, 6) as SimMaterial['s'];

/** Octave means of the third-octave DB rows vs the constants: max absolute deviation per material; null without the CSVs. */
export function checkMaterials(root = braConfigDir()): Record<string, number> | null {
  const dir = join(root, 'surface', '3 Surface descriptions', '_csv', 'initial_estimates');
  if (!existsSync(dir)) return null;
  const out: Record<string, number> = {};
  for (const [k, file] of Object.entries(MAT_CSV)) {
    const rows = readFileSync(join(dir, file), 'utf8').trim().split('\n').map((l) => l.split(',').map(Number));
    const mean = (r: number[]) => CSV_OCTAVE_CENTRE_IDX.map((i) => (r[i - 1] + r[i] + r[i + 1]) / 3);
    const m = MAT[k as keyof typeof MAT] as { alpha: number[]; s?: number[] };
    let dev = 0;
    mean(rows[1]).forEach((v, b) => (dev = Math.max(dev, Math.abs(v - m.alpha[b]))));
    if (m.s && rows[2]) mean(rows[2]).forEach((v, b) => (dev = Math.max(dev, Math.abs(v - m.s![b]))));
    out[k] = dev;
  }
  return out;
}

// ---------------------------------------------------------------- RS1

export interface Rs1Case {
  variant: Rs1Variant;
  ls: number;
  mp: number;
  geo: Rs1Geometry;
  file: string;
  meas: Rs1Analysis;
  /** Sim analyses by sim variant key (tiles for Rigid; a, b / c, d otherwise). */
  sim: Record<string, Rs1Analysis>;
}

export interface Rs1Row {
  variant: Rs1Variant;
  simVariant: string;
  ls: number;
  mp: number;
  specular: boolean;
  angle: number;
  angleNominal: number;
  window: 'short' | 'long';
  valid: boolean[];
  meas: number[];
  sim: number[];
  err: number[];
}

export interface Rs1Result {
  skipped: string[];
  cases: Rs1Case[];
  rows: Rs1Row[];
}

const shiftZ = (p: P3, dz: number): P3 => [p[0], p[1], p[2] + dz];

export function runRs1(core: Core, root = braConfigDir()): Rs1Result {
  const dir = wavDir(root, 'RS1')!;
  const skipped: string[] = [];
  const found: { variant: Rs1Variant; ls: number; mp: number; file: string }[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^RS1_RIR_(Rigid|Absorbing|Diffuse)_LS(\d+)_MP(\d+)\.wav$/.exec(f);
    if (!m) continue;
    const [variant, ls, mp] = [m[1] as Rs1Variant, +m[2], +m[3]];
    if (!rs1Geometry(ls, mp)) skipped.push(`${f} (position of MP${String(mp).padStart(2, '0')} not known)`);
    else found.push({ variant, ls, mp, file: join(dir, f) });
  }
  const cases: Rs1Case[] = [];
  for (const { variant, ls, mp, file } of found) {
    const geo = rs1Geometry(ls, mp)!;
    const w = readWav(file);
    if (w.fs !== FS) throw new Error(`${file}: sample rate ${w.fs}, expected ${FS}`);
    const sim: Record<string, Rs1Analysis> = {};
    // Everything is shifted so that the reflecting surface is the floor z = 0 (positions are rigid coordinates).
    for (const key of SIM_VARIANTS[variant]) {
      const scene = buildScene(simMaterial(key, geo.angleNominal), false);
      const r = simulate(core, scene, RS1_LS[ls], RS1_MP[mp], 1, false);
      sim[key] = analyseRs1(r.x, geo, C_CORE);
    }
    cases.push({ variant, ls, mp, geo, file, meas: analyseRs1(w.x, geo, C_MEAS), sim });
  }
  const rows: Rs1Row[] = [];
  for (const c of cases) {
    if (c.variant === 'Rigid') continue;
    const rigid = cases.find((r) => r.variant === 'Rigid' && r.ls === c.ls && r.mp === c.mp);
    if (!rigid) {
      skipped.push(`${c.variant} LS${c.ls}-MP${c.mp}: no Rigid measurement of the same pair`);
      continue;
    }
    for (const key of SIM_VARIANTS[c.variant]) {
      for (const window of ['short', 'long'] as const) {
        const meas = deltaL(c.meas, rigid.meas, window);
        const sim = deltaL(c.sim[key], rigid.sim.tiles, window);
        if (!meas || !sim) continue;
        rows.push({
          variant: c.variant, simVariant: key, ls: c.ls, mp: c.mp, specular: c.geo.specular, angle: c.geo.angle, angleNominal: c.geo.angleNominal,
          window, valid: rs1Valid(window, c.geo, C_MEAS), meas, sim, err: sim.map((v, i) => v - meas[i]),
        });
      }
    }
  }
  return { skipped, cases, rows };
}

// ---------------------------------------------------------------- RS5

export interface Rs5Pair {
  ls: number;
  mp: number;
  visible: boolean;
  clearance: number;
  r: number;
  tExpectedMeas: number;
  tExpectedSim: number;
  meas: Rs5Analysis;
  sim: Rs5Analysis;
  /** Sim: number of paths from the core and how many carry energy (diagnostics for the floor-reflection note). */
  simPaths: number;
  simAudiblePaths: number;
  A: Record<'short' | 'long', { meas: number[]; sim: number[]; err: number[] }>;
}

export interface Rs5Result {
  pairs: Rs5Pair[];
}

export function runRs5(core: Core, root = braConfigDir()): Rs5Result {
  const dir = wavDir(root, 'RS5')!;
  const scene = buildScene(MAT.tiles, true);
  const raw = new Map<string, { meas: Rs5Analysis; sim: Rs5Analysis; paths: number; audible: number }>();
  const keyOf = (l: number, m: number) => `${l}-${m}`;
  for (const l of [1, 2, 3, 4]) {
    for (const m of [1, 2, 3, 4]) {
      const g = rs5Geometry(l, m);
      const w = readWav(join(dir, `RS5_RIR_LS${l}_MP${m}.wav`));
      if (w.fs !== FS) throw new Error(`RS5 LS${l}-MP${m}: sample rate ${w.fs}, expected ${FS}`);
      const s = simulate(core, scene, RS5_LS[l], RS5_MP[m], 2, true);
      let audible = 0;
      for (let i = 0; i < s.packed.length; ) {
        if (s.packed[i + 1] > 0) audible++;
        i += 4 + 2 * s.packed[i + 2];
      }
      raw.set(keyOf(l, m), { meas: analyseRs5(w.x, g, C_MEAS), sim: analyseRs5(s.x, g, C_CORE), paths: s.paths, audible });
    }
  }
  const gRef = rs5Geometry(RS5_REF.ls, RS5_REF.mp);
  const ref = raw.get(keyOf(RS5_REF.ls, RS5_REF.mp))!;
  const pairs: Rs5Pair[] = [];
  for (const l of [1, 2, 3, 4]) {
    for (const m of [1, 2, 3, 4]) {
      const g = rs5Geometry(l, m);
      const r = raw.get(keyOf(l, m))!;
      const A = {} as Rs5Pair['A'];
      for (const which of ['short', 'long'] as const) {
        const meas = attenuation(r.meas, g, ref.meas, gRef, which);
        const sim = attenuation(r.sim, g, ref.sim, gRef, which);
        A[which] = { meas, sim, err: sim.map((v, i) => v - meas[i]) };
      }
      pairs.push({
        ls: l, mp: m, visible: g.visible, clearance: g.clearance, r: g.r, tExpectedMeas: g.r / C_MEAS, tExpectedSim: g.r / C_CORE,
        meas: r.meas, sim: r.sim, simPaths: r.paths, simAudiblePaths: r.audible, A,
      });
    }
  }
  return { pairs };
}
