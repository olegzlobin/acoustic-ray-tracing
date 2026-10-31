import { existsSync, readFileSync } from 'node:fs';
import { toaFilters } from './audio/toa-hrir';
import { describe, expect, it } from 'vitest';
import { Core } from './core-ffi';
import { DIRECTIVITY } from './directivity';
import { LAYOUT } from './layout';
import { PRESETS } from './presets';
import { toWorkerScene } from './scene';

const WASM = 'src/wasm/core.wasm';

// Needs the built core (npm run build:wasm); `npm run build` always has it.
describe.skipIf(!existsSync(WASM))('core FFI', () => {
  it('layout constants agree between Rust and TypeScript (Core.fromBytes checks them)', async () => {
    const c = await Core.fromBytes(readFileSync(WASM));
    expect(LAYOUT.length).toBe(17);
    expect(c).toBeTruthy();
  });

  it('directivity: a speaker facing away is quieter at 4 kHz, facing the listener keeps the direct sound', async () => {
    const c = await Core.fromBytes(readFileSync(WASM));
    const sc = PRESETS[0].make();
    c.setScene(toWorkerScene(sc));
    const [src, lis] = [sc.sources[0].pos, sc.listener];
    const toLis = Math.atan2(lis[1] - src[1], lis[0] - src[0]);
    const direct = (facing: number | null) => {
      if (facing === null) c.setDirectivity(0, DIRECTIVITY.omni.alpha, DIRECTIVITY.omni.floor);
      else c.setDirectivity(facing, DIRECTIVITY.speaker.alpha, DIRECTIVITY.speaker.floor);
      c.computeEarly(0, src, lis, 48000, 0);
      const w = c.ir()[0];
      return w.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    };
    const omni = direct(null);
    const away = direct(toLis + Math.PI);
    const to = direct(toLis);
    expect(away).toBeLessThan(omni);
    // facing the listener: only the elevation difference between source and ear (~cos el) separates it from omni
    expect(to).toBeGreaterThan(0.9 * omni);
    expect(to).toBeLessThanOrEqual(omni * 1.0001);
    c.setDirectivity(0, DIRECTIVITY.omni.alpha, 0);
  });

  it('runs the pipeline for a preset: paths, early IR, tail, metrics, heat map', async () => {
    const c = await Core.fromBytes(readFileSync(WASM));
    const sc = PRESETS[0].make();
    c.setScene(toWorkerScene(sc));
    const n = c.computeEarly(0, sc.sources[0].pos, sc.listener, 48000, 3);
    expect(n).toBeGreaterThan(30);
    expect(c.ir()).toHaveLength(4);
    // Binaural early part (built in the core from the cached paths). Living room: the source is west of the listener.
    c.setHrir(toaFilters(48000));
    const ild = (b: [Float32Array, Float32Array], from = 0, to = b[0].length) => {
      let l = 0, r = 0;
      for (let i = from; i < to; i++) (l += b[0][i] ** 2), (r += b[1][i] ** 2);
      return 10 * Math.log10(l / r);
    };
    const north = c.binauralEarly(0, Math.PI / 2, 0.01)!; // facing north: the source is on the left
    const south = c.binauralEarly(0, (3 * Math.PI) / 2, 0.01)!;
    const facing = c.binauralEarly(0, Math.PI, 0.01)!;
    expect(north[0].length).toBe(north[1].length);
    expect(north[0].length).toBe(Math.ceil(c.splitSec() * 48000) + 1 + 256);
    // the direct sound (around the strongest arrival) and, more softly, the whole early part
    const direct = (b: [Float32Array, Float32Array]) => {
      let pk = 0;
      for (let i = 0; i < b[0].length; i++) if (b[0][i] ** 2 + b[1][i] ** 2 > b[0][pk] ** 2 + b[1][pk] ** 2) pk = i;
      return ild(b, Math.max(0, pk - 64), pk + 192);
    };
    expect(direct(north)).toBeGreaterThan(6);
    expect(direct(south)).toBeLessThan(-6);
    expect(ild(north)).toBeGreaterThan(2);
    expect(ild(south)).toBeLessThan(-2);
    // facing the source: the direct sound is the same in both ears
    expect(Math.abs(direct(facing))).toBeLessThan(0.1);
    expect(c.paths().length).toBeGreaterThan(n * 4);
    c.lateBegin(0, sc.sources[0].pos, sc.listener, 3, 2000, 0, 0);
    expect(c.lateStep(0, 2000)).toBe(2000);
    c.lateSnapshot(0);
    expect(c.ir()[0].length).toBe(c.totalSamples());
    expect(c.metrics().length).toBe(7 * 8);
    expect(Number.isFinite(c.metrics()[2 * 8 + 2])).toBe(true); // T30 at 500 Hz
    const g = c.heatBegin(sc.sources[0].pos, 1.2, 2000, 0.5, 4000)!;
    expect(c.heatStep(2000)).toBe(2000);
    expect(c.heatSnapshot().length).toBe(g.nx * g.ny * 3);
  });
});
