// Compute orchestration: per-source analysis state fed by the worker (early / coarse / refining / final
// results), the requests sent for every change (cheap `drag` immediately, full `settle` after idle or on
// release), and the hand-over of IR pieces to the audio engine. Construct during component
// initialisation (it registers effects and terminates the worker on destroy).

import { onDestroy, untrack } from 'svelte';
import type { AudioEngine } from '../audio/engine';
import { splitIR, subtractEarlyIsm } from '../audio/split';
import { wasmOk } from '../capabilities';
import { directivityArgs } from '../directivity';
import { expose } from '../debug';
import { kfmt } from '../format';
import { t } from '../i18n.svelte';
import { analysisFor, perf } from '../perf-mode.svelte';
import type { BinIr, ComputeResult, Phase } from '../protocol';
import type { FullIr } from '../io/run-export';
import { toWorkerScene, type P3, type Scene } from '../scene';
import { pairPositions } from '../stereo';
import { AcousticWorker } from '../worker-client';
import type { SceneStore } from './scene-store.svelte';
import type { SlotMap } from './slots.svelte';

export type Stage = 'early' | 'coarse' | 'refining' | 'final';
export interface Analysis {
  paths: Float32Array | null;
  rayPaths: Float32Array | null;
  plot: Float32Array | null;
  metrics: Float32Array | null;
  stats: { ms: number; tMs: number; pathCount: number; irSamples: number; rays: number; modesMs: number } | null;
  refine: { stage: Stage; coarse: number; done: number; total: number };
}
const blank = (): Analysis => ({ paths: null, rayPaths: null, plot: null, metrics: null, stats: null, refine: { stage: 'early', coarse: 0, done: 0, total: 0 } });

// Audio-side bookkeeping (not displayed, so not reactive).
interface Aux {
  lastApplied: number;
  tailEarly: Float32Array[] | null;
  lastIsm: Float32Array[] | null;
  /** Early/late split time of the last result, seconds. */
  splitSec: number;
  /** Binaural early IR (ISM paths through the third-order HRTFs) at the last yaw the worker rendered. */
  bin: BinIr | null;
  lateValid: boolean;
  lastFull: { ir: Float32Array[]; sampleRate: number } | null;
}

/** One analysis job: a slot and the point it computes. A stereo pair has two (left = the source's own slot, right = its R slot). */
interface Job {
  i: number;
  slot: number;
  pos: P3;
  /** The right speaker of a pair. */
  right: boolean;
}

interface ComputeDeps {
  scene: Scene;
  store: SceneStore;
  slots: SlotMap;
  /** The audio engine, once it exists (it receives the IR pieces). */
  engine: () => AudioEngine | null;
  setError: (message: string) => void;
}

/** Every change sends a cheap `drag` request at once; after this idle time (or on pointer release) a `settle` request refines to the full ray count. */
const SETTLE_IDLE_MS = 150;

function add(a: Float32Array[], b: Float32Array[] | null): Float32Array[] {
  if (!b) return a;
  return a.map((ch, c) => {
    const out = new Float32Array(Math.max(ch.length, b[c].length));
    out.set(ch);
    for (let i = 0; i < b[c].length; i++) out[i] += b[c][i];
    return out;
  });
}

export class ComputeController {
  // Analysis settings and display flags (bound by the analysis panel)
  maxOrder = $state(analysisFor(perf.lite).maxOrder);
  /** Sound transmission through walls (off: every wall is opaque, for A/B comparison). */
  transmission = $state(true);
  /** Edge diffraction of the direct sound (off: walls cast a sharp shadow, as before). */
  diffraction = $state(true);
  /** Direct sound + ISM early reflections through per-path third-order HRTFs (off: everything via first-order Ambisonics, as before). */
  accurateHrtf = $state(true);
  /** Low-frequency room modes of an equivalent rectangular room below the Schroeder frequency (off: purely geometric IR, as before). */
  modes = $state(true);
  showOrders = $state([true, true, true, true]);
  rays = $state(analysisFor(perf.lite).rays);
  showRays = $state(false);
  showBands = $state([false, false, false, false, false, false, true]);
  showEtc = $state(true);
  showSchroeder = $state(true);

  analysis = $state<Record<number, Analysis>>({});
  /** Stub when the browser cannot run the worker: the UI still loads and explains. */
  readonly worker: AcousticWorker = wasmOk
    ? new AcousticWorker()
    : ({ compute: () => 0, heat: () => 0, analyzePlan: () => 0, rebin() {}, cancelHeat() {}, terminate() {}, onresult() {}, onbin() {}, onprogress() {}, onheat() {}, onplan() {}, onerror() {} } as unknown as AcousticWorker);

  private aux = new Map<number, Aux>();
  private settleTimers = new Map<number, number>();
  private lastKey = new Map<number, string>();
  // Diagnostics for benchmarking (only with ?debug in the URL).
  private perfLog: { id: number; slot: number; stage: string; ms: number; tMs: number }[] = [];

  /** Analysis of the selected source. */
  readonly cur = $derived.by(() => this.analysis[this.deps.slots.slotOf(this.deps.store.selSrc)] ?? blank());
  readonly refineText = $derived.by(() => {
    const r = this.cur.refine;
    if (r.stage === 'early') return t('refine.early');
    const c = r.coarse ? t('refine.coarse', { n: kfmt(r.coarse) }) : '';
    if (r.stage === 'coarse') return c;
    if (r.stage === 'refining') return `${c ? c + ' → ' : ''}${t('refine.refining', { pct: Math.round((100 * r.done) / Math.max(1, r.total)), n: kfmt(r.total) })}`;
    return `${c && r.coarse !== r.total ? c + ' → ' : ''}${kfmt(r.total)} ✓`;
  });

  constructor(private deps: ComputeDeps) {
    const { scene } = deps;
    expose('__arPerf', this.perfLog);
    expose('__arCompute', this);
    onDestroy(() => this.worker.terminate());
    this.worker.onresult = (r) => this.onResult(r);
    this.worker.onbin = (b) => {
      const a = this.aux.get(b.slot);
      if (!a || !deps.slots.allSlots().has(b.slot)) return;
      a.bin = b.bin;
      this.applyEarly(b.slot, a, false);
    };
    this.worker.onprogress = (p) => {
      if (p.id < this.auxOf(p.slot).lastApplied) return;
      const an = this.analysis[p.slot];
      if (an) an.refine = { ...an.refine, stage: 'refining', done: p.done, total: p.total };
    };
    this.worker.onerror = (m) => deps.setError(m);

    $effect(() => {
      void [scene.walls, scene.materials, scene.height, scene.floorMat, scene.ceilMat, this.maxOrder, this.transmission, this.modes];
      // Scene changes make every cached tail meaningless.
      for (const a of this.aux.values()) {
        a.tailEarly = null;
        a.lateValid = false;
      }
    });
    // Head turns: the worker re-renders the binaural early IRs from its cached third-order IRs. Switching the
    // option on refreshes them too (they are not re-rendered while it is off).
    $effect(() => {
      const yaw = scene.yaw;
      if (!this.accurateHrtf) return;
      for (const slot of deps.slots.allSlots()) this.worker.rebin(slot, yaw);
    });
    // Switching the option re-applies the early chains of all slots at once.
    $effect(() => {
      void this.accurateHrtf;
      if (!deps.engine()) return;
      untrack(() => {
        for (const [slot, a] of this.aux) this.applyEarly(slot, a, true);
      });
    });
    $effect(() => {
      const gk = this.geomKey();
      for (const job of this.jobs()) {
        const { slot } = job;
        const key = gk + '|' + job.pos.join() + '|' + this.dirKey(job);
        if (this.lastKey.get(slot) === key) continue;
        this.lastKey.set(slot, key);
        this.worker.compute(this.buildReq(job, 'drag'));
        clearTimeout(this.settleTimers.get(slot));
        this.settleTimers.set(slot, window.setTimeout(() => this.settleSlot(slot), SETTLE_IDLE_MS));
      }
    });
    // A slot that is no longer allocated (source removed, pair switched off) drops its state.
    $effect(() => {
      const live = deps.slots.allSlots();
      for (const slot of [...this.aux.keys(), ...Object.keys(this.analysis).map(Number), ...this.lastKey.keys(), ...this.settleTimers.keys()])
        if (!live.has(slot)) this.removeSlot(slot);
    });
  }

  private auxOf(slot: number): Aux {
    let a = this.aux.get(slot);
    if (!a) this.aux.set(slot, (a = { lastApplied: 0, tailEarly: null, lastIsm: null, splitSec: 0, bin: null, lateValid: false, lastFull: null }));
    return a;
  }
  /** Last full-length (refined) IR of a slot, for export. */
  lastFull = (slot: number) => this.auxOf(slot).lastFull;
  /** Binaural early IR of a slot at the last rendered yaw, or null. */
  lastBin = (slot: number) => this.auxOf(slot).bin;
  /** ISM-only FOA IR of a slot (early stage) and the split time it was windowed with, or null. */
  lastIsm = (slot: number) => {
    const a = this.auxOf(slot);
    return a.lastIsm ? { ir: a.lastIsm, splitSec: a.splitSec } : null;
  };
  /** Final full IR of a slot for rendering exports; with accurate HRTF on (and the binaural IR there) split into FOA remainder + binaural early IR. */
  exportIr = (slot: number): FullIr | null => {
    const a = this.auxOf(slot);
    const full = a.lastFull;
    if (!full) return null;
    if (!this.accurateHrtf || !a.bin || !a.lastIsm) return full;
    return { ...full, accurate: { foa: subtractEarlyIsm(full.ir, a.lastIsm, full.sampleRate, a.splitSec), bin: a.bin } };
  };
  isFinal = (slot: number) => this.analysis[slot]?.refine.stage === 'final' && !!this.auxOf(slot).lastFull;

  /** Light mode on or off: applies its analysis settings (they stay adjustable by hand afterwards). */
  setLite(on: boolean) {
    perf.set(on);
    Object.assign(this, analysisFor(on));
  }

  /** A source was removed (or its right speaker): forget the slot, so a later owner starts clean. */
  removeSlot(slot: number) {
    this.aux.delete(slot);
    this.lastKey.delete(slot);
    clearTimeout(this.settleTimers.get(slot));
    this.settleTimers.delete(slot);
    delete this.analysis[slot];
  }

  /** What to compute now: every source at its centre, or a stereo pair at its L / R points (the L result lives in the source's own slot). */
  private jobs(): Job[] {
    const { scene, slots } = this.deps;
    const out: Job[] = [];
    scene.sources.forEach((s, i) => {
      const r = slots.rSlotOf(i);
      const slot = slots.slotOf(i);
      if (r === undefined) out.push({ i, slot, pos: s.pos, right: false });
      else {
        const { l, r: rp } = pairPositions(s);
        out.push({ i, slot, pos: l, right: false }, { i, slot: r, pos: rp, right: true });
      }
    });
    return out;
  }

  private onResult(r: ComputeResult) {
    if (!this.deps.slots.allSlots().has(r.slot)) return; // freed meanwhile
    const engine = this.deps.engine();
    const a = this.auxOf(r.slot);
    if (r.id < a.lastApplied) return; // stale result
    a.lastApplied = r.id;
    const fs = engine?.sampleRate ?? 48000;
    this.perfLog.push({ id: r.id, slot: r.slot, stage: r.stage, ms: r.stats.ms, tMs: r.stats.tMs });
    if (this.perfLog.length > 500) this.perfLog.shift();
    const an = this.analysis[r.slot] ?? (this.analysis[r.slot] = blank());
    an.stats = r.stats;
    a.splitSec = r.splitSec;
    if (r.stage === 'early') {
      an.paths = r.paths;
      a.lastIsm = r.ir;
      a.bin = r.bin;
      if (an.refine.stage === 'final') an.refine = { ...an.refine, stage: 'early' };
      // Accurate: the FOA chain keeps its tail-only IR (silent until the first one); otherwise it follows the new ISM.
      this.applyEarly(r.slot, a, !this.accurateHrtf || !a.tailEarly);
      return;
    }
    an.plot = r.plot;
    an.metrics = r.metrics;
    an.rayPaths = r.rayPaths;
    const partial = r.ir[0].length < r.totalSamples; // coarse preview: first split+20 ms only
    const sp = splitIR(r.ir, fs, r.splitSec, !partial);
    if (!partial) a.lastFull = { ir: r.ir, sampleRate: fs };
    if (a.lastIsm) {
      // tail = full - ISM over the early region
      const len = sp.early[0].length;
      const ismIr = a.lastIsm;
      a.tailEarly = r.ir.map((ch, c) => {
        const t = new Float32Array(len);
        const ism = ismIr[c];
        for (let i = 0; i < len; i++) t[i] = ch[i] - (i < ism.length ? ism[i] : 0);
        return t;
      });
    }
    this.applyEarly(r.slot, a, true);
    // The late chain's buffer assignment is expensive on the main thread (FFT partitioning of a
    // multi-second IR): refresh it only with refined results, plus once per scene as a first fill.
    if (!partial && (r.stage === 'final' || !a.lateValid)) {
      engine?.setLate(r.slot, sp.late!);
      a.lateValid = true;
    }
    an.refine =
      r.stage === 'coarse'
        ? { stage: 'coarse', coarse: r.stats.rays, done: r.stats.rays, total: r.stats.rays }
        : { stage: 'final', coarse: an.refine.coarse, done: r.stats.rays, total: r.stats.rays };
  }

  /**
   * Hand the early IRs of a slot to the engine. Accurate HRTF: the binaural chain gets the per-path IR and the FOA
   * chain only the windowed tail part (`tailEarly`; silence while there is none); otherwise the FOA chain gets
   * window * (ISM + tail) and the binaural chain is cleared. `foa` false: leave the FOA chain alone.
   */
  private applyEarly(slot: number, a: Aux, foa: boolean) {
    const engine = this.deps.engine();
    if (!engine || !a.lastIsm || !this.deps.slots.allSlots().has(slot)) return;
    const fs = engine.sampleRate;
    const acc = this.accurateHrtf;
    engine.setEarlyBin(slot, acc ? a.bin : null);
    if (!foa) return;
    if (acc) engine.setEarly(slot, a.tailEarly ? splitIR(a.tailEarly, fs, a.splitSec, false).early : null);
    else engine.setEarly(slot, splitIR(add(a.lastIsm, a.tailEarly), fs, a.splitSec, false).early);
  }

  private buildReq(job: Job, phase: Phase) {
    const { scene, store } = this.deps;
    return {
      phase,
      slot: job.slot,
      scene: toWorkerScene(scene, this.transmission),
      source: [...job.pos] as [number, number, number],
      directivity: directivityArgs(scene.sources[job.i]),
      listener: [...scene.listener] as [number, number, number],
      maxOrder: this.maxOrder,
      diffraction: this.diffraction,
      modes: this.modes,
      sampleRate: this.deps.engine()?.sampleRate ?? 48000,
      rays: this.rays,
      vizRays: this.showRays && !job.right && job.i === store.selSrc ? 200 : 0,
      fullTail: !this.auxOf(job.slot).lateValid,
      yaw: untrack(() => this.deps.scene.yaw), // not a recompute trigger: head turns go through `rebin`
    };
  }

  /** Facing and pattern of a job's source (both speakers of a pair share the pair's). */
  private dirKey(job: Job): string {
    const s = this.deps.scene.sources[job.i];
    return s.directivity + ':' + s.angle;
  }

  // The part of the state that invalidates every source's tail.
  private geomKey() {
    const { scene } = this.deps;
    const w = toWorkerScene(scene, this.transmission);
    return [w.height, w.floorMat, w.ceilMat, w.walls.join(), w.materials.join(), this.transmission, this.diffraction, this.modes, this.maxOrder, this.rays, this.deps.engine()?.sampleRate ?? 0, scene.listener.join()].join('|');
  }

  private settleSlot(slot: number) {
    if (!this.settleTimers.has(slot)) return;
    clearTimeout(this.settleTimers.get(slot));
    this.settleTimers.delete(slot);
    const job = this.jobs().find((j) => j.slot === slot);
    if (job) this.worker.compute(this.buildReq(job, 'settle'));
  }
  /** Pointer released (or similar): refine all pending sources (both speakers of a pair) now. */
  settleNow = () => {
    for (const job of this.jobs()) this.settleSlot(job.slot);
  };
}
