import { describe, expect, it } from 'vitest';
import { setLang } from './i18n.svelte';
import { cellAt, formatHeat, heatPixels, heatRange, heatValues, ember } from './heatmap';

describe('heat map metrics', () => {
  // two cells: [early, mid, late]
  const data = Float32Array.from([8, 0, 2, 1, 1, 8]);
  it('computes SPL re max, C50, D50 and C80', () => {
    const spl = heatValues(data, 'spl');
    expect(spl[0]).toBeCloseTo(0, 6); // 10 vs 10
    expect(spl[1]).toBeCloseTo(0, 6);
    const c50 = heatValues(data, 'c50');
    expect(c50[0]).toBeCloseTo(10 * Math.log10(8 / 2), 5);
    expect(c50[1]).toBeCloseTo(10 * Math.log10(1 / 9), 5);
    expect(heatValues(data, 'd50')[0]).toBeCloseTo(0.8, 6);
    expect(heatValues(data, 'c80')[1]).toBeCloseTo(10 * Math.log10(2 / 8), 5);
  });
  it('marks empty cells NaN', () => {
    expect(Number.isNaN(heatValues(Float32Array.from([0, 0, 0, 1, 1, 1]), 'c50')[0])).toBe(true);
  });
  it('ranges ignore masked cells and cap SPL at 40 dB', () => {
    const v = Float32Array.from([0, -10, -80, 5]);
    const [lo, hi] = heatRange(v, Uint8Array.from([1, 1, 1, 0]), 'spl');
    expect(hi).toBeLessThanOrEqual(0);
    expect(hi - lo).toBeLessThanOrEqual(40);
    expect(heatRange(v, Uint8Array.from([1, 1, 1, 1]), 'd50')).toEqual([0, 1]);
  });
  it('maps colours and cells', () => {
    expect(ember(0)).toEqual([10, 17, 33]);
    expect(ember(1)).toEqual([250, 242, 216]);
    const layer = { nx: 2, ny: 2, x0: 0, y0: 0, cell: 1, values: Float32Array.from([0, 1, NaN, 1]), mask: Uint8Array.from([1, 1, 1, 0]), vmin: 0, vmax: 1, opacity: 1, label: '', unit: '', progress: 1 };
    const px = heatPixels(layer);
    // cell (0,0) is the bottom-left -> second image row
    expect(px[(1 * 2 + 0) * 4 + 3]).toBe(255);
    expect(px[(1 * 2 + 0) * 4]).toBe(10);
    expect(px[(0 * 2 + 0) * 4 + 3]).toBe(0); // cell (0,1) NaN
    expect(px[(0 * 2 + 1) * 4 + 3]).toBe(0); // cell (1,1) masked
    expect(cellAt(layer, 1.5, 0.5)).toBe(1);
    expect(cellAt(layer, 2.5, 0.5)).toBe(-1);
    setLang('en');
    expect(formatHeat(3.14159, 'c50')).toBe('3.1 dB');
    expect(formatHeat(0.456, 'd50')).toBe('0.46');
    setLang('ru');
    expect(formatHeat(3.14159, 'c50')).toBe('3.1 дБ');
  });
});
