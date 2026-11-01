import { describe, expect, it } from 'vitest';
import { analysisFor, isPhone } from './perf-mode.svelte';

describe('light mode', () => {
  it('is for small touch screens only', () => {
    expect(isPhone(true, 390)).toBe(true);
    expect(isPhone(true, 820)).toBe(false); // tablet
    expect(isPhone(false, 390)).toBe(false); // narrow desktop window
  });
  it('lowers the analysis settings', () => {
    expect(analysisFor(true).maxOrder).toBeLessThan(analysisFor(false).maxOrder);
    expect(analysisFor(true).rays).toBeLessThan(analysisFor(false).rays);
  });
});
