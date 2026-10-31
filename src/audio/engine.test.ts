import { describe, expect, it } from 'vitest';
import { signalNeedsRestart } from './engine';

describe('signalNeedsRestart', () => {
  it('does not restart a running player when the kind is unchanged', () => {
    expect(signalNeedsRestart('clap', 'clap', true)).toBe(false);
    expect(signalNeedsRestart('file', 'file', true)).toBe(false);
  });
  it('restarts when the kind changes or nothing is playing yet', () => {
    expect(signalNeedsRestart('clap', 'noise', true)).toBe(true);
    expect(signalNeedsRestart('clap', 'clap', false)).toBe(true);
  });
});
