import type { Snippet } from 'svelte';
import type { HeatLayer, HeatMetric } from '../../heatmap';
import type { Pt, Scene, Wall } from '../../scene';
import type { Obstacle } from '../obstacles';
import type { ShapeKind } from '../tools/shapes';

export type ToolId = 'select' | 'draw' | 'measure' | ShapeKind;

/** Props of PlanCanvas, shared with the render/gesture/keyboard modules (they read them lazily, so they stay reactive). */
export interface PlanProps {
  scene: Scene;
  /** Low obstacles with heights (labels and tint on the plan). */
  obstacles: Obstacle[];
  tool: ToolId;
  /** Selected wall indices (sorted). */
  selection: number[];
  selectedSource: number;
  /** Per source: shown as a stereo pair (two speakers L / R joined by a line). */
  pairActive: boolean[];
  heat: HeatLayer | null;
  heatMetric: HeatMetric;
  grid: boolean;
  gridStep: number;
  /** Material id used by the draw and shape tools. */
  drawMat: string;
  paths: Float32Array | null;
  rayPaths: Float32Array | null;
  showRays: boolean;
  showOrders: boolean[];
  fitToken: number;
  canUndo: boolean;
  canRedo: boolean;
  onsource: (i: number, p: Pt) => void;
  onselectsource: (i: number) => void;
  /** Delete with no walls selected removes the selected source (never the last one). */
  onremovesource: (i: number) => void;
  /** Wheel over a stereo pair or directional source, or dragging its handle, turns it (new facing angle, radians). */
  onrotatesource: (i: number, angle: number) => void;
  onlistener: (p: Pt) => void;
  onyaw: (yaw: number) => void;
  onrelease?: () => void;
  ontool: (t: ToolId) => void;
  ongrid: (on: boolean) => void;
  onselection: (ids: number[]) => void;
  ondrawmat: (id: string) => void;
  onbeginedit: () => void;
  onliveedit: (walls: Wall[]) => void;
  onendedit: () => void;
  /** Replace all walls as one undo step and set the selection. */
  oncommit: (walls: Wall[], sel: number[]) => void;
  onundo: () => void;
  onredo: () => void;
  /** Main action (Play) rendered first in the toolbar row. */
  lead?: Snippet;
}

export const SHAPES: { id: ShapeKind; name: string; key: string }[] = [
  { id: 'rect', name: 'Rectangle', key: 'B' },
  { id: 'polygon', name: 'Polygon', key: 'P' },
  { id: 'circle', name: 'Circle', key: 'C' },
  { id: 'ellipse', name: 'Ellipse', key: 'E' },
  { id: 'arc', name: 'Arc', key: 'A' },
  { id: 'stamp', name: 'Stamp', key: 'T' },
];
export const isShape = (t: ToolId): t is ShapeKind => SHAPES.some((s) => s.id === t);
/** Tools that add walls (they use the drawing material). */
export const drawing = (t: ToolId) => t === 'draw' || isShape(t);
