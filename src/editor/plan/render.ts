import { forEachPath, forEachRay, PATH_HEADER } from '../../layout';
import { BG, BLUE, FG, GOLD, MUTED, TEAL, VIOLET } from '../../theme';
import { isDirectional } from '../../directivity';
import { heatPixels, type HeatLayer } from '../../heatmap';
import type { Pt, Scene } from '../../scene';
import { allVertices } from '../geometry';
import { drawGrid, drawListener, drawObstacleFills, drawObstacleLabels, drawRulers, drawScaleBar, drawSource, drawSourceDirectional, drawSourcePair, drawWalls } from '../render';
import type { Tool, ToolHost } from '../tools/types';
import { toPx, type View } from '../view';
import type { PlanProps, ToolId } from './types';

const ORDER_COLORS = [GOLD, TEAL, BLUE, VIOLET];

/** Heat layer as an image (one pixel per cell, scaled with smoothing when drawn). */
export function heatImage(heat: HeatLayer): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = heat.nx;
  c.height = heat.ny;
  const img = new ImageData(heatPixels(heat) as Uint8ClampedArray<ArrayBuffer>, heat.nx, heat.ny);
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

export interface PlanFrame {
  props: PlanProps;
  box: { w: number; h: number };
  view: View;
  host: ToolHost;
  tool: Tool;
  toolId: ToolId;
  matColor: Map<string, string>;
  selSet: Set<number>;
  heatCanvas: HTMLCanvasElement | null;
  showRuler: boolean;
  rulerPad: number;
  cursorW: Pt | null;
  /** A source, the listener or a pair is being dragged: draw a lighter set of paths. */
  interacting: boolean;
}

/** Paint the whole plan: grid, heat map, walls, rays, image-source paths, active tool, sources and listener, rulers. */
export function renderPlan(canvas: HTMLCanvasElement, f: PlanFrame) {
  const { props, box, view } = f;
  const scene: Scene = props.scene;
  const { heat, selection } = props;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(box.w * dpr));
  const H = Math.max(1, Math.round(box.h * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, box.w, box.h);

  if (props.grid) drawGrid(g, view, box.w, box.h, props.gridStep);

  // Heat map under everything else
  if (heat && f.heatCanvas) {
    const [ax, ay] = toPx(view, heat.x0, heat.y0 + heat.ny * heat.cell);
    g.save();
    g.globalAlpha = heat.opacity;
    g.imageSmoothingEnabled = true;
    g.drawImage(f.heatCanvas, ax, ay, heat.nx * heat.cell * view.s, heat.ny * heat.cell * view.s);
    g.restore();
  }

  drawObstacleFills(g, view, props.obstacles, f.matColor);
  drawWalls(g, view, scene, f.matColor, f.selSet);
  drawObstacleLabels(g, view, props.obstacles, scene.height);
  g.fillStyle = MUTED;
  for (const p of allVertices(scene.walls)) {
    const [x, y] = toPx(view, p[0], p[1]);
    g.beginPath();
    g.arc(x, y, 2.5, 0, Math.PI * 2);
    g.fill();
  }

  drawRays(g, view, props.rayPaths, props.showRays);
  drawImagePaths(g, view, props.paths, props.showOrders, f.interacting);

  // Active tool: handles, rubber band, previews, dimensions
  f.tool.draw(f.host, g);
  if (f.toolId !== 'select' && selection.length) {
    // keep the handles of a selection visible while drawing
    g.fillStyle = FG;
    g.strokeStyle = BG;
    g.lineWidth = 2;
    for (const k of selection)
      for (const q of scene.walls[k] ? [scene.walls[k].a, scene.walls[k].b] : []) {
        const [x, y] = toPx(view, q[0], q[1]);
        g.beginPath();
        g.arc(x, y, 4, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
  }

  scene.sources.forEach((src, i) => {
    if (props.pairActive[i]) drawSourcePair(g, view, src, i === props.selectedSource);
    else if (isDirectional(src)) drawSourceDirectional(g, view, src, i === props.selectedSource);
    else drawSource(g, view, src, i === props.selectedSource);
  });
  drawListener(g, view, scene.listener, scene.yaw);

  if (f.showRuler) drawRulers(g, view, box.w, box.h, f.cursorW);
  drawScaleBar(g, view, box.h, f.rulerPad, f.cursorW);
}

/** Sample of stochastic rays (first few bounces). */
function drawRays(g: CanvasRenderingContext2D, view: View, rayPaths: Float32Array | null, show: boolean) {
  if (!show || !rayPaths || !rayPaths.length) return;
  g.lineWidth = 1;
  g.strokeStyle = BLUE;
  g.globalAlpha = 0.28;
  // one path, one stroke: same style for every ray (overlaps don't add up, which reads fine at this alpha)
  g.beginPath();
  forEachRay(rayPaths, (i, n) => {
    for (let k = 0; k < n; k++) {
      const [x, y] = toPx(view, rayPaths[i + 1 + 2 * k], rayPaths[i + 2 + 2 * k]);
      if (k) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
  });
  g.stroke();
  g.globalAlpha = 1;
}

/**
 * Image-source paths, highest orders first so strong low-order paths stay on top.
 * Packed per path: [order, energy, nPts, crossedWalls, x0, y0, ...]. Paths that go through walls
 * (transmission) are dashed and keep a minimum visibility, their energy is usually far lower.
 */
/** Opacity levels the path energies are rounded to, so each (order, dash, level) group is one stroke. */
const ALPHA_LEVELS = 8;
/**
 * Most paths drawn per reflection order (strongest first), at rest and while dragging. With furniture there
 * are hundreds of 2nd/3rd-order paths; rasterising them was the main cost of every frame, and the faint
 * ones are barely visible anyway.
 */
const MAX_PATHS = 60;
const MAX_PATHS_DRAG = 25;
/** 2nd/3rd-order paths below this opacity level (≈ −34 dB under the strongest path) are not drawn. */
const MIN_LEVEL_HIGH_ORDER = 2;

function drawImagePaths(g: CanvasRenderingContext2D, view: View, paths: Float32Array | null, showOrders: boolean[], interacting: boolean) {
  if (!paths || !paths.length) return;
  let emax = 0;
  forEachPath(paths, (i) => (emax = Math.max(emax, paths[i + 1])));
  const level = (e: number, crossed: boolean) => {
    const db = 10 * Math.log10(Math.max(e, 1e-12) / emax);
    const a = Math.min(1, Math.max(crossed ? 0.3 : 0.06, 1 + db / 45));
    return Math.max(1, Math.round(a * ALPHA_LEVELS));
  };
  // Pick what to draw: per order the strongest paths, faint high-order ones dropped.
  const cap = interacting ? MAX_PATHS_DRAG : MAX_PATHS;
  const byOrder: { i: number; n: number; e: number; lv: number; cr: boolean }[][] = [[], [], [], []];
  forEachPath(paths, (i, n) => {
    const order = paths[i];
    if (!showOrders[order]) return;
    const cr = paths[i + 3] > 0;
    // through-wall paths keep a minimum opacity for visibility; rank them by their own energy
    const lv = level(paths[i + 1], false);
    if (order >= 2 && lv < MIN_LEVEL_HIGH_ORDER) return;
    byOrder[order]?.push({ i, n, e: paths[i + 1], lv: level(paths[i + 1], cr), cr });
  });
  g.lineWidth = 1.2;
  for (const crossed of [false, true]) {
    g.setLineDash(crossed ? [5, 4] : []);
    for (let want = 3; want >= 0; want--) {
      const list = byOrder[want];
      if (!list.length) continue;
      const shown = list.length > cap ? [...list].sort((a, b) => b.e - a.e).slice(0, cap) : list;
      g.strokeStyle = ORDER_COLORS[want];
      for (let lv = 1; lv <= ALPHA_LEVELS; lv++) {
        let any = false;
        g.beginPath();
        for (const p of shown) {
          if (p.cr !== crossed || p.lv !== lv) continue;
          any = true;
          for (let k = 0; k < p.n; k++) {
            const [x, y] = toPx(view, paths[p.i + PATH_HEADER + 2 * k], paths[p.i + PATH_HEADER + 1 + 2 * k]);
            if (k) g.lineTo(x, y);
            else g.moveTo(x, y);
          }
        }
        if (!any) continue;
        g.globalAlpha = lv / ALPHA_LEVELS;
        g.stroke();
      }
    }
  }
  g.setLineDash([]);
  g.globalAlpha = 1;
}
