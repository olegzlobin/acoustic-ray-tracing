import { describe, expect, it } from 'vitest';
import type { Pt, Wall } from '../scene';
import { addPolyline } from './geometry';
import { analyzePlan } from '../test-core';
import { hasRoom } from './rooms';
import { arcPoints, circleSegments, edgesOk, ellipsePoints, rectPoints, regularPolygon, STAMPS } from './shapes';
import { fmtMeters, gridLevels, headScale, niceScaleLength, rulerTicks, speakerScale, wallWidthPx } from './scale';

const isClosed = (w: Wall[]) => hasRoom(analyzePlan(w));
const radii = (pts: Pt[], c: Pt) => pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]));

describe('shape generators', () => {
  it('rectangle has 4 corners and closes into joined walls', () => {
    const r = rectPoints([0, 0], [4, 3]);
    expect(r).toEqual([[0, 0], [4, 0], [4, 3], [0, 3]]);
    const w = addPolyline([], r, true, 'm');
    expect(w.length).toBe(4);
    expect(isClosed(w)).toBe(true);
  });
  it('Shift makes a square from the longer side, in any quadrant', () => {
    expect(rectPoints([0, 0], [4, 3], true)[2]).toEqual([4, 4]);
    expect(rectPoints([0, 0], [-2, 5], true)[2]).toEqual([-5, 5]);
  });
  it('regular polygon has n vertices on one circle and closes', () => {
    const p = regularPolygon([1, 1], [3, 1], 6);
    expect(p.length).toBe(6);
    radii(p, [1, 1]).forEach((r) => expect(r).toBeCloseTo(2, 9));
    expect(p[0][0]).toBeCloseTo(3, 9);
    expect(isClosed(addPolyline([], p, true, 'm'))).toBe(true);
    expect(regularPolygon([0, 0], [1, 0], 1).length).toBe(3); // clamped
  });
  it('polygon rotation snaps to 15 degrees', () => {
    const p = regularPolygon([0, 0], [2, 0.1], 5, 15);
    expect(Math.atan2(p[0][1], p[0][0])).toBeCloseTo(0, 9);
  });
  it('circle segment count is auto (0.5 m, 12..64) or clamped', () => {
    expect(circleSegments(0.3, 0.3)).toBe(12);
    expect(circleSegments(2, 2)).toBe(25);
    expect(circleSegments(50, 50)).toBe(64);
    expect(circleSegments(2, 2, 30)).toBe(30);
    expect(circleSegments(2, 2, 3)).toBe(12);
  });
  it('ellipse points satisfy the ellipse equation', () => {
    const e = ellipsePoints([2, 1], 3, 1.5, 24);
    expect(e.length).toBe(24);
    e.forEach((p) => expect(((p[0] - 2) / 3) ** 2 + ((p[1] - 1) / 1.5) ** 2).toBeCloseTo(1, 9));
    expect(isClosed(addPolyline([], e, true, 'm'))).toBe(true);
  });
  it('arc starts at p0, ends at p1, passes through the third point side and stays on one circle', () => {
    const a = arcPoints([0, 0], [4, 0], [2, 2]); // upper half circle r = 2
    expect(a[0]).toEqual([0, 0]);
    expect(a[a.length - 1]).toEqual([4, 0]);
    radii(a, [2, 0]).forEach((r) => expect(r).toBeCloseTo(2, 9));
    expect(Math.max(...a.map((p) => p[1]))).toBeCloseTo(2, 1);
    expect(a.every((p) => p[1] >= -1e-9)).toBe(true);
    const b = arcPoints([0, 0], [4, 0], [2, -2]); // lower side
    expect(b.every((p) => p[1] <= 1e-9)).toBe(true);
    const major = arcPoints([0, 0], [4, 0], [2, 4]); // pm beyond the semicircle -> major arc
    expect(Math.max(...major.map((p) => p[1]))).toBeCloseTo(4, 1);
    expect(arcPoints([0, 0], [4, 0], [2, 0]).length).toBe(2); // collinear
    expect(arcPoints([0, 0], [4, 0], [2, 2], 8).length).toBe(9);
  });
  it('edgesOk rejects tiny edges', () => {
    expect(edgesOk(rectPoints([0, 0], [1, 1]), true)).toBe(true);
    expect(edgesOk(rectPoints([0, 0], [0.01, 1]), true)).toBe(false);
  });
  it('stamps are closed loops', () => {
    for (const s of STAMPS) expect(isClosed(addPolyline([], s.make([3, 3]), true, 'm'))).toBe(true);
  });
});

describe('scale helpers', () => {
  it('scale bar picks a nice length of roughly 80..150 px across the zoom range', () => {
    for (let s = 3; s <= 600; s *= 1.07) {
      const { len, px } = niceScaleLength(s);
      expect([0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50]).toContain(len);
      if (s > 2 && s < 800) expect(px).toBeGreaterThan(65), expect(px).toBeLessThan(185);
    }
    expect(niceScaleLength(40).len).toBe(2);
    expect(niceScaleLength(100).len).toBe(1);
  });
  it('ruler ticks are labelled with 1-2-5 spacing and cover the range', () => {
    const t = rulerTicks(-0.3, 10.3, 40);
    const majors = t.filter((x) => x.major);
    expect(majors.map((x) => x.v)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(majors[1].label).toBe('2');
    expect(t.length).toBeGreaterThan(majors.length);
    expect(rulerTicks(0, 1, 1000).filter((x) => x.major && x.v > 0)[0].label).toMatch(/^0\.\d+$/);
    expect(fmtMeters(0.5, 0.1)).toBe('0.5');
  });
  it('grid levels adapt to zoom and stay on the snap grid', () => {
    expect(gridLevels(0.25, 40)).toEqual({ minor: 0.25, major: 2 });
    const far = gridLevels(0.25, 4);
    expect(far.minor * 4).toBeGreaterThanOrEqual(9);
    expect(far.minor / 0.25).toBe(2 ** Math.round(Math.log2(far.minor / 0.25)));
    expect(far.major).toBeGreaterThanOrEqual(far.minor);
  });
  it('icons keep the old pixel size when zoomed out and grow with physical size when zoomed in', () => {
    expect(speakerScale(40)).toBe(1);
    expect(headScale(40)).toBe(1);
    expect(headScale(1000)).toBeCloseTo(10, 9); // 0.2 m * 1000 px/m / 20 px
    expect(speakerScale(1000)).toBeCloseTo((0.3 * 1000) / 28, 9);
    expect(speakerScale(200)).toBeGreaterThan(speakerScale(100));
  });
  it('wall width is constant px when zoomed out, thicker (capped) when zoomed in', () => {
    expect(wallWidthPx(10)).toBe(4);
    expect(wallWidthPx(160)).toBeGreaterThan(4);
    expect(wallWidthPx(600)).toBe(7);
  });
});
