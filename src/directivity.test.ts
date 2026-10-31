import { describe, expect, it } from 'vitest';
import { DIRECTIVITY, DIRECTIVITIES, directivityArgs, directivityGain } from './directivity';

describe('directivity patterns', () => {
  it('omni is 1 everywhere', () => {
    for (let b = 0; b < 6; b++) for (const c of [-1, -0.3, 0, 0.7, 1]) expect(directivityGain('omni', b, c)).toBe(1);
  });
  it('every pattern is 1 on axis and has 6 bands', () => {
    for (const k of DIRECTIVITIES) {
      expect(DIRECTIVITY[k].alpha).toHaveLength(6);
      for (let b = 0; b < 6; b++) expect(directivityGain(k, b, 1)).toBeCloseTo(1, 12);
    }
  });
  it('speaker: behind it is the floor at 4 kHz and nearly open at 125 Hz', () => {
    expect(directivityGain('speaker', 5, -1)).toBe(0.1);
    expect(directivityGain('speaker', 0, -1)).toBeCloseTo(0.9, 12);
    expect(directivityGain('speaker', 5, 0)).toBeCloseTo(0.3, 12);
  });
  it('voice is wider than the speaker at high frequencies and never below its floor', () => {
    expect(directivityGain('voice', 5, 0)).toBeGreaterThan(directivityGain('speaker', 5, 0));
    expect(directivityGain('voice', 5, -1)).toBe(0.25);
  });
  it('request arguments carry the facing angle and a copy of the table', () => {
    const a = directivityArgs({ directivity: 'speaker', angle: 1.5 });
    expect(a).toEqual({ facing: 1.5, alpha: [0.95, 0.85, 0.7, 0.55, 0.4, 0.3], floor: 0.1 });
    a.alpha[0] = 0;
    expect(DIRECTIVITY.speaker.alpha[0]).toBe(0.95);
  });
});
