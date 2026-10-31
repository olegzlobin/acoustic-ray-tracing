// Heat-map controller: settings, the debounced request to the worker (any change cancels the running
// trace), partial results and the layer the plan canvas draws. Construct it while a component is
// initialising (it registers an effect).

import { directivityArgs } from '../directivity';
import { t } from '../i18n.svelte';
import { heatMask, type Plan } from '../editor/rooms';
import { kfmt } from '../format';
import { HEAT_METRICS, heatRange, heatValues, type HeatLayer, type HeatMetric } from '../heatmap';
import type { HeatResult } from '../protocol';
import { toWorkerScene, type Scene } from '../scene';
import type { AcousticWorker } from '../worker-client';

interface HeatDeps {
  worker: AcousticWorker;
  scene: Scene;
  plan: () => Plan;
  transmission: () => boolean;
  /** Index of the source the map is traced from. */
  source: () => number;
}

const SETTLE_MS = 300;

export class HeatController {
  on = $state(false);
  metric = $state<HeatMetric>('spl');
  opacity = $state(0.65);
  rays = $state(50000);
  /** Progress of the trace; `status` renders it in the current language. */
  private stat = $state<'waiting' | { done: boolean; rays: string; pct: number } | null>(null);
  readonly status = $derived(this.stat === null ? '' : this.stat === 'waiting' ? t('heat.waiting') : this.stat.done ? t('heat.done', { rays: this.stat.rays }) : t('heat.tracing', { pct: this.stat.pct }));
  raw = $state<HeatResult | null>(null);

  private lastId = 0;
  private timer: number | undefined;
  private lastKey = '';

  readonly mask = $derived.by(() => (this.raw ? heatMask(this.deps.plan(), this.raw, this.deps.transmission()) : null));
  readonly layer = $derived.by((): HeatLayer | null => {
    const h = this.raw;
    const mask = this.mask;
    if (!this.on || !h || !mask) return null;
    const values = heatValues(h.data, this.metric);
    const [vmin, vmax] = heatRange(values, mask, this.metric);
    const meta = HEAT_METRICS.find((m) => m.id === this.metric)!;
    return { nx: h.nx, ny: h.ny, x0: h.x0, y0: h.y0, cell: h.cell, values, mask, vmin, vmax, opacity: this.opacity, label: t(meta.label), unit: meta.unit ? t(meta.unit) : '', progress: h.done / h.total };
  });

  constructor(private deps: HeatDeps) {
    deps.worker.onheat = (h) => {
      if (h.id < this.lastId) return;
      this.lastId = h.id;
      this.raw = h;
      this.stat = h.done >= h.total ? { done: true, rays: kfmt(h.total), pct: 100 } : { done: false, rays: '', pct: Math.round((100 * h.done) / h.total) };
    };
    $effect(() => this.request());
  }

  private request() {
    const { worker, scene } = this.deps;
    if (!this.on) {
      clearTimeout(this.timer);
      this.lastKey = '';
      worker.cancelHeat();
      return;
    }
    // Depends on geometry, the selected source and the ear height, NOT on the listener's x/y.
    const transmission = this.deps.transmission();
    const w = toWorkerScene(scene, transmission);
    const s = scene.sources[this.deps.source()];
    if (!s) return;
    const key = [w.height, w.floorMat, w.ceilMat, w.walls.join(), w.materials.join(), transmission, s.pos.join(), s.directivity, s.angle, scene.listener[2], this.rays].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;
    worker.cancelHeat(); // any change cancels the running trace at once
    clearTimeout(this.timer);
    this.stat = 'waiting';
    const src: [number, number, number] = [...s.pos];
    const directivity = directivityArgs(s);
    const earZ = scene.listener[2];
    const rays = this.rays;
    this.timer = window.setTimeout(() => worker.heat({ scene: w, source: src, directivity, earZ, rays, minCell: 0.5, maxCells: 4000 }), SETTLE_MS);
  }
}
