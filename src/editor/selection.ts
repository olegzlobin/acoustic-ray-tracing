// Selection helpers: rubber-band hit tests and the selection set (sorted wall indices).
import type { Pt, Wall } from '../scene';

type Rect = [number, number, number, number]; // x0, y0, x1, y1 (normalised: x0 <= x1, y0 <= y1)

export const normRect = (a: Pt, b: Pt): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];

const inRect = (p: Pt, r: Rect) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];

/** Window mode: the wall lies completely inside the rectangle. */
const wallInside = (w: Wall, r: Rect) => inRect(w.a, r) && inRect(w.b, r);

/** Crossing mode: any part of the wall touches the rectangle (Liang-Barsky clipping). */
export function wallTouches(w: Wall, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = w.b[0] - w.a[0];
  const dy = w.b[1] - w.a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [w.a[0] - r[0], r[2] - w.a[0], w.a[1] - r[1], r[3] - w.a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

export function selectInRect(walls: Wall[], r: Rect, crossing: boolean): number[] {
  const out: number[] = [];
  walls.forEach((w, i) => {
    if (crossing ? wallTouches(w, r) : wallInside(w, r)) out.push(i);
  });
  return out;
}

export const toggleIn = (sel: number[], i: number): number[] => (sel.includes(i) ? sel.filter((k) => k !== i) : [...sel, i].sort((a, b) => a - b));
export const unionSel = (a: number[], b: number[]): number[] => [...new Set([...a, ...b])].sort((x, y) => x - y);
export const allIndices = (walls: Wall[]): number[] => walls.map((_, i) => i);

/** Drop indices that no longer exist (after the walls changed under the selection). */
