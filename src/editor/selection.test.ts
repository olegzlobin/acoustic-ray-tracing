import { describe, expect, it } from 'vitest';
import type { Pt, Wall } from '../scene';
import { duplicateWalls, parseClip, pasteClip, pasteInto, placeWalls, serializeClip } from './clipboard';
import { addPolyline } from './geometry';
import { analyzePlan } from '../test-core';
import { hasRoom, locate } from './rooms';
import { normRect, selectInRect, toggleIn, wallTouches } from './selection';

const isClosed = (w: Wall[]) => hasRoom(analyzePlan(w));
import { bboxCenter, flipWalls, rotateWalls, selectionBBox, translateWalls } from './transform';

const room = () => addPolyline([], [[0, 0], [10, 0], [10, 8], [0, 8]], true, 'plaster');
const wall = (a: Pt, b: Pt): Wall => ({ a, b, mat: 'plaster' });
const key = (p: Pt) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
const vertexCount = (ws: Wall[]) => new Set(ws.flatMap((w) => [key(w.a), key(w.b)])).size;

describe('rubber-band selection', () => {
  const walls = [wall([1, 1], [2, 1]), wall([2, 1], [6, 1]), wall([5, 5], [6, 6]), wall([-5, 3], [15, 3])];
  const r = normRect([0, 0], [3, 2]);
  it('window mode needs walls completely inside', () => {
    expect(selectInRect(walls, r, false)).toEqual([0]);
  });
  it('crossing mode takes every wall touching the rectangle', () => {
    expect(selectInRect(walls, r, true)).toEqual([0, 1]);
    expect(wallTouches(walls[3], r)).toBe(false);
    expect(wallTouches(walls[3], normRect([0, 0], [3, 4]))).toBe(true); // passes straight through
    expect(wallTouches(wall([-1, -1], [4, 3]), r)).toBe(true); // diagonal, endpoints both outside
    expect(wallTouches(wall([-1, 5], [4, 5]), r)).toBe(false);
  });
  it('toggles membership and keeps indices sorted', () => {
    expect(toggleIn([1, 3], 2)).toEqual([1, 2, 3]);
    expect(toggleIn([1, 2, 3], 2)).toEqual([1, 3]);
  });
});

describe('group transforms', () => {
  const box = () => addPolyline(room(), [[3, 3], [5, 3], [5, 5], [3, 5]], true, 'wood'); // walls 4..7 form a pillar
  const ids = [4, 5, 6, 7];
  it('translate moves only the selection and keeps its joints', () => {
    const w = translateWalls(box(), ids, 1, 2);
    expect(w.slice(0, 4)).toEqual(room());
    expect(vertexCount(w.slice(4))).toBe(4);
    expect(isClosed(w)).toBe(true);
    expect(selectionBBox(w, ids)).toEqual([4, 5, 6, 7]);
  });
  it('rotates by 90 degrees about the bbox centre exactly, topology intact', () => {
    const base = addPolyline([], [[0, 0], [4, 0], [4, 2], [0, 2]], true, 'wood');
    const all = [0, 1, 2, 3];
    const w = rotateWalls(base, all, 90, bboxCenter(selectionBBox(base, all)!));
    expect(selectionBBox(w, all)!.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, -1, 3, 3]); // 4x2 -> 2x4 about (2,1)
    expect(vertexCount(w)).toBe(4);
    expect(isClosed(w)).toBe(true);
    const back = rotateWalls(w, all, -90, bboxCenter(selectionBBox(w, all)!));
    back.forEach((b, i) => {
      expect(b.a[0]).toBeCloseTo(base[i].a[0], 9);
      expect(b.b[1]).toBeCloseTo(base[i].b[1], 9);
    });
  });
  it('flips about the selection centre', () => {
    const base = [wall([0, 0], [2, 1]), wall([2, 1], [4, 0])];
    const h = flipWalls(base, [0, 1], 'h', [2, 0.5]);
    expect(h[0].a).toEqual([4, 0]);
    expect(h[0].b).toEqual([2, 1]);
    const v = flipWalls(base, [0, 1], 'v', [2, 0.5]);
    expect(v[0].a).toEqual([0, 1]);
    expect(vertexCount(v)).toBe(3);
  });
});

describe('clipboard', () => {
  const src = [wall([0, 0], [2, 0]), wall([2, 0], [2, 2])];
  const known = new Set(['plaster', 'wood']);
  it('places the copy centred on the cursor', () => {
    const w = placeWalls(src, [10, 10], 0.5, known, 'plaster');
    expect(bboxCenter(selectionBBox(w, [0, 1])!)).toEqual([10, 10]);
  });
  it('offsets by 0.5 m without a cursor', () => {
    const w = placeWalls(src, null, 0.5, known, 'plaster');
    expect(w[0].a).toEqual([0.5, 0.5]);
  });
  it('appends, selects the new walls and never aliases the source or the clipboard', () => {
    const target = room();
    const { walls, sel } = pasteInto(target, src, [1, 1], known, 'plaster');
    expect(walls.length).toBe(6);
    expect(sel).toEqual([4, 5]);
    walls[4].a[0] = 99;
    expect(src[0].a[0]).toBe(0);
    expect(target.length).toBe(4);
  });
  it('replaces unknown materials and successive pastes stack', () => {
    const odd = [{ a: [0, 0], b: [1, 0], mat: 'ghost' } as Wall];
    expect(placeWalls(odd, null, 0.5, known, 'wood')[0].mat).toBe('wood');
    const p1 = pasteClip([], null, known, 'wood', src);
    const p2 = pasteClip([], null, known, 'wood', src);
    expect(p2.walls[0].a[0] - p1.walls[0].a[0]).toBeCloseTo(0.5, 9);
  });
  it('round-trips through JSON and rejects foreign text', () => {
    expect(parseClip(serializeClip(src))).toEqual(src);
    expect(parseClip('hello')).toBeNull();
    expect(parseClip('{"format":"x","walls":[]}')).toBeNull();
  });
  it('duplicate offsets and selects the copies', () => {
    const d = duplicateWalls(room(), [0, 1]);
    expect(d.walls.length).toBe(6);
    expect(d.sel).toEqual([4, 5]);
    expect(d.walls[4].a).toEqual([0.5, 0.5]);
  });
});

describe('pillars inside a room', () => {
  const walls = addPolyline(room(), [[4, 3], [6, 3], [6, 5], [4, 5]], true, 'wood');
  const status = (p: [number, number], w: Wall[]) => locate(analyzePlan(w), p);
  it('finds the room and the pillar', () => {
    const faces = analyzePlan(walls).faces;
    expect(faces.map((f) => f.region).sort()).toEqual(['obstacle', 'room']);
    expect(isClosed(walls)).toBe(true);
  });
  it('classifies points as room / obstacle / outside', () => {
    expect(status([1, 1], walls)).toBe('room');
    expect(status([5, 4], walls)).toBe('obstacle');
    expect(status([12, 4], walls)).toBe('outside');
  });
  it('a free-standing arc or wall inside a closed room neither opens the room nor changes the classification', () => {
    const w = addPolyline(walls, [[1, 6], [2, 6.5], [3, 6.6]], false, 'wood');
    expect(isClosed(w)).toBe(true);
    expect(analyzePlan(w).faces).toHaveLength(2);
    expect(status([2, 6.4], w)).toBe('room');
    expect(status([5, 4], w)).toBe('obstacle');
    expect(status([12, 4], w)).toBe('outside');
  });
  it('a pillar-less plan is a room; walls touching it at a vertex change nothing', () => {
    expect(status([5, 4], room())).toBe('room');
    const touching = addPolyline(room(), [[0, 0], [2, 0], [2, 2]], false, 'wood'); // vertex shared by 3+ walls
    expect(status([5, 4], touching)).toBe('room');
    expect(isClosed(touching)).toBe(true);
  });
});
