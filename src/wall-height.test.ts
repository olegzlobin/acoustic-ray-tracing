import { describe, expect, it } from 'vitest';
import { duplicateWalls, parseClip, placeWalls, serializeClip } from './editor/clipboard';
import { addPolyline, moveVertex, moveWall, removeWall } from './editor/geometry';
import { flipWalls, rotateWalls, setMaterial, translateWalls } from './editor/transform';
import { PRESETS } from './presets';
import { TO_CEILING, cloneGeometry, isPartialWall, normalizeWallZ, packWalls, parseScene, serializeScene, toWorkerScene, wallRange, type Scene, type Wall } from './scene';
import { WALL_STRIDE } from './layout';
import { testCore } from './test-core';

const base = (): Scene => PRESETS[1].make();
const withTable = (z0?: number, z1?: number): Scene => {
  const s = base();
  const n = s.walls.length;
  s.walls = addPolyline(s.walls, [[2, 2], [3.4, 2], [3.4, 3], [2, 3]], true, 'wood').map((w, i) => (i >= n ? { ...w, ...(z0 !== undefined ? { z0 } : {}), ...(z1 !== undefined ? { z1 } : {}) } : w));
  return s;
};
const roundTrip = (s: Scene, compact = false) => {
  const r = parseScene(JSON.parse(JSON.stringify(serializeScene(s, compact))));
  expect(r.errors).toEqual([]);
  return r.scene!;
};

describe('wall heights: model', () => {
  it('defaults span the room; ranges are clamped; partial means not floor-to-ceiling', () => {
    const w: Wall = { a: [0, 0], b: [1, 0], mat: 'x' };
    expect(wallRange(w, 3)).toEqual([0, 3]);
    expect(isPartialWall(w, 3)).toBe(false);
    expect(isPartialWall({ ...w, z0: 0, z1: 3 }, 3)).toBe(false);
    expect(isPartialWall({ ...w, z1: 0.85 }, 3)).toBe(true);
    expect(isPartialWall({ ...w, z0: 2.6 }, 3)).toBe(true);
    expect(wallRange({ ...w, z0: -1, z1: 9 }, 3)).toEqual([0, 3]);
    expect(normalizeWallZ({ ...w, z0: 0, z1: 5 }, 3)).toEqual(w);
    expect(normalizeWallZ({ ...w, z0: 0.72, z1: 5 }, 3)).toEqual({ ...w, z0: 0.72 });
  });
  it('cloneGeometry keeps heights and does not alias', () => {
    const s = withTable(0.72, 0.75);
    const c = cloneGeometry(s);
    expect(c.walls).toEqual(s.walls);
    expect(c.walls.at(-1)!.z1).toBe(0.75);
    c.walls.at(-1)!.z1 = 1;
    expect(s.walls.at(-1)!.z1).toBe(0.75);
  });
});

describe('wall heights: files', () => {
  it('full-height walls stay 5-entry rows (old files are unchanged)', () => {
    const s = base();
    expect(serializeScene(s).walls.every((w) => w.length === 5)).toBe(true);
    const r = roundTrip(s);
    expect(r.walls).toEqual(s.walls);
    expect(r.walls.every((w) => w.z0 === undefined && w.z1 === undefined)).toBe(true);
  });
  it('appends z0, z1 only for partial walls and round-trips them (file and compact)', () => {
    const s = withTable(0.72, 0.75);
    s.walls.push({ a: [5, 5], b: [6, 5], mat: 'wood', z1: 0.85 }); // sofa: floor to 0.85
    s.walls.push({ a: [5, 6], b: [6, 6], mat: 'wood', z0: 2.6 }); // cloud: 2.6 to the ceiling
    for (const compact of [false, true]) {
      const ser = serializeScene(s, compact);
      const rows = ser.walls;
      expect(rows.filter((w) => w.length === 7)).toHaveLength(6);
      expect(rows.at(-2)).toEqual([5, 5, 6, 5, 'wood', 0, 0.85]);
      expect(rows.at(-1)).toEqual([5, 6, 6, 6, 'wood', 2.6, s.height]);
      const r = roundTrip(s, compact);
      expect(r.walls.slice(0, -2)).toEqual(s.walls.slice(0, -2));
      expect(r.walls.at(-2)).toEqual({ a: [5, 5], b: [6, 5], mat: 'wood', z1: 0.85 });
      expect(r.walls.at(-1)).toEqual({ a: [5, 6], b: [6, 6], mat: 'wood', z0: 2.6 });
    }
  });
  it('accepts 5 or 7 entries, clamps to the room height and drops a full range', () => {
    const o = JSON.parse(JSON.stringify(serializeScene(base()))) as { walls: unknown[][]; height: number };
    o.walls[0] = [...o.walls[0].slice(0, 5), 0.5, 99];
    o.walls[1] = [...o.walls[1].slice(0, 5), 0, o.height];
    o.walls[2] = [...o.walls[2].slice(0, 5), 0.2, 99];
    const r = parseScene(o);
    expect(r.errors).toEqual([]);
    expect(r.scene!.walls[0].z0).toBe(0.5);
    expect(r.scene!.walls[0].z1).toBeUndefined();
    expect('z0' in r.scene!.walls[1] || 'z1' in r.scene!.walls[1]).toBe(false);
    expect(r.scene!.walls[2].z0).toBe(0.2);
  });
  it('rejects invalid ranges and bad row lengths', () => {
    const bad = (row: (a: unknown[]) => unknown[]) => {
      const o = JSON.parse(JSON.stringify(serializeScene(base())));
      o.walls[0] = row(o.walls[0].slice(0, 5));
      return parseScene(o);
    };
    for (const extra of [[1, 1], [2, 1], [-0.1, 1], [0, 0], [0.5, NaN], ['a', 1], [10, 12]]) {
      const r = bad((a) => [...a, ...extra]);
      expect(r.scene, JSON.stringify(extra)).toBeNull();
      expect(r.errors.join()).toMatch(/walls\[0\]/);
    }
    expect(bad((a) => [...a, 0.5]).scene).toBeNull();
    expect(bad((a) => [...a, 0.5, 1, 2]).scene).toBeNull();
  });
});

describe('wall heights: packing', () => {
  it('packWalls uses stride 7: [x1, y1, x2, y2, mat, z0, z1], defaults 0 and "to the ceiling"', () => {
    expect(WALL_STRIDE).toBe(7);
    const p = packWalls([{ a: [1, 2], b: [3, 4], mat: 'x' }, { a: [5, 6], b: [7, 8], mat: 'x', z0: 0.72, z1: 0.75 }]);
    expect(p).toHaveLength(14);
    expect([...p.slice(0, 7)]).toEqual([1, 2, 3, 4, 0, 0, TO_CEILING]);
    expect([...p.slice(7, 14)]).toEqual([5, 6, 7, 8, 0, Math.fround(0.72), Math.fround(0.75)]);
  });
  it('toWorkerScene packs the heights next to the material index', () => {
    const s = withTable(0.72, 0.75);
    const w = toWorkerScene(s);
    const i = s.walls.length - 1;
    expect(w.walls).toHaveLength(s.walls.length * WALL_STRIDE);
    expect(w.walls[i * WALL_STRIDE + 4]).toBe(s.materials.findIndex((m) => m.id === 'wood'));
    expect([w.walls[i * WALL_STRIDE + 5], w.walls[i * WALL_STRIDE + 6]]).toEqual([Math.fround(0.72), Math.fround(0.75)]);
    expect([w.walls[5], w.walls[6]]).toEqual([0, TO_CEILING]);
  });
});

describe('wall heights: editor operations keep them', () => {
  const tall = (): Wall[] => [
    { a: [0, 0], b: [4, 0], mat: 'plaster', z1: 0.85 },
    { a: [4, 0], b: [4, 4], mat: 'plaster', z0: 0.72, z1: 0.75 },
    { a: [4, 4], b: [0, 4], mat: 'plaster' },
  ];
  const zs = (w: Wall[]) => w.map((x) => [x.z0, x.z1]);
  const want = zs(tall());
  it('transforms, material change, polyline edits', () => {
    const ws = tall();
    expect(zs(translateWalls(ws, [0, 1], 1, 1))).toEqual(want);
    expect(zs(rotateWalls(ws, [0, 1, 2], 90, [0, 0]))).toEqual(want);
    expect(zs(flipWalls(ws, [0], 'h', [0, 0]))).toEqual(want);
    expect(zs(setMaterial(ws, [1], 'wood'))).toEqual(want);
    expect(zs(addPolyline(ws, [[8, 8], [9, 8]], false, 'plaster').slice(0, 3))).toEqual(want);
    expect(zs(moveVertex(ws, [4, 0], [5, 0])!)).toEqual(want);
    expect(zs(moveWall(ws, 1, 0.5, 0)!)).toEqual(want);
    expect(zs(removeWall(ws, 2))).toEqual(want.slice(0, 2));
    expect('z0' in translateWalls(ws, [2], 1, 1)[2]).toBe(false);
  });
  it('copy, paste and duplicate; clipboard text round trip', () => {
    const ws = tall();
    const placed = placeWalls(ws, null, 0.5, new Set(['plaster']), 'plaster');
    expect(zs(placed)).toEqual(want);
    const d = duplicateWalls(ws, [0, 1]);
    expect(zs(d.walls.slice(3))).toEqual(want.slice(0, 2));
    const back = parseClip(serializeClip(ws))!;
    expect(back).toEqual(ws);
    expect(parseClip(serializeClip([{ a: [0, 0], b: [1, 0], mat: 'x' }]))).toEqual([{ a: [0, 0], b: [1, 0], mat: 'x' }]);
    expect(parseClip(JSON.stringify({ format: 'acoustic-ray-tracing/walls', walls: [[0, 0, 1, 0, 'x', 1, 0.5]] }))).toBeNull();
  });
});

describe('wall heights: through the core', () => {
  const run = (s: Scene, src: [number, number, number], lis: [number, number, number]) => {
    testCore.setScene(toWorkerScene(s));
    return testCore.computeEarly(0, src, lis, 48000, 1);
  };
  it('a table slab at ear height changes the paths, one under the line does not; full range equals no range', () => {
    const open = base();
    const src: [number, number, number] = [1.5, 2.5, 1.5];
    const lis: [number, number, number] = [4.5, 2.5, 1.5];
    const nOpen = run(open, src, lis);
    const nExplicit = run({ ...withTable(0, 99), walls: withTable(0, 99).walls }, src, lis);
    // a closed full-height box is a pillar: it blocks the direct path
    const nPillar = run(withTable(), src, lis);
    expect(nExplicit).toBe(nPillar);
    const nLow = run(withTable(0.72, 0.75), src, lis);
    const nEar = run(withTable(1.4, 1.6), src, lis);
    // low slab: the line passes above it; ear-height slab (opaque or leaky wood) is crossed
    expect(nLow).toBeGreaterThan(nOpen); // adds the cap reflections
    expect(nEar).not.toBe(nLow);
    expect(nPillar).not.toBe(nOpen);
  });
});
