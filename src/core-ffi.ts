// Typed wrapper around the raw C ABI of the Rust core (core/src/lib.rs). It is the only place that
// knows pointer/length conventions: inputs are copied into wasm memory for the duration of a call,
// outputs are copied out (wasm memory may grow and detach views on the next call). Binary layouts
// come from ./layout.

import { checkLayout, MATERIAL_STRIDE, OutKind, WALL_STRIDE } from './layout';
import type { P3, WorkerScene } from './scene';

interface CoreExports {
  memory: WebAssembly.Memory;
  alloc(bytes: number): number;
  dealloc(ptr: number, bytes: number): void;
  layout(i: number): number;
  set_scene(w: number, nw: number, m: number, nm: number, h: number, fm: number, cm: number, transmission: number): void;
  compute_early(slot: number, sx: number, sy: number, sz: number, lx: number, ly: number, lz: number, sr: number, order: number, irLen: number): number;
  late_begin(slot: number, sx: number, sy: number, sz: number, lx: number, ly: number, lz: number, order: number, rays: number, radius: number, viz: number): void;
  late_step(slot: number, count: number): number;
  late_snapshot(slot: number, limitS: number): number;
  prewarm_step(sr: number, maxLen: number): number;
  heat_begin(sx: number, sy: number, sz: number, earZ: number, rays: number, minCell: number, maxCells: number): number;
  heat_step(count: number): number;
  heat_snapshot(): number;
  heat_x0(): number;
  heat_y0(): number;
  heat_cell(): number;
  plan_analyze(walls: number, nWalls: number): number;
  set_hrir(ptr: number, taps: number): void;
  set_directivity(facing: number, alphaPtr: number, floor: number): void;
  set_diffraction(on: number): void;
  binaural_early(slot: number, yaw: number, fadeS: number): number;
  out_ptr(kind: number): number;
  out_len(kind: number): number;
  ir_len(): number; // samples per channel of the current ir output
  total_len(): number;
  split_s(): number;
}

/** Cell grid of the heat map: origin, cell size, size. */
export interface HeatGrid {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  cell: number;
}

export class Core {
  private constructor(private x: CoreExports) {
    checkLayout((i) => x.layout(i));
  }

  /** Instantiate from the wasm bytes (tests, offline tools). */
  static async fromBytes(bytes: BufferSource): Promise<Core> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Core(instance.exports as unknown as CoreExports);
  }

  /** Fetch and instantiate (streaming where the server sends the wasm MIME type). */
  static async load(url: string): Promise<Core> {
    const resp = await fetch(url);
    try {
      const { instance } = await WebAssembly.instantiateStreaming(resp.clone(), {});
      return new Core(instance.exports as unknown as CoreExports);
    } catch {
      // Server without application/wasm MIME type.
      return Core.fromBytes(await resp.arrayBuffer());
    }
  }

  /** Copy of output buffer `kind` (wasm memory may grow and detach views on the next call). */
  private out(kind: number) {
    return new Float32Array(this.x.memory.buffer, this.x.out_ptr(kind), this.x.out_len(kind)).slice();
  }
  /** Copy an f32 array into wasm memory (the view is created after alloc: memory may grow). */
  private put(a: Float32Array): number {
    const ptr = this.x.alloc(a.byteLength);
    new Float32Array(this.x.memory.buffer, ptr, a.length).set(a);
    return ptr;
  }

  // ---- scene

  setScene(s: WorkerScene) {
    const wp = this.put(s.walls);
    const mp = this.put(s.materials);
    this.x.set_scene(wp, s.walls.length / WALL_STRIDE, mp, s.materials.length / MATERIAL_STRIDE, s.height, s.floorMat, s.ceilMat, s.transmission ? 1 : 0);
    this.x.dealloc(wp, s.walls.byteLength);
    this.x.dealloc(mp, s.materials.byteLength);
  }

  /**
   * Room analysis of a wall list (WALL_STRIDE rows; the material column is ignored): the packed faces
   * `[nFaces, per face region, depth, area, nPts, x0, y0, ...]` (see `decodePlan` in editor/rooms.ts).
   */
  planFaces(walls: Float32Array): Float32Array {
    const wp = this.put(walls);
    this.x.plan_analyze(wp, walls.length / WALL_STRIDE);
    this.x.dealloc(wp, walls.byteLength);
    return this.out(OutKind.PLAN);
  }

  /** Edge diffraction of the direct sound and of floor / ceiling reflections for the following `computeEarly` (on by default in the core). */
  setDiffraction(on: boolean) {
    this.x.set_diffraction(on ? 1 : 0);
  }

  /**
   * Source directivity for the following `computeEarly`, `lateBegin` and `heatBegin` (see directivity.ts):
   * facing azimuth (rad CCW from +x), amplitude parameter alpha per band (125 Hz .. 4 kHz) and the gain floor.
   */
  setDirectivity(facing: number, alpha: ArrayLike<number>, floor: number) {
    const a = this.put(Float32Array.from(alpha));
    this.x.set_directivity(facing, a, floor);
    this.x.dealloc(a, 4 * alpha.length);
  }

  // ---- impulse response pipeline (per source slot)

  /** Stage 1: image sources. `irLen <= 0`: automatic IR length. Returns the number of ISM paths. */
  computeEarly(slot: number, src: P3, lis: P3, sampleRate: number, order: number, irLen = 0): number {
    return this.x.compute_early(slot, src[0], src[1], src[2], lis[0], lis[1], lis[2], sampleRate, order, irLen);
  }
  /** Stage 2a: start a chunked ray trace. `radius <= 0`: automatic receiver sphere. */
  lateBegin(slot: number, src: P3, lis: P3, order: number, rays: number, radius: number, vizRays: number) {
    this.x.late_begin(slot, src[0], src[1], src[2], lis[0], lis[1], lis[2], order, rays, radius, vizRays);
  }
  /** Stage 2b: trace up to `count` more rays; returns the number traced so far. */
  lateStep(slot: number, count: number): number {
    return this.x.late_step(slot, count);
  }
  /** Stage 2c: synthesise the tail from the rays traced so far (`limitS > 0`: first `limitS` seconds only). */
  lateSnapshot(slot: number, limitS = 0): number {
    return this.x.late_snapshot(slot, limitS);
  }
  /** Build one band-noise buffer; returns the number still missing (0 = done). */
  prewarmStep(sampleRate: number, maxLenS: number): number {
    return this.x.prewarm_step(sampleRate, maxLenS);
  }

  // ---- outputs of the last compute_early / late_snapshot

  /** FOA channels W, Y, Z, X of the current IR. */
  ir(): Float32Array[] {
    const n = this.x.ir_len();
    const all = new Float32Array(this.x.memory.buffer, this.x.out_ptr(OutKind.IR), 4 * n);
    return [0, 1, 2, 3].map((ch) => all.slice(ch * n, (ch + 1) * n));
  }
  /** ISM-only third-order channels (ACN, SN3D) of the last `computeEarly`, the first `limit` samples of each. */
  /** Load the binaural decoding filters (16 ACN channels of equal length) for the following requests. */
  setHrir(filters: Float32Array[]) {
    const taps = filters[0].length;
    const bytes = 16 * taps * 4;
    const p = this.x.alloc(bytes);
    const v = new Float32Array(this.x.memory.buffer, p, 16 * taps);
    filters.forEach((f, k) => v.set(f, k * taps));
    this.x.set_hrir(p, taps);
    this.x.dealloc(p, bytes);
  }
  /** Binaural early IR [L, R] of a slot's last `computeEarly` for a head turned by `yaw`, or null. */
  binauralEarly(slot: number, yaw: number, fadeS: number): [Float32Array, Float32Array] | null {
    const n = this.x.binaural_early(slot, yaw, fadeS);
    if (!n) return null;
    const all = new Float32Array(this.x.memory.buffer, this.x.out_ptr(OutKind.BIN), 2 * n);
    return [all.slice(0, n), all.slice(n, 2 * n)];
  }

  /** Samples per channel of the FULL IR for the current pose (`ir()` may be shorter). */
  totalSamples(): number {
    return this.x.total_len();
  }
  /** Early/late split time, seconds. */
  splitSec(): number {
    return this.x.split_s();
  }
  paths() {
    return this.out(OutKind.PATHS);
  }
  metrics() {
    return this.out(OutKind.METRICS);
  }
  plot() {
    return this.out(OutKind.PLOT);
  }
  rayPaths() {
    return this.out(OutKind.RAYVIZ);
  }

  // ---- heat map

  /** Start a heat-map trace; returns the grid, or null when there are no walls. */
  heatBegin(src: P3, earZ: number, rays: number, minCell: number, maxCells: number): HeatGrid | null {
    const g = this.x.heat_begin(src[0], src[1], src[2], earZ, rays, minCell, maxCells);
    if (g === 0) return null;
    return { nx: Math.floor(g / 65536), ny: g % 65536, x0: this.x.heat_x0(), y0: this.x.heat_y0(), cell: this.x.heat_cell() };
  }
  /** Trace up to `count` more rays; returns the number traced so far. */
  heatStep(count: number): number {
    return this.x.heat_step(count);
  }
  /** Accumulators of the rays so far, `HEAT_BINS` floats per cell, row-major, y up. */
  heatSnapshot(): Float32Array {
    this.x.heat_snapshot();
    return this.out(OutKind.HEAT);
  }
}

