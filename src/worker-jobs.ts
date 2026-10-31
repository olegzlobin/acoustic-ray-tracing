// Job factories of the compute worker: the work of one request split into units for the JobQueue.
//   early   image sources of one source slot (priority EARLY), then hands over to
//   tail    the stochastic ray tail in adaptive chunks (TAIL), with a coarse snapshot after ~2000 rays
//   heat    heat-map ray trace in adaptive chunks (HEAT)
//   plan    room analysis of the walls (PLAN)
//   prewarm noise-cache fill, lazily and only as long as the room needs (PREWARM)
import type { Core } from './core-ffi';
import type { DirectivityArgs } from './directivity';
import { Chunker, type Job, type StepResult } from './job-queue';
import { applyModes, DEFAULT_T, equivalentBox, highpassChannels, planModes, reverbTime, type ModeSetup } from './audio/modes';
import { SPLIT_FADE_S } from './audio/split';
import { decodePlan, type Plan } from './editor/plan-faces';
import { toaFilters } from './audio/toa-hrir';
import type { BinIr, ComputeRequest, ComputeResult, HeatRequest, HeatResult, PlanRequest, RebinRequest, Stage, WorkerOut } from './protocol';

export const PRIORITY = { PLAN: 0, EARLY: 0, TAIL: 1, HEAT: 2, PREWARM: 3 } as const;

/** Receiver sphere radius (m); 0 = automatic (grows with room volume, see core `late_begin`). */
const RADIUS = 0;
const DRAG_RAYS_MAX = 2000;
const DRAG_RAYS_MIN = 500;
/** Wall time budget of one drag-phase tail; the ray count adapts to the measured speed. */
const DRAG_TAIL_MS = 25;
const DRAG_TAIL_GAP_MS = 250;
/** Target duration of one interruptible chunk (ray chunk, heat chunk). */
const CHUNK_MS = 12;

export const computeKey = (slot: number) => `compute:${slot}`;
export const rebinKey = (slot: number) => `rebin:${slot}`;
export const HEAT_KEY = 'heat';
export const PLAN_KEY = 'plan';
const PREWARM_KEY = 'prewarm';

/** Low-frequency room modes of one slot's current request: fixed at its early stage, so ISM, bin and full IR share one crossover. */
interface SlotModes {
  setup: ModeSetup | null;
  fs: number;
}

export interface JobEnv {
  /** The loaded core; only called from inside steps (jobs may be created before the wasm is ready). */
  core(): Core;
  post(msg: WorkerOut, transfer?: Transferable[]): void;
  now(): number;
  /** Queue access for jobs that schedule others (early -> prewarm). */
  submit(job: Job): void;
}

export class ComputeJobs {
  private dragRays = new Map<number, number>();
  private lastTailStart = new Map<number, number>();
  private prewarmRate = 0;
  private prewarmLen = 0;
  /** Sample rate the core's binaural filters are loaded for (0: none yet). */
  private hrirRate = 0;
  private modeSlots = new Map<number, SlotModes>();
  /** Last known reverberation time (T30 at 125 Hz) per slot; the next request's crossover is derived from it. */
  private lastT = new Map<number, number>();
  /** Room analysis of the last walls the modes were built for. */
  private planCache: { walls: Float32Array; plan: Plan } | null = null;

  constructor(private env: JobEnv) {}

  early(req: ComputeRequest): Job {
    return { key: computeKey(req.slot), priority: PRIORITY.EARLY, step: () => this.runEarly(req) };
  }

  /** The core keeps one pattern for the next `computeEarly` / `lateBegin` / `heatBegin`: set it right before each. */
  private setDirectivity({ facing, alpha, floor }: DirectivityArgs) {
    this.env.core().setDirectivity(facing, alpha, floor);
  }

  /** Binaural early IR of a slot for another head yaw, from the cached third-order IR (nothing cached yet: ignored). */
  rebin(req: RebinRequest): Job {
    return {
      key: rebinKey(req.slot),
      priority: PRIORITY.EARLY,
      step: () => {
        const bin = this.binaural(req.slot, req.yaw);
        if (bin) this.env.post({ type: 'bin', slot: req.slot, yaw: req.yaw, bin }, [bin[0].buffer, bin[1].buffer]);
        return true;
      },
    };
  }

  /** Head at `yaw`: the slot's image-source paths through the third-order HRTFs (built in the core, which keeps the paths). */
  private binaural(slot: number, yaw: number): BinIr | null {
    const bin = this.env.core().binauralEarly(slot, yaw, SPLIT_FADE_S);
    const m = this.modeSlots.get(slot);
    if (bin && m?.setup) highpassChannels(m.setup, bin, m.fs);
    return bin;
  }

  /** Room analysis of `walls`, kept while they stay the same. */
  private planOf(walls: Float32Array): Plan {
    const c = this.planCache;
    if (c && c.walls.length === walls.length && c.walls.every((v, i) => v === walls[i])) return c.plan;
    const plan = decodePlan(this.env.core().planFaces(walls));
    this.planCache = { walls: walls.slice(), plan };
    return plan;
  }

  /** Modes for a request (null: off, or a big hall); T is the slot's last known reverberation time. */
  private prepareModes(req: ComputeRequest): ModeSetup | null {
    if (!req.modes) return null;
    const box = equivalentBox(this.planOf(req.scene.walls), req.scene.walls, req.scene.height, req.source, req.listener);
    return box ? planModes(box, this.lastT.get(req.slot) ?? DEFAULT_T) : null;
  }

  /** Room analysis (one unit, cheap); the UI uses it for warnings, placement and the heat-map mask. */
  plan(req: PlanRequest): Job {
    return {
      key: PLAN_KEY,
      priority: PRIORITY.PLAN,
      step: () => {
        const faces = this.env.core().planFaces(req.walls);
        this.env.post({ type: 'plan', id: req.id, faces }, [faces.buffer]);
        return true;
      },
    };
  }

  private postResult(req: ComputeRequest, stage: Stage, t0: number, tStage: number, rays: number, pathCount: number, modes: ModeSetup | null) {
    const c = this.env.core();
    const ir = c.ir();
    const early = stage === 'early';
    let modesMs = 0;
    const paths = early ? c.paths() : new Float32Array(0);
    const metrics = early ? new Float32Array(0) : c.metrics();
    const plot = early ? new Float32Array(0) : c.plot();
    const rayPaths = early ? new Float32Array(0) : c.rayPaths();
    const bin = early ? this.binaural(req.slot, req.yaw) : null; // high-passed at the crossover when modes are on
    if (modes) {
      const tm = this.env.now();
      if (early) highpassChannels(modes, ir, req.sampleRate);
      else {
        const T = reverbTime(metrics) ?? this.lastT.get(req.slot) ?? DEFAULT_T;
        this.lastT.set(req.slot, T);
        applyModes(modes, ir, req.sampleRate, T);
      }
      modesMs = this.env.now() - tm;
    } else if (!early) {
      const T = reverbTime(metrics);
      if (T) this.lastT.set(req.slot, T);
    }
    const now = this.env.now();
    const msg: ComputeResult = {
      type: 'result',
      id: req.id,
      slot: req.slot,
      stage,
      ir,
      splitSec: c.splitSec(),
      totalSamples: c.totalSamples(),
      paths,
      metrics,
      plot,
      rayPaths,
      bin,
      stats: { ms: now - tStage, tMs: now - t0, pathCount, irSamples: c.totalSamples(), rays, modesMs },
    };
    this.env.post(msg, [...ir.map((a) => a.buffer), paths.buffer, metrics.buffer, plot.buffer, rayPaths.buffer, ...(bin ? [bin[0].buffer, bin[1].buffer] : [])]);
  }

  /** Early stage of one request (image sources), plus the whole drag-phase tail if it is due; a settle tail is a successor job. */
  private runEarly(req: ComputeRequest): StepResult {
    const { now } = this.env;
    const c = this.env.core();
    const t0 = now();
    c.setScene(req.scene);
    const { source, listener, slot } = req;
    this.setDirectivity(req.directivity);
    c.setDiffraction(req.diffraction);
    const pathCount = c.computeEarly(slot, source, listener, req.sampleRate, req.maxOrder);
    const modes = this.prepareModes(req);
    this.modeSlots.set(slot, { setup: modes, fs: req.sampleRate });
    // Binaural decoding filters at this request's rate (parsed and resampled once per rate).
    if (req.sampleRate !== this.hrirRate) {
      c.setHrir(toaFilters(req.sampleRate));
      this.hrirRate = req.sampleRate;
    }
    this.postResult(req, 'early', t0, t0, 0, pathCount, modes);

    // Pre-warm the noise cache lazily, to the length this room needs (at most 8 s).
    const needS = Math.min(8, Math.ceil((c.totalSamples() / req.sampleRate) * 4) / 4);
    if (needS > this.prewarmLen || req.sampleRate !== this.prewarmRate) {
      this.prewarmLen = needS;
      this.prewarmRate = req.sampleRate;
      this.env.submit(this.prewarm(this.prewarmRate, this.prewarmLen));
    }

    const drag = req.phase === 'drag';
    const dr = this.dragRays.get(slot) ?? DRAG_RAYS_MAX;
    const target = drag ? Math.min(req.rays, dr) : req.rays;
    const previewLimit = req.fullTail ? 0 : c.splitSec() + 0.02;
    if (target === 0) {
      this.setDirectivity(req.directivity);
      c.lateBegin(slot, source, listener, req.maxOrder, 0, RADIUS, 0);
      const tS = now();
      c.lateSnapshot(slot);
      this.postResult(req, 'final', t0, tS, 0, pathCount, modes);
      return true;
    }
    if (drag) {
      if (now() - (this.lastTailStart.get(slot) ?? 0) < DRAG_TAIL_GAP_MS) return true; // tail rate limit
      this.lastTailStart.set(slot, now());
      this.setDirectivity(req.directivity);
      c.lateBegin(slot, source, listener, req.maxOrder, target, RADIUS, req.vizRays);
      // Small, uninterrupted: one coarse result.
      const tS = now();
      c.lateStep(slot, target);
      this.dragRays.set(slot, Math.round(Math.min(DRAG_RAYS_MAX, Math.max(DRAG_RAYS_MIN, (target * DRAG_TAIL_MS) / Math.max(1, now() - tS)))));
      c.lateSnapshot(slot, previewLimit);
      this.postResult(req, 'coarse', t0, tS, target, pathCount, modes);
      return true;
    }
    this.setDirectivity(req.directivity);
    c.lateBegin(slot, source, listener, req.maxOrder, target, RADIUS, req.vizRays);
    return this.tail(req, target, t0, pathCount, previewLimit, modes);
  }

  /** Settle-phase ray trace in interruptible chunks. */
  private tail(req: ComputeRequest, target: number, t0: number, pathCount: number, previewLimit: number, modes: ModeSetup | null): Job {
    const { now } = this.env;
    const c = this.env.core();
    const { slot } = req;
    const chunker = new Chunker({ init: 1000, min: 250, max: 5000, targetMs: CHUNK_MS, now });
    const tS = now();
    let done = 0;
    let coarseSent = target <= DRAG_RAYS_MAX * 1.5;
    return {
      key: computeKey(slot),
      priority: PRIORITY.TAIL,
      step: () => {
        done = chunker.step(target - done, (n) => c.lateStep(slot, n));
        this.env.post({ type: 'progress', id: req.id, slot, done, total: target });
        if (!coarseSent && done >= DRAG_RAYS_MAX) {
          coarseSent = true;
          const tc = now();
          c.lateSnapshot(slot, previewLimit);
          this.postResult(req, 'coarse', t0, tc, done, pathCount, modes);
        }
        if (done < target) return false;
        c.lateSnapshot(slot);
        this.postResult(req, 'final', t0, tS, target, pathCount, modes);
        return true;
      },
    };
  }

  /** Heat map: first unit sets up the grid, then chunks, with a partial snapshot every 25 %. */
  heat(req: HeatRequest): Job {
    const { now } = this.env;
    const chunker = new Chunker({ init: 2000, min: 500, max: 20000, targetMs: CHUNK_MS, now });
    let grid: ReturnType<Core['heatBegin']> = null;
    let started = false;
    let done = 0;
    let nextPost = 0.25;
    return {
      key: HEAT_KEY,
      priority: PRIORITY.HEAT,
      step: () => {
        const c = this.env.core();
        if (!started) {
          started = true;
          c.setScene(req.scene);
          this.setDirectivity(req.directivity);
          grid = c.heatBegin(req.source, req.earZ, req.rays, req.minCell, req.maxCells);
          return !grid;
        }
        done = chunker.step(req.rays - done, (n) => c.heatStep(n));
        const final = done >= req.rays;
        if (final || done / req.rays >= nextPost) {
          nextPost += 0.25;
          const data = c.heatSnapshot();
          this.env.post({ type: 'heat', id: req.id, done, total: req.rays, ...grid!, data } satisfies HeatResult, [data.buffer]);
        }
        return final;
      },
    };
  }

  private prewarm(rate: number, len: number): Job {
    return { key: PREWARM_KEY, priority: PRIORITY.PREWARM, step: () => this.env.core().prewarmStep(rate, len) === 0 };
  }
}
