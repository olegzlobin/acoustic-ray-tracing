// Height of the obstacles on the plan: the same rule as the core's `build_caps` (core/src/ism.rs), so the editor
// shows what the core treats as a table top / sofa / stage. Computed from the plan faces when walls change.

import type { Pt, Wall } from '../scene';
import { isPartialWall, wallRange } from '../scene';
import { locate, type Plan, type PlanFace, type Region } from './rooms';

export interface Obstacle {
  face: PlanFace;
  /** Bottom (highest `z0` of the covering walls) and top (lowest `z1`), metres above the floor. */
  z0: number;
  z1: number;
  /** Material of the first covering wall. */
  mat: string;
  centroid: Pt;
  bbox: [number, number, number, number];
}

const TOL = 2e-3;

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function centroidOf(ring: Pt[]): Pt {
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const c = x1 * y2 - x2 * y1;
    a2 += c;
    cx += (x1 + x2) * c;
    cy += (y1 + y2) * c;
  }
  if (Math.abs(a2) < 1e-9) return ring[0] ?? [0, 0];
  return [cx / (3 * a2), cy / (3 * a2)];
}

/**
 * Obstacle faces that stand on partial-height walls (a top and / or a bottom cap in the core), with their
 * vertical extent. Full-height pillars are not listed.
 */
export function obstacleInfo(plan: Plan, walls: Wall[], h: number): Obstacle[] {
  const out: Obstacle[] = [];
  if (!walls.some((w) => isPartialWall(w, h))) return out;
  for (const f of plan.faces) {
    if (f.region !== 'obstacle') continue;
    let top = Infinity, bottom = -Infinity, mat: string | null = null;
    for (let i = 0; i < f.ring.length; i++) {
      const a = f.ring[i], b = f.ring[(i + 1) % f.ring.length];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) continue;
      for (const w of walls) {
        if (distToSegment(a, w.a, w.b) <= TOL && distToSegment(b, w.a, w.b) <= TOL) {
          const [z0, z1] = wallRange(w, h);
          top = Math.min(top, z1);
          bottom = Math.max(bottom, z0);
          mat ??= w.mat;
        }
      }
    }
    if (mat === null || (top >= h - 1e-6 && bottom <= 1e-6)) continue;
    const xs = f.ring.map((p) => p[0]), ys = f.ring.map((p) => p[1]);
    out.push({ face: f, z0: bottom, z1: top, mat, centroid: centroidOf(f.ring), bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }
  return out;
}

/**
 * Like `locate`, but for a point at height `z`: above the top of a low obstacle (a source on a stage, a
 * listener over a table) or below its raised bottom the obstacle is not in the way, so the point is in the room.
 */
export function locateAt(plan: Plan, obstacles: Obstacle[], p: Pt, z: number): Region {
  let cur = plan;
  for (let guard = 0; guard < 8; guard++) {
    const r = locate(cur, p);
    if (r !== 'obstacle') return r;
    // innermost obstacle face under the point
    let best: Obstacle | null = null;
    for (const o of obstacles) {
      if (!cur.faces.includes(o.face)) continue;
      if (p[0] < o.bbox[0] || p[0] > o.bbox[2] || p[1] < o.bbox[1] || p[1] > o.bbox[3]) continue;
      if (locate({ faces: [o.face] }, p) !== 'obstacle') continue;
      if (!best || o.face.area < best.face.area) best = o;
    }
    if (!best || (z <= best.z1 && z >= best.z0)) return 'obstacle';
    cur = { faces: cur.faces.filter((f) => f !== best!.face) };
  }
  return 'obstacle';
}
