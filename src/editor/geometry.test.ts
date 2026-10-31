import { describe, expect, it } from 'vitest';
import type { Pt, Wall } from '../scene';
import { addPolyline, hitWall, moveVertex, moveWall, nearestVertex, removeWall, snapAngle, snapGrid, snapPoint, snapToPoints } from './geometry';
import { History } from './history';

const box = (): Wall[] => addPolyline([], [[0, 0], [4, 0], [4, 3], [0, 3]], true, 'plaster');

describe('snapping', () => {
  it('snaps to the grid', () => {
    expect(snapGrid([1.13, 2.4], 0.25)).toEqual([1.25, 2.5]);
  });
  it('snaps angles to 15 degrees and keeps length', () => {
    const p = snapAngle([0, 0], [10, 1], 15);
    expect(Math.atan2(p[1], p[0])).toBeCloseTo(0, 6);
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(Math.hypot(10, 1), 6);
    const q = snapAngle([1, 1], [1 + 5, 1 + 4.6], 15); // ~42.6 deg -> 45
    expect(Math.atan2(q[1] - 1, q[0] - 1)).toBeCloseTo(Math.PI / 4, 6);
  });
  it('prefers endpoints, then angle, then grid', () => {
    const pts: Pt[] = [[1, 1]];
    expect(snapToPoints([1.05, 1.02], pts, 0.1)).toEqual([1, 1]);
    expect(snapToPoints([2, 2], pts, 0.1)).toBeNull();
    const o = { grid: true, step: 0.25, points: pts, tol: 0.1 };
    expect(snapPoint([1.04, 1.03], o)).toEqual({ p: [1, 1], onPoint: true });
    expect(snapPoint([3.1, 2.9], o)).toEqual({ p: [3, 3], onPoint: false });
    const a = snapPoint([5, 0.4], { ...o, from: [0, 0], angle: true });
    expect(a.p[1]).toBeCloseTo(0, 6);
  });
});

describe('walls', () => {
  it('builds closed polylines and skips degenerate segments', () => {
    expect(box()).toHaveLength(4);
    const w = addPolyline([], [[0, 0], [0.01, 0], [2, 0]], false, 'x');
    expect(w).toHaveLength(1);
  });
  it('moves joined vertices together and rejects degenerate results', () => {
    const w = moveVertex(box(), [4, 0], [5, -1])!;
    expect(w[0].b).toEqual([5, -1]);
    expect(w[1].a).toEqual([5, -1]);
    expect(moveVertex(box(), [4, 0], [4, 3])).toBeNull(); // collapses the east wall
  });
  it('moves a wall with its neighbours attached', () => {
    const w = moveWall(box(), 0, 0, 1)!; // south wall up by 1
    expect(w[0].a).toEqual([0, 1]);
    expect(w[0].b).toEqual([4, 1]);
    expect(w[1].a).toEqual([4, 1]); // east wall start follows
    expect(w[3].b).toEqual([0, 1]);
    expect(w[2].a).toEqual([4, 3]); // north untouched
  });
  it('hit-tests walls and vertices and removes walls', () => {
    const w = box();
    expect(hitWall(w, [2, 0.1], 0.2)).toBe(0);
    expect(hitWall(w, [2, 1.5], 0.2)).toBe(-1);
    expect(nearestVertex(w, [3.95, 0.05], 0.2)).toEqual([4, 0]);
    expect(removeWall(w, 1)).toHaveLength(3);
  });
});

describe('History', () => {
  it('undoes and redoes snapshots; a new edit clears redo', () => {
    const h = new History<number>();
    let state = 1;
    const edit = (n: number) => {
      h.push(state);
      state = n;
    };
    edit(2);
    edit(3);
    expect(h.canUndo).toBe(true);
    state = h.undo(state)!;
    expect(state).toBe(2);
    state = h.undo(state)!;
    expect(state).toBe(1);
    expect(h.undo(state)).toBeNull();
    state = h.redo(state)!;
    expect(state).toBe(2);
    edit(9);
    expect(h.canRedo).toBe(false);
    expect(h.redo(state)).toBeNull();
  });
  it('respects the size limit', () => {
    const h = new History<number>(3);
    for (let i = 0; i < 10; i++) h.push(i);
    let cur = 10;
    let n = 0;
    for (let r = h.undo(cur); r !== null; r = h.undo(cur)) {
      cur = r;
      n++;
    }
    expect(n).toBe(3);
  });
});
