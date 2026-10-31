import { describe, expect, it } from 'vitest';
import { applyModes, crossover, equivalentBox, listModes, lowpassZP, modalAvgEnergy, modalGain, modalLow, modeFreq, planModes, reverbTime, schroederFreq, type Box } from './modes';
import type { Plan } from '../editor/plan-faces';

const box = (lx: number, ly: number, lz: number, src: [number, number, number], lis: [number, number, number]): Box => ({ lx, ly, lz, area: lx * ly, src, lis, dist: Math.hypot(src[0] - lis[0], src[1] - lis[1], src[2] - lis[2]) });
const energy = (x: Float32Array) => x.reduce((s, v) => s + v * v, 0);
/** Power of `x` in a narrow band around f0 (Hz): single-bin DFT over +-bw. */
function bandPower(x: Float32Array, fs: number, f0: number, bw = 2): number {
  let p = 0;
  for (let f = f0 - bw; f <= f0 + bw + 1e-9; f += 0.5) {
    let re = 0, im = 0;
    const w = (2 * Math.PI * f) / fs;
    for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); }
    p += re * re + im * im;
  }
  return p;
}
function noise(n: number, seed = 1): Float32Array {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  return Float32Array.from({ length: n }, (_, i) => rnd() * Math.exp(-i / 6000));
}

describe('room modes', () => {
  it('frequencies of a 5x4x3 box', () => {
    const b = box(5, 4, 3, [1, 1, 1], [2, 2, 1]);
    const m = listModes(b, 100);
    expect(m[0].n).toEqual([1, 0, 0]);
    expect(m[0].f).toBeCloseTo(34.3, 5);
    expect(m[1].f).toBeCloseTo(42.875, 5); // (0,1,0)
    expect(m[2].f).toBeCloseTo(54.9, 1); // (1,1,0) tangential
    expect(m[3].f).toBeCloseTo(57.17, 1); // (0,0,1)
    expect(modeFreq([2, 0, 0], 5, 4, 3)).toBeCloseTo(68.6, 5);
    expect(m.every((x, i) => i === 0 || x.f >= m[i - 1].f)).toBe(true);
    expect(m.every((x) => x.f > 0 && x.f <= 100)).toBe(true);
    expect(m.length).toBe(listModes(b, 100).length);
  });

  it('a node of the (1,0,0) mode is much quieter near its frequency than the wall', () => {
    const fs = 48000;
    const src: [number, number, number] = [0.4, 0.5, 0.6];
    const at = (x: number) => planModes(box(5, 4, 3, src, [x, 1.3, 1.1]), 0.8)!;
    const n = 24000;
    const node = modalLow(at(2.5), 0.8, fs, n);
    const wall = modalLow(at(0), 0.8, fs, n);
    const ratioDb = 10 * Math.log10(bandPower(wall, fs, 34.3) / bandPower(node, fs, 34.3));
    expect(ratioDb).toBeGreaterThan(15);
  });

  it('energy averaged over listener positions equals the geometric low-band energy (1.5 dB)', () => {
    const fs = 48000;
    const [lx, ly, lz] = [4, 3.5, 2.6];
    const T = 0.5;
    const src: [number, number, number] = [1.1, 0.9, 1.3];
    const geo = noise(30000);
    const lp = geo.slice();
    const base = planModes(box(lx, ly, lz, src, [1, 1, 1]), T)!;
    lowpassZP(lp, base.fc, fs);
    const eGeo = energy(lp);
    const g = modalGain(eGeo, modalAvgEnergy(base, T, fs, geo.length));
    let sum = 0, cnt = 0;
    const [nx, ny, nz] = [8, 7, 6];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      const s = planModes(box(lx, ly, lz, src, [((i + 0.5) / nx) * lx, ((j + 0.5) / ny) * ly, ((k + 0.5) / nz) * lz]), T)!;
      sum += g * g * energy(modalLow(s, T, fs, geo.length));
      cnt++;
    }
    expect(Math.abs(10 * Math.log10(sum / cnt / eGeo))).toBeLessThan(1.5);
  });

  it('crossover: high-pass + low-pass reconstructs the input; -6 dB at fc', () => {
    const fs = 48000;
    const x = noise(20000, 7);
    const { lp, hp } = crossover(x, 150, fs);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(lp[i] + hp[i] - x[i]));
    expect(worst / x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeLessThan(1e-4);
    const sine = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 150 * i) / fs));
    const s = crossover(sine, 150, fs);
    const mid = (a: Float32Array) => Math.sqrt(energy(a.subarray(16000, 32000)) / 16000) * Math.SQRT2;
    expect(mid(s.lp)).toBeCloseTo(0.5, 1);
    expect(mid(s.hp)).toBeCloseTo(0.5, 1);
  });

  it('crossover and mode count: big halls are off, rooms are on', () => {
    expect(planModes(box(40, 25, 18, [5, 5, 1], [20, 10, 1]), 2.2)).toBeNull(); // f_s ~ 21 Hz
    const small = planModes(box(5, 4, 3, [1, 1, 1], [3, 2, 1.2]), 0.5)!;
    expect(small.fs).toBeCloseTo(schroederFreq(0.5, 60), 6);
    expect(small.fc).toBe(Math.min(small.fs, 200));
    expect(small.fmax).toBeCloseTo(1.5 * small.fc, 9);
    expect(planModes(box(10, 7, 3, [1, 1, 1], [3, 2, 1.2]), 5)!.fc).toBeLessThanOrEqual(200);
  });

  it('applyModes: W gets the modal part, the high end is untouched', () => {
    const fs = 48000;
    const s = planModes(box(5, 4, 3, [1, 1, 1], [3, 2, 1.2]), 0.5)!;
    const ir = [noise(20000, 1), noise(20000, 2), noise(20000, 3), noise(20000, 4)];
    const orig = ir.map((c) => c.slice());
    const g = applyModes(s, ir, fs, 0.5);
    expect(g).toBeGreaterThan(0);
    // far above fc the Y channel is unchanged by the high-pass (to rounding, at samples away from the edges)
    const lpY = orig[1].slice();
    lowpassZP(lpY, s.fc, fs);
    for (let i = 0; i < 20000; i += 997) expect(ir[1][i]).toBeCloseTo(orig[1][i] - lpY[i], 5);
  });

  it('equivalent box: face area preserved, points mapped and clamped; fallback to the wall bbox', () => {
    // L-shaped face: bbox 6x4 = 24, area 18 -> k = sqrt(0.75)
    const ring: [number, number][] = [[1, 1], [7, 1], [7, 3], [4, 3], [4, 5], [1, 5]];
    const plan: Plan = { faces: [{ ring, area: 18, region: 'room', depth: 0 }] };
    const b = equivalentBox(plan, new Float32Array(0), 2.7, [1, 1, 5], [6.9, 2, 1.2])!;
    expect(b.lx * b.ly).toBeCloseTo(18, 6);
    expect(b.lz).toBe(2.7);
    expect(b.src).toEqual([0, 0, 2.7]); // corner, z clamped to the height
    expect(b.lis[0]).toBeCloseTo(5.9 * Math.sqrt(0.75), 6);
    const walls = Float32Array.from([0, 0, 5, 0, 0, 0, 3, 5, 0, 5, 3, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]);
    const f = equivalentBox({ faces: [] }, walls, 3, [1, 1, 1], [2, 2, 1])!;
    expect([f.lx, f.ly]).toEqual([5, 3]);
    expect(equivalentBox({ faces: [] }, new Float32Array(0), 3, [1, 1, 1], [2, 2, 1])).toBeNull();
  });

  it('reverbTime: T30 125 Hz, else Sabine, else null', () => {
    const m = new Float32Array(56);
    expect(reverbTime(m)).toBeNull();
    m[6] = 0.7;
    expect(reverbTime(m)).toBeCloseTo(0.7, 6);
    m[2] = 0.9;
    expect(reverbTime(m)).toBeCloseTo(0.9, 6);
    m[2] = NaN;
    expect(reverbTime(m)).toBeCloseTo(0.7, 6);
  });
});
