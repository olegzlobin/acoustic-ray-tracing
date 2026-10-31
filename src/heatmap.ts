// Heat map metrics, colour map and the layer description used by the plan canvas.

import { colormap, EMBER } from './colormaps';
import { HEAT_BINS } from './layout';
import { t, type Key } from './i18n.svelte';

export type HeatMetric = 'spl' | 'c50' | 'd50' | 'c80';

/** `label` and `unit` are dictionary keys (unit '' = none). */
export const HEAT_METRICS: { id: HeatMetric; label: Key; unit: Key | '' }[] = [
  { id: 'spl', label: 'heat.spl', unit: 'u.dbRelMax' },
  { id: 'c50', label: 'heat.c50', unit: 'u.db' },
  { id: 'd50', label: 'heat.d50', unit: '' },
  { id: 'c80', label: 'heat.c80', unit: 'u.db' },
];


/** Per-cell metric values; NaN where there is no energy. SPL is in dB re the maximum cell. */
export function heatValues(data: Float32Array, metric: HeatMetric): Float32Array {
  const n = data.length / HEAT_BINS;
  const out = new Float32Array(n);
  let max = 0;
  if (metric === 'spl') for (let i = 0; i < n; i++) max = Math.max(max, data[i * HEAT_BINS] + data[i * HEAT_BINS + 1] + data[i * HEAT_BINS + 2]);
  for (let i = 0; i < n; i++) {
    const e50 = data[i * HEAT_BINS], mid = data[i * HEAT_BINS + 1], late = data[i * HEAT_BINS + 2];
    const tot = e50 + mid + late;
    let v = NaN;
    if (tot > 0) {
      if (metric === 'spl') v = 10 * Math.log10(tot / max);
      else if (metric === 'd50') v = e50 / tot;
      else if (metric === 'c50') v = e50 > 0 && mid + late > 0 ? 10 * Math.log10(e50 / (mid + late)) : NaN;
      else v = e50 + mid > 0 && late > 0 ? 10 * Math.log10((e50 + mid) / late) : NaN;
    }
    out[i] = v;
  }
  return out;
}

/** Display range from the visible (masked-in, finite) cells: robust percentiles, SPL spans <= 40 dB. */
export function heatRange(values: Float32Array, mask: Uint8Array, metric: HeatMetric): [number, number] {
  const v: number[] = [];
  for (let i = 0; i < values.length; i++) if (mask[i] && Number.isFinite(values[i])) v.push(values[i]);
  if (!v.length) return [0, 1];
  v.sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  if (metric === 'd50') return [0, 1];
  let lo = q(0.02);
  let hi = q(0.98);
  if (metric === 'spl') {
    hi = v[v.length - 1]; // the loudest cell is 0 dB by definition
    lo = Math.max(lo, hi - 40);
  }
  return hi - lo < 1 ? [lo - 0.5, hi + 0.5] : [lo, hi];
}

// Ember colour map (brand scale): 256-entry LUT built once from the 11 stops.
const EMBER_LUT: [number, number, number][] = Array.from({ length: 256 }, (_, i) => colormap(EMBER, i / 255));
export function ember(t: number): [number, number, number] {
  const i = Math.round(Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * 255);
  return EMBER_LUT[i];
}
export const EMBER_CSS = `linear-gradient(90deg, ${EMBER.map((c, i) => `${c} ${(i / (EMBER.length - 1)) * 100}%`).join(', ')})`;

export interface HeatLayer {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  cell: number;
  values: Float32Array;
  mask: Uint8Array;
  vmin: number;
  vmax: number;
  opacity: number;
  label: string;
  unit: string;
  /** 0..1 */
  progress: number;
}

/** RGBA pixels for the layer, top row = highest y. Masked or empty cells are transparent. */
export function heatPixels(h: HeatLayer): Uint8ClampedArray {
  const px = new Uint8ClampedArray(h.nx * h.ny * 4);
  for (let iy = 0; iy < h.ny; iy++) {
    for (let ix = 0; ix < h.nx; ix++) {
      const c = iy * h.nx + ix;
      const o = ((h.ny - 1 - iy) * h.nx + ix) * 4;
      const v = h.values[c];
      if (!h.mask[c] || !Number.isFinite(v)) continue;
      const [r, g, b] = ember((v - h.vmin) / Math.max(1e-9, h.vmax - h.vmin));
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  }
  return px;
}

export function cellAt(h: Pick<HeatLayer, 'nx' | 'ny' | 'x0' | 'y0' | 'cell'>, x: number, y: number): number {
  const ix = Math.floor((x - h.x0) / h.cell), iy = Math.floor((y - h.y0) / h.cell);
  return ix < 0 || iy < 0 || ix >= h.nx || iy >= h.ny ? -1 : iy * h.nx + ix;
}

export function formatHeat(v: number, metric: HeatMetric): string {
  if (!Number.isFinite(v)) return '–';
  return metric === 'd50' ? v.toFixed(2) : `${v.toFixed(1)} ${t('u.db')}`;
}
