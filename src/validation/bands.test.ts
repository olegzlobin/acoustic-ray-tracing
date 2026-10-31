import { describe, expect, it } from 'vitest';
import { BAND_HZ } from './bras-constants';
import { bandEnergies, bandWidth, fft, windowedBandEnergy } from './bands';

const FS = 44100;

describe('validation band analysis', () => {
  it('fft of an impulse is flat and of a cosine has one bin pair', () => {
    const re = new Float64Array(64);
    const im = new Float64Array(64);
    re[0] = 1;
    fft(re, im);
    re.forEach((v, i) => {
      expect(v).toBeCloseTo(1, 12);
      expect(im[i]).toBeCloseTo(0, 12);
    });
    const c = Float64Array.from({ length: 64 }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / 64));
    const z = new Float64Array(64);
    fft(c, z);
    expect(c[5]).toBeCloseTo(32, 9);
    expect(c[59]).toBeCloseTo(32, 9);
    expect(c[6]).toBeCloseTo(0, 9);
  });

  it('impulse: band energy per Hz is flat across the octave bands', () => {
    const x = new Float64Array(512);
    x[100] = 1;
    const e = bandEnergies(x, FS);
    const dens = e.map((v, b) => v / bandWidth(b));
    for (const d of dens) expect(d / dens[0]).toBeCloseTo(1, 1);
    // the same through the window, centred on the impulse
    const imp = new Float64Array(2000);
    imp[1000] = 1;
    const ew = windowedBandEnergy(imp, FS, 1000 / FS, 0.0006, 0.0018);
    const dw = ew.map((v, b) => v / bandWidth(b));
    for (const d of dw) expect(d / dw[0]).toBeCloseTo(1, 1);
  });

  it('sine: energy lands in its own band and obeys Parseval', () => {
    const n = 8192;
    BAND_HZ.forEach((fc, b) => {
      const x = Float64Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * fc * (i / FS)));
      const e = bandEnergies(x, FS, 16384);
      const total = e.reduce((s, v) => s + v, 0);
      expect(e[b] / total).toBeGreaterThan(0.99);
      expect(total / x.reduce((s, v) => s + v * v, 0)).toBeCloseTo(1, 1);
    });
  });
});
