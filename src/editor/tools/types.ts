import type { Pt, Scene, Wall } from '../../scene';
import type { View } from '../view';

export interface Mods {
  /** Shift or the toolbar Shift-lock (touch). */
  shift: boolean;
  alt: boolean;
  /** Ctrl or Cmd. */
  ctrl: boolean;
}

export interface PointerInfo {
  /** World position (metres). */
  w: Pt;
  /** Canvas position (px). */
  px: Pt;
  mods: Mods;
  touch: boolean;
}

export interface ShapeParams {
  /** Regular polygon sides. */
  sides: number;
  /** Circle / ellipse segments, 0 = automatic. */
  circleSegs: number;
  /** Arc segments, 0 = automatic. */
  arcSegs: number;
  stamp: string;
}

/** What the tools may read and do; implemented by PlanCanvas. */
export interface ToolHost {
  readonly scene: Scene;
  readonly view: View;
  readonly grid: boolean;
  readonly gridStep: number;
  readonly drawMat: string;
  readonly selection: number[];
  readonly params: ShapeParams;
  /** Snap a world point: endpoints first, then (with `from` and Shift) 15 degree angles, then the grid. */
  snap(w: Pt, mods: Mods, from: Pt | null, opts?: { exclude?: Pt[]; extra?: Pt[]; noAngle?: boolean }): { p: Pt; onPoint: boolean };
  setSelection(ids: number[]): void;
  /** Replace the walls as ONE undo step and select `sel`. */
  commit(walls: Wall[], sel: number[]): void;
  /** Append a polyline / closed shape in the current drawing material (one undo step). */
  addShape(pts: Pt[], closed: boolean, select: boolean, opts?: { mat?: string; z0?: number; z1?: number }): void;
  beginEdit(): void;
  liveEdit(walls: Wall[]): void;
  endEdit(): void;
  /** Request a redraw after changing tool-internal state. */
  invalidate(): void;
}

export interface Tool {
  cursor: string;
  /** A gesture is in progress (Esc cancels it instead of clearing the selection). */
  active(): boolean;
  /** Pointer pressed; return true when the tool took the gesture (drags then get move/up). */
  down(h: ToolHost, p: PointerInfo): boolean;
  /** Pointer moved (hovering or dragging). */
  move(h: ToolHost, p: PointerInfo): void;
  up(h: ToolHost, p: PointerInfo): void;
  /** Abort the current gesture (Esc, tool switch, second finger). */
  cancel(h: ToolHost): void;
  /** Finish: Enter / double click. */
  finish?(h: ToolHost): void;
  /** Pointer left the canvas without a gesture running. */
  leave?(): void;
  draw(h: ToolHost, g: CanvasRenderingContext2D): void;
}
