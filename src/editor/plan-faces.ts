// Packed room-analysis faces: decoding and point-in-ring test. No UI dependencies, so the worker can use it too
// (editor/rooms.ts re-exports everything and adds the editor-side classification).

import { PLAN_FACE_HEADER } from '../layout';
import type { Pt } from '../scene';

export interface PlanFace {
  /** Outline, counter-clockwise. */
  ring: Pt[];
  /** Net area: outline minus the groups of walls standing inside. */
  area: number;
  region: 'room' | 'obstacle';
  depth: number;
}

export interface Plan {
  faces: PlanFace[];
}

export const EMPTY_PLAN: Plan = { faces: [] };

/** Unpack the faces of `Core.planFaces`: `[nFaces, per face region, depth, area, nPts, x0, y0, ...]`. */
export function decodePlan(buf: Float32Array): Plan {
  const faces: PlanFace[] = [];
  let i = 1;
  for (let f = 0; f < (buf[0] ?? 0); f++) {
    const n = buf[i + 3];
    const ring: Pt[] = [];
    for (let k = 0; k < n; k++) ring.push([buf[i + PLAN_FACE_HEADER + 2 * k], buf[i + PLAN_FACE_HEADER + 2 * k + 1]]);
    faces.push({ region: buf[i] === 0 ? 'room' : 'obstacle', depth: buf[i + 1], area: buf[i + 2], ring });
    i += PLAN_FACE_HEADER + 2 * n;
  }
  return { faces };
}

export function pointInRing(p: Pt, ring: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[j];
    if (y1 > p[1] !== y2 > p[1] && p[0] < ((x2 - x1) * (p[1] - y1)) / (y2 - y1) + x1) c = !c;
  }
  return c;
}
