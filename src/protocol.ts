import type { DirectivityArgs } from './directivity';
import type { P3 } from './scene';

/**
 * `drag`: cheap early update (image sources) + a coarse tail (<= 2000 rays, at most ~4 Hz, not
 * interrupted once started). `settle`: early update, then the full ray count in interruptible
 * chunks (a newer request cancels it), with a coarse snapshot after the first ~2000 rays.
 */
export type Phase = 'drag' | 'settle';
export type Stage = 'early' | 'coarse' | 'final';

export interface ComputeRequest {
  type: 'compute';
  id: number;
  /** Source slot (0..3): each slot has its own pipeline; requests are latest-wins per slot. */
  slot: number;
  phase: Phase;
  scene: {
    height: number;
    walls: Float32Array; // [x1,y1,x2,y2,mat] rows
    materials: Float32Array; // [a x6, s, TL x6] rows
    floorMat: number;
    ceilMat: number;
    /** false: all walls opaque. */
    transmission: boolean;
  };
  source: P3;
  /** Radiation pattern of the source (`Source.angle` + `directivity`), see directivity.ts. */
  directivity: DirectivityArgs;
  listener: P3;
  maxOrder: number;
  /** Edge diffraction of the direct sound and of floor / ceiling reflections (UTD wedge diffraction around wall ends and over / under low obstacles). */
  diffraction: boolean;
  sampleRate: number;
  /** Low-frequency room modes (audio/modes.ts): the IR below the crossover is replaced by the modal response of an equivalent box. */
  modes: boolean;
  /** Number of stochastic rays for the late tail on `settle` (0 = ISM only). */
  rays: number;
  /** Number of traced rays to return for drawing (0 = none). */
  vizRays: number;
  /**
   * Coarse results normally synthesise only the first split+20 ms of the IR (cheap); with
   * `fullTail` they are full length (the late chain needs a first fill).
   */
  fullTail: boolean;
  /** Listener yaw (rad, CCW from +x) for the binaural early IR. Not part of the recompute key: `rebin` follows head turns. */
  yaw: number;
}

/** Re-render the binaural early IR of a slot from its cached third-order IR for a new head yaw (cheap). */
export interface RebinRequest {
  type: 'rebin';
  slot: number;
  yaw: number;
}

/** Binaural [L, R] early IR (direct sound + ISM reflections through the third-order HRTFs, windowed at the split). */
export type BinIr = [Float32Array, Float32Array];

export interface ComputeResult {
  type: 'result';
  id: number;
  slot: number;
  stage: Stage;
  /** FOA channels in ACN order W, Y, Z, X. `early`: ISM-only IR; otherwise the full IR (ISM + tail). */
  ir: Float32Array[];
  /** Early/late split time of the full IR, seconds. */
  splitSec: number;
  /** Samples per channel of the full IR (the `early` stage and partial coarse IRs are shorter). */
  totalSamples: number;
  /** Packed per path: [order, energy, nPts, crossedWalls, x0, y0, ...]. Only on the `early` stage (else empty). */
  paths: Float32Array;
  /** 7 rows (125..4k Hz, broadband) x 8 cols: EDT, T20, T30, C50, C80, D50, Sabine, Eyring. Empty on `early`. */
  metrics: Float32Array;
  /** [nbins, ETC dB (7 rows x nbins), Schroeder dB (7 rows x nbins)], 1 ms bins. Empty on `early`. */
  plot: Float32Array;
  /** Traced ray polylines for drawing: [nPts, x0, y0, ...]. */
  rayPaths: Float32Array;
  /** Binaural early IR of the ISM paths at the request's yaw. Only on the `early` stage (else null). */
  bin: BinIr | null;
  /** `ms`: compute time of this stage; `tMs`: since the worker started this request; `modesMs`: the part spent on room modes (0: off). */
  stats: { ms: number; tMs: number; pathCount: number; irSamples: number; rays: number; modesMs: number };
}

export interface ProgressMsg {
  type: 'progress';
  id: number;
  slot: number;
  done: number;
  total: number;
}

/** Heat map request: one track-length ray trace from a source for the ear-height slab. */
export interface HeatRequest {
  type: 'heat';
  id: number;
  scene: ComputeRequest['scene'];
  source: P3;
  directivity: DirectivityArgs;
  earZ: number;
  rays: number;
  minCell: number;
  maxCells: number;
}
/** Room analysis of a wall list (rows as in `ComputeRequest.scene.walls`); latest wins. */
export interface PlanRequest {
  type: 'plan';
  id: number;
  walls: Float32Array;
}
export type WorkerIn = ComputeRequest | RebinRequest | HeatRequest | PlanRequest | { type: 'heat-cancel' };

/** Packed faces of the room analysis, see `decodePlan` in editor/rooms.ts. */
export interface PlanResult {
  type: 'plan';
  id: number;
  faces: Float32Array;
}

/** Answer to a `rebin` request. */
export interface BinResult {
  type: 'bin';
  slot: number;
  yaw: number;
  bin: BinIr;
}

/** Heat map accumulators (partial or final): per cell [E(<50 ms), E(50-80 ms), E(>=80 ms)], row-major, y up. */
export interface HeatResult {
  type: 'heat';
  id: number;
  done: number;
  total: number;
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  cell: number;
  data: Float32Array;
}

export type WorkerOut = ComputeResult | BinResult | ProgressMsg | HeatResult | PlanResult | { type: 'ready' } | { type: 'error'; message: string };
