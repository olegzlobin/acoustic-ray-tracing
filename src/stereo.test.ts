import { describe, expect, it } from 'vitest';
import { makeSource } from './scene';
import { facing, isPairActive, pairPositions, wrapAngle } from './stereo';

const src = (pos: [number, number, number], width = 2) => ({ ...makeSource(0, pos), width });

describe('pairPositions', () => {
  it('puts L on the left of someone in front of the pair: facing +x, L is at −y', () => {
    const { l, r } = pairPositions({ ...src([5, 0, 1.2], 2), angle: 0 });
    expect(l[0]).toBeCloseTo(5);
    expect(l[1]).toBeCloseTo(-1);
    expect(r[1]).toBeCloseTo(1);
    expect(l[2]).toBe(1.2);
    expect(r[2]).toBe(1.2);
  });
  it('turns with the pair angle, not with the listener', () => {
    // facing −y (toward a listener in the south): L is at −x... seen from the listener looking north, left is −x
    const { l, r } = pairPositions({ ...src([0, 4, 1], 1), angle: -Math.PI / 2 });
    expect(l[0]).toBeCloseTo(-0.5);
    expect(r[0]).toBeCloseTo(0.5);
    expect(l[1]).toBeCloseTo(4);
  });
  it('is symmetric about the centre and separated by the width', () => {
    const { l, r } = pairPositions({ ...src([3, 2, 1], 3.4), angle: 1.1 });
    expect((l[0] + r[0]) / 2).toBeCloseTo(3);
    expect((l[1] + r[1]) / 2).toBeCloseTo(2);
    expect(Math.hypot(l[0] - r[0], l[1] - r[1])).toBeCloseTo(3.4);
  });
  it('facing() turns a pair toward the listener, wrapAngle keeps [0, 2π)', () => {
    expect(facing([5, 0], [0, 0])).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2);
    expect(wrapAngle(5 * Math.PI)).toBeCloseTo(Math.PI);
  });
});

describe('isPairActive', () => {
  it('needs a file signal, a stereo file and stereo on', () => {
    const s = { signal: 'file' as const, stereo: true };
    expect(isPairActive(s, 2)).toBe(true);
    expect(isPairActive(s, 6)).toBe(true);
    expect(isPairActive(s, 1)).toBe(false);
    expect(isPairActive(s, 0)).toBe(false);
    expect(isPairActive({ ...s, stereo: false }, 2)).toBe(false);
    expect(isPairActive({ ...s, signal: 'guitar' }, 2)).toBe(false);
    expect(isPairActive({ ...s, signal: 'mic' }, 2)).toBe(false);
  });
});
