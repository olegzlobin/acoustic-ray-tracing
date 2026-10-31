import { describe, expect, it } from 'vitest';
import { FILE_RMS_DB, fileGain } from './levels';

const rmsDb = (x: Float32Array) => 10 * Math.log10(x.reduce((a, v) => a + v * v, 0) / x.length);

describe('fileGain', () => {
  it('brings a loud file down to the target RMS, ignoring silence', () => {
    const sr = 8000;
    const x = new Float32Array(sr * 4); // 2 s of loud sine, then 2 s of silence
    for (let i = 0; i < sr * 2; i++) x[i] = 0.5 * Math.sin(i * 0.3);
    const g = fileGain([x], sr);
    expect(rmsDb(x.slice(0, sr * 2).map((v) => v * g))).toBeCloseTo(FILE_RMS_DB, 0);
  });
  it('caps the peak of very spiky files and leaves silence alone', () => {
    const x = new Float32Array(8000);
    x[100] = 0.01; // a lone click: the RMS target would need a huge gain
    expect(fileGain([x], 8000)).toBeLessThanOrEqual(0.5 / 0.01 + 1e-9);
    expect(fileGain([new Float32Array(100)], 8000)).toBe(1);
  });
});
