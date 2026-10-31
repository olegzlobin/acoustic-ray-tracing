import type { Pt } from '../scene';

/** Plan view transform: `s` pixels per metre; world (x, y up) -> canvas (ox + x s, oy - y s). */
export interface View {
  s: number;
  ox: number;
  oy: number;
}

export const MIN_ZOOM = 1.5;
export const MAX_ZOOM = 600;

export const toPx = (v: View, x: number, y: number): Pt => [v.ox + x * v.s, v.oy - y * v.s];
export const toWorld = (v: View, px: number, py: number): Pt => [(px - v.ox) / v.s, (v.oy - py) / v.s];
