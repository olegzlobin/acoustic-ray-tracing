// Pure geometry helpers for the plan editor (world coordinates, metres, y up).
import { cloneWall, type Pt, type Wall } from '../scene';

export const MIN_WALL_LEN = 0.05;
const EPS = 1e-6;

export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const wallLength = (w: Wall) => dist(w.a, w.b);
const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

export const snapGrid = (p: Pt, step: number): Pt => [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step];

/** Snap the direction from `from` to `p` to multiples of `stepDeg`, keeping the length. */
export function snapAngle(from: Pt, p: Pt, stepDeg = 15): Pt {
  const dx = p[0] - from[0];
  const dy = p[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return p;
  const st = (stepDeg * Math.PI) / 180;
  const a = Math.round(Math.atan2(dy, dx) / st) * st;
  return [from[0] + len * Math.cos(a), from[1] + len * Math.sin(a)];
}

/** Nearest of `pts` within `tol` (world units), else null. */
export function snapToPoints(p: Pt, pts: Pt[], tol: number): Pt | null {
  let best: Pt | null = null;
  let bd = tol;
  for (const q of pts) {
    const d = dist(p, q);
    if (d <= bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

interface SnapOptions {
  grid: boolean;
  step: number;
  points: Pt[];
  tol: number;
  /** Previous polyline point: enables angle snapping when `angle` is set. */
  from?: Pt | null;
  angle?: boolean;
}

/** Endpoint snap wins over angle/grid snap; angle snap is applied before the grid. */
export function snapPoint(p: Pt, o: SnapOptions): { p: Pt; onPoint: boolean } {
  const hit = snapToPoints(p, o.points, o.tol);
  if (hit) return { p: [hit[0], hit[1]], onPoint: true };
  let q = p;
  if (o.angle && o.from) q = snapAngle(o.from, q);
  else if (o.grid) q = snapGrid(q, o.step);
  return { p: q, onPoint: false };
}

function distPointSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 < EPS ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Index of the wall nearest to `p` within `tol`, or -1. */
export function hitWall(walls: Wall[], p: Pt, tol: number): number {
  let best = -1;
  let bd = tol;
  walls.forEach((w, i) => {
    const d = distPointSeg(p, w.a, w.b);
    if (d <= bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

export function allVertices(walls: Wall[]): Pt[] {
  const out: Pt[] = [];
  for (const w of walls) for (const p of [w.a, w.b]) if (!out.some((q) => same(p, q))) out.push([p[0], p[1]]);
  return out;
}

/** Nearest wall endpoint within `tol`, or null. */
export const nearestVertex = (walls: Wall[], p: Pt, tol: number): Pt | null => snapToPoints(p, allVertices(walls), tol);

const cloneWalls = (walls: Wall[]): Wall[] => walls.map(cloneWall);

/** Move every wall endpoint coincident with `from` to `to` (walls joined there move together).
 * Returns null if that would make any wall shorter than MIN_WALL_LEN. */
export function moveVertex(walls: Wall[], from: Pt, to: Pt): Wall[] | null {
  const out = cloneWalls(walls);
  for (const w of out) {
    if (same(w.a, from)) w.a = [to[0], to[1]];
    if (same(w.b, from)) w.b = [to[0], to[1]];
  }
  return out.some((w) => wallLength(w) < MIN_WALL_LEN) ? null : out;
}

/** Translate wall `i` by (dx, dy), dragging the joined endpoints of neighbouring walls with it. */
export function moveWall(walls: Wall[], i: number, dx: number, dy: number): Wall[] | null {
  const out = cloneWalls(walls);
  const ends = [walls[i].a, walls[i].b];
  for (const w of out) {
    for (const key of ['a', 'b'] as const) {
      if (ends.some((e) => same(e, w[key]))) w[key] = [w[key][0] + dx, w[key][1] + dy];
    }
  }
  return out.some((w) => wallLength(w) < MIN_WALL_LEN) ? null : out;
}

/** Append a polyline as walls (skipping segments shorter than MIN_WALL_LEN); `closed` adds the closing wall. */
export function addPolyline(walls: Wall[], pts: Pt[], closed: boolean, mat: string): Wall[] {
  const out = cloneWalls(walls);
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (dist(a, b) >= MIN_WALL_LEN) out.push({ a: [a[0], a[1]], b: [b[0], b[1]], mat });
  }
  return out;
}

export const removeWall = (walls: Wall[], i: number): Wall[] => cloneWalls(walls).filter((_, k) => k !== i);

export function bbox(walls: Wall[]): [number, number, number, number] | null {
  if (!walls.length) return null;
  let b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const w of walls) for (const p of [w.a, w.b]) b = [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])];
  return b;
}
