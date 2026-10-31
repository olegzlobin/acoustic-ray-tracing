import { describe, expect, it } from 'vitest';
import { parseWav16, resample, TOA_HRIR_BASE64, TOA_HRIR_RATE, toaFilters } from './toa-hrir';
import { splitIR, subtractEarlyIsm, windowEarly } from './split';

describe('toa-hrir', () => {
  it('parses the eight shipped WAV files into 16 filters of 256 frames at 48 kHz', () => {
    expect(TOA_HRIR_BASE64).toHaveLength(8);
    const w = parseWav16(TOA_HRIR_BASE64[0]);
    expect(w.rate).toBe(TOA_HRIR_RATE);
    expect(w.channels).toHaveLength(2);
    const f = toaFilters(48000);
    expect(f).toHaveLength(16);
    expect(f.every((x) => x.length === 256 && x.some((v) => v !== 0) && x.every((v) => Math.abs(v) <= 1))).toBe(true);
  });
  it('resampling keeps the length ratio and the DC gain', () => {
    const x = new Float32Array(480).fill(0.5);
    const y = resample(x, 48000, 44100);
    expect(y.length).toBe(Math.ceil((480 * 44100) / 48000));
    expect(y[y.length >> 1]).toBeCloseTo(0.5, 2);
    expect(toaFilters(44100)[0].length).toBe(Math.ceil((256 * 44100) / 48000));
  });
});

describe('early window helpers', () => {
  it('windowEarly equals splitIR().early; subtractEarlyIsm removes the windowed ISM part', () => {
    const fs = 1000, split = 0.2, n = 400;
    const ir = [Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.37))];
    const { early, late } = splitIR(ir, fs, split, true);
    expect(windowEarly(ir, fs, split)[0]).toEqual(early[0]);
    // with the ISM equal to the whole IR, full − window·ISM is exactly the late part
    const rest = subtractEarlyIsm(ir, ir, fs, split)[0];
    for (let i = 0; i < n; i++) expect(rest[i]).toBeCloseTo(late![0][i], 6);
  });
});
