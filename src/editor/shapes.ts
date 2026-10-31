// Shape generators for the shape tools. All return vertex lists in plan metres; closed shapes
// are fed to addPolyline(..., true) so consecutive walls share endpoints.
import type { Pt } from '../scene';
import { MIN_WALL_LEN } from './geometry';

const SEG_LEN = 0.5; // auto segment length along circles and arcs, m
export const MIN_SIDES = 3;
export const MAX_SIDES = 64;
const MIN_CIRCLE_SEGS = 12;
export const MAX_CIRCLE_SEGS = 64;

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

/** Rectangle corners a, (b.x, a.y), b, (a.x, b.y). `square` makes the sides equal (longer drag side wins). */
export function rectPoints(a: Pt, b: Pt, square = false): Pt[] {
  let [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  if (square) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  const c: Pt = [a[0] + dx, a[1] + dy];
  return [[a[0], a[1]], [c[0], a[1]], c, [a[0], c[1]]];
}

/** Regular n-gon with the first vertex at `edge`; with `snapDeg` the first vertex direction snaps to that angle step. */
export function regularPolygon(center: Pt, edge: Pt, n: number, snapDeg = 0): Pt[] {
  n = clampInt(n, MIN_SIDES, MAX_SIDES);
  const r = Math.hypot(edge[0] - center[0], edge[1] - center[1]);
  let a0 = Math.atan2(edge[1] - center[1], edge[0] - center[0]);
  if (snapDeg > 0) {
    const st = (snapDeg * Math.PI) / 180;
    a0 = Math.round(a0 / st) * st;
  }
  return Array.from({ length: n }, (_, k): Pt => [center[0] + r * Math.cos(a0 + (2 * Math.PI * k) / n), center[1] + r * Math.sin(a0 + (2 * Math.PI * k) / n)]);
}

/** Ramanujan's approximation of the ellipse circumference. */
const ellipseCircumference = (rx: number, ry: number) => Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));

/** Segment count for a circle/ellipse: `requested` (> 0) or one segment per SEG_LEN of circumference, 12..64. */
export function circleSegments(rx: number, ry: number, requested = 0): number {
  if (requested > 0) return clampInt(requested, MIN_CIRCLE_SEGS, MAX_CIRCLE_SEGS);
  return clampInt(ellipseCircumference(rx, ry) / SEG_LEN, MIN_CIRCLE_SEGS, MAX_CIRCLE_SEGS);
}

/** Ellipse (circle if rx = ry) approximated by `n` segments, first vertex at angle 0. */
export function ellipsePoints(center: Pt, rx: number, ry: number, n: number): Pt[] {
  n = clampInt(n, MIN_CIRCLE_SEGS, MAX_CIRCLE_SEGS);
  return Array.from({ length: n }, (_, k): Pt => [center[0] + rx * Math.cos((2 * Math.PI * k) / n), center[1] + ry * Math.sin((2 * Math.PI * k) / n)]);
}

/** Circle through three points, or null when they are (nearly) collinear. */
export function circumcircle(p0: Pt, p1: Pt, p2: Pt): { c: Pt; r: number } | null {
  const d = 2 * (p0[0] * (p1[1] - p2[1]) + p1[0] * (p2[1] - p0[1]) + p2[0] * (p0[1] - p1[1]));
  if (Math.abs(d) < 1e-9) return null;
  const s0 = p0[0] ** 2 + p0[1] ** 2;
  const s1 = p1[0] ** 2 + p1[1] ** 2;
  const s2 = p2[0] ** 2 + p2[1] ** 2;
  const c: Pt = [(s0 * (p1[1] - p2[1]) + s1 * (p2[1] - p0[1]) + s2 * (p0[1] - p1[1])) / d, (s0 * (p2[0] - p1[0]) + s1 * (p0[0] - p2[0]) + s2 * (p1[0] - p0[0])) / d];
  return { c, r: Math.hypot(p0[0] - c[0], p0[1] - c[1]) };
}

/** Number of segments for an arc: one per SEG_LEN of arc length (at least 3, at most 64) unless `requested` > 0. */
function arcSegments(arcLen: number, requested = 0): number {
  return requested > 0 ? clampInt(requested, 2, MAX_CIRCLE_SEGS) : clampInt(arcLen / SEG_LEN, 3, MAX_CIRCLE_SEGS);
}

/** Arc from p0 to p1 passing through pm: n + 1 points (endpoints exact). Collinear points give a straight line. */
export function arcPoints(p0: Pt, p1: Pt, pm: Pt, n = 0): Pt[] {
  const cc = circumcircle(p0, p1, pm);
  if (!cc) return [p0, p1];
  const ang = (p: Pt) => Math.atan2(p[1] - cc.c[1], p[0] - cc.c[0]);
  const a0 = ang(p0);
  const ccw = (a: number) => (((a - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); // CCW sweep from p0
  const sweepEnd = ccw(ang(p1));
  const sweepMid = ccw(ang(pm));
  const sweep = sweepMid <= sweepEnd ? sweepEnd : sweepEnd - 2 * Math.PI; // pm on the CCW arc, else go clockwise
  const segs = arcSegments(Math.abs(sweep) * cc.r, n);
  const pts: Pt[] = [];
  for (let k = 0; k <= segs; k++) {
    const a = a0 + (sweep * k) / segs;
    pts.push([cc.c[0] + cc.r * Math.cos(a), cc.c[1] + cc.r * Math.sin(a)]);
  }
  pts[0] = [p0[0], p0[1]];
  pts[segs] = [p1[0], p1[1]];
  return pts;
}

/** True if every edge is at least MIN_WALL_LEN long (otherwise addPolyline would drop it and leave a gap). */
export function edgesOk(pts: Pt[], closed: boolean): boolean {
  const n = pts.length;
  if (n < 2 || (closed && n < 3)) return false;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < MIN_WALL_LEN) return false;
  }
  return true;
}

// Ready-made obstacles, centred on the cursor.
export interface Stamp {
  id: string;
  name: string;
  make: (c: Pt) => Pt[];
  /** Material id the stamp brings (if the scene has it), else the drawing material. */
  mat?: string;
  /** Vertical extent in metres (unset: floor / ceiling). */
  z0?: number;
  z1?: number;
}
const box = (c: Pt, w: number, d: number) => rectPoints([c[0] - w / 2, c[1] - d / 2], [c[0] + w / 2, c[1] + d / 2]);
export const STAMPS: Stamp[] = [
  { id: 'column', name: 'Column 0.5 m', make: (c) => rectPoints([c[0] - 0.25, c[1] - 0.25], [c[0] + 0.25, c[1] + 0.25]) },
  { id: 'pillar', name: 'Round pillar Ø0.6 m', make: (c) => ellipsePoints(c, 0.3, 0.3, 12) },
  { id: 'stage', name: 'Stage 4 × 2.5 m, 0.8 m high', make: (c) => box(c, 4, 2.5), z1: 0.8 },
  // Low furniture: sound passes under a table top, a sofa and a bed are solid boxes.
  { id: 'table', name: 'Table 1.2 × 0.8 m', make: (c) => box(c, 1.2, 0.8), mat: 'wood', z0: 0.72, z1: 0.75 },
  { id: 'sofa', name: 'Sofa 2 × 0.9 m', make: (c) => box(c, 2, 0.9), mat: 'upholstery', z1: 0.85 },
  { id: 'bed', name: 'Bed 2 × 1.6 m', make: (c) => box(c, 2, 1.6), mat: 'upholstery', z1: 0.55 },
];
