// Room analysis results as the UI uses them. The analysis itself (planar graph, faces, rooms vs. obstacles,
// see the header of core/src/plan.rs for the rules) exists only in the Rust core; the worker runs it
// (`Core.planFaces`) and the main thread receives the faces as rings. This file only classifies points
// against those rings (synchronously, for the editor) and derives warnings and the heat-map mask.
// The results lag the walls by one worker round trip.

import { t } from '../i18n.svelte';
import type { Pt } from '../scene';
import { decodePlan, pointInRing, type Plan, type PlanFace } from './plan-faces';

export { decodePlan, EMPTY_PLAN, type Plan, type PlanFace } from './plan-faces';

export type Region = 'room' | 'obstacle' | 'outside';

function signedArea2(ring: Pt[]): number {
  let a2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    a2 += a[0] * b[1] - b[0] * a[1];
  }
  return a2;
}

export const hasRoom = (plan: Plan) => plan.faces.some((f) => f.region === 'room');

/** Innermost face containing `p`: room, obstacle (pillar) or outside. */
export function locate(plan: Plan, p: Pt): Region {
  let best: PlanFace | null = null;
  let bestArea = Infinity;
  for (const f of plan.faces) {
    if (!pointInRing(p, f.ring)) continue;
    const a = Math.abs(signedArea2(f.ring));
    if (a < bestArea) {
      best = f;
      bestArea = a;
    }
  }
  return best ? best.region : 'outside';
}

/**
 * Non-blocking warnings about the plan: not closed, or a source/the listener outside the rooms.
 * `regionOf` classifies a point (default: `locate`); the app passes a height-aware one, so a source standing on a stage is fine.
 */
export function planWarnings(plan: Plan, points: { name: string; p: Pt; z?: number }[], regionOf: (p: Pt, z?: number) => Region = (p) => locate(plan, p)): string[] {
  if (!hasRoom(plan)) return [t('warn.open')];
  const w: string[] = [];
  for (const { name, p, z } of points) {
    const r = regionOf(p, z);
    if (r === 'outside') w.push(t('warn.outside', { name }));
    else if (r === 'obstacle') w.push(t('warn.obstacle', { name }));
  }
  return w;
}

/**
 * Heat-map mask (1 = shown): cells inside a room. With transmission on, the inside of an obstacle
 * (a booth, a pillar with transmissive walls) is reached by rays too and is shown as well. An
 * unclosed plan shows every cell.
 */
export function heatMask(plan: Plan, g: { nx: number; ny: number; x0: number; y0: number; cell: number }, transmission: boolean): Uint8Array {
  const m = new Uint8Array(g.nx * g.ny).fill(1);
  if (!hasRoom(plan)) return m;
  for (let iy = 0; iy < g.ny; iy++)
    for (let ix = 0; ix < g.nx; ix++) {
      const r = locate(plan, [g.x0 + (ix + 0.5) * g.cell, g.y0 + (iy + 0.5) * g.cell]);
      m[iy * g.nx + ix] = r === 'room' || (transmission && r === 'obstacle') ? 1 : 0;
    }
  return m;
}
