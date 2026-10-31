import { describe, expect, it } from 'vitest';
import { EQ_BANDS, FLAT_EQ, isFlat } from './eq';

describe('eq helpers', () => {
  it('FLAT_EQ is flat and any non-zero band is not', () => {
    expect(isFlat(FLAT_EQ)).toBe(true);
    expect(isFlat({ ...FLAT_EQ, highMid: 0.5 })).toBe(false);
    expect(isFlat({ ...FLAT_EQ, low: -3 })).toBe(false);
  });
  it('defines the four bands in ascending frequency', () => {
    expect(EQ_BANDS.map((b) => b.id)).toEqual(['low', 'lowMid', 'highMid', 'high']);
    const f = EQ_BANDS.map((b) => b.freq);
    expect(f).toEqual([...f].sort((a, b) => a - b));
  });
});
