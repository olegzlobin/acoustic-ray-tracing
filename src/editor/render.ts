// Canvas drawing helpers for the plan: grid, walls, rulers, scale bar, icons, labels.
import { BG, FG, LINE, MONO_FONT, MUTED, OVERLAY, PANEL, RAISE, TEAL_LIGHT } from '../theme';
import { t } from '../i18n.svelte';
import { isPartialWall, type Pt, type Scene, type Source } from '../scene';
import type { Obstacle } from './obstacles';
import { pairPositions } from '../stereo';
import { fmtMeters, gridLevels, headScale, HEAD_PX, niceScaleLength, rulerTicks, speakerScale, wallWidthPx } from './scale';
import { toPx, toWorld, type View } from './view';

export const RULER = 18; // ruler thickness, px
const FONT = `11px ${MONO_FONT}`;

export function drawGrid(g: CanvasRenderingContext2D, v: View, w: number, h: number, gridStep: number) {
  const { minor, major } = gridLevels(gridStep, v.s);
  const [wx0, wy1] = toWorld(v, 0, 0);
  const [wx1, wy0] = toWorld(v, w, h);
  // Major lines
  g.strokeStyle = LINE;
  g.lineWidth = 1;
  g.beginPath();
  for (let x = Math.ceil(wx0 / major) * major; x <= wx1; x += major) {
    const px = Math.round(toPx(v, x, 0)[0]) + 0.5;
    g.moveTo(px, 0);
    g.lineTo(px, h);
  }
  for (let y = Math.ceil(wy0 / major) * major; y <= wy1; y += major) {
    const py = Math.round(toPx(v, 0, y)[1]) + 0.5;
    g.moveTo(0, py);
    g.lineTo(w, py);
  }
  g.stroke();
  // Minor dots (the snap positions)
  if (((wx1 - wx0) / minor) * ((wy1 - wy0) / minor) < 40000) {
    g.fillStyle = RAISE;
    for (let x = Math.ceil(wx0 / minor) * minor; x <= wx1; x += minor)
      for (let y = Math.ceil(wy0 / minor) * minor; y <= wy1; y += minor) {
        const [px, py] = toPx(v, x, y);
        g.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
      }
  }
}

export function drawWalls(g: CanvasRenderingContext2D, v: View, scene: Scene, color: Map<string, string>, selection: Set<number>) {
  g.lineCap = 'round';
  const lw = wallWidthPx(v.s);
  scene.walls.forEach((wl, i) => {
    // low furniture parts are thinner and fainter than the full-height walls
    const partial = isPartialWall(wl, scene.height);
    const [ax, ay] = toPx(v, wl.a[0], wl.a[1]);
    const [bx, by] = toPx(v, wl.b[0], wl.b[1]);
    if (selection.has(i)) {
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.strokeStyle = FG;
      g.lineWidth = lw + 4;
      g.globalAlpha = 0.35;
      g.stroke();
      g.globalAlpha = 1;
    }
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.strokeStyle = color.get(wl.mat) ?? MUTED;
    g.lineWidth = partial ? Math.max(1.5, lw * 0.6) : lw;
    if (partial) g.globalAlpha = PARTIAL_ALPHA;
    g.stroke();
    if (partial) g.globalAlpha = 1;
  });
}

const PARTIAL_ALPHA = 0.55;
/** An obstacle label needs a footprint at least this big (px, longer side); smaller ones stay unlabelled. */
const LABEL_MIN_PX = 40;

/** Faint tint of the footprint of low obstacles in their material colour (under the walls). */
export function drawObstacleFills(g: CanvasRenderingContext2D, v: View, obstacles: Obstacle[], color: Map<string, string>) {
  if (!obstacles.length) return;
  g.save();
  g.globalAlpha = 0.16;
  for (const o of obstacles) {
    g.fillStyle = color.get(o.mat) ?? MUTED;
    g.beginPath();
    o.face.ring.forEach((p, i) => {
      const [x, y] = toPx(v, p[0], p[1]);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.closePath();
    g.fill();
  }
  g.restore();
}

const fmtZ = (z: number) => z.toFixed(2);

/** Height of low obstacles at their centroid: "0.85 m" for a box from the floor, "0.72–0.75 m" for a slab. */
export function drawObstacleLabels(g: CanvasRenderingContext2D, v: View, obstacles: Obstacle[], roomH: number) {
  if (!obstacles.length) return;
  g.font = FONT;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 3;
  g.strokeStyle = BG;
  g.fillStyle = MUTED;
  for (const o of obstacles) {
    if (Math.max(o.bbox[2] - o.bbox[0], o.bbox[3] - o.bbox[1]) * v.s < LABEL_MIN_PX) continue;
    const top = o.z1 >= roomH - 1e-6 ? roomH : o.z1;
    const text = `${o.z0 > 1e-6 ? `${fmtZ(o.z0)}–` : ''}${fmtZ(top)} ${t('u.m')}`;
    const [x, y] = toPx(v, o.centroid[0], o.centroid[1]);
    g.strokeText(text, x, y);
    g.fillText(text, x, y);
  }
}

/** Text with a dark backing so it stays readable over walls and the heat map. */
export function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, align: CanvasTextAlign = 'left') {
  g.font = FONT;
  g.textAlign = align;
  g.textBaseline = 'middle';
  const tw = g.measureText(text).width;
  const x0 = align === 'center' ? x - tw / 2 : align === 'right' ? x - tw : x;
  g.fillStyle = OVERLAY;
  g.fillRect(x0 - 3, y - 8, tw + 6, 16);
  g.fillStyle = FG;
  g.fillText(text, x, y);
}

/** Rulers along the top and left edges plus a cursor marker on each. */
export function drawRulers(g: CanvasRenderingContext2D, v: View, w: number, h: number, cursor: Pt | null) {
  g.fillStyle = PANEL;
  g.fillRect(0, 0, w, RULER);
  g.fillRect(0, 0, RULER, h);
  g.strokeStyle = LINE;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(RULER + 0.5, 0);
  g.lineTo(RULER + 0.5, h);
  g.moveTo(0, RULER + 0.5);
  g.lineTo(w, RULER + 0.5);
  g.stroke();
  g.font = FONT;
  g.fillStyle = MUTED;
  g.strokeStyle = MUTED;
  g.textBaseline = 'alphabetic';
  const [wx0, wy1] = toWorld(v, RULER, RULER);
  const [wx1, wy0] = toWorld(v, w, h);
  g.beginPath();
  g.textAlign = 'left';
  for (const t of rulerTicks(wx0, wx1, v.s)) {
    const px = Math.round(toPx(v, t.v, 0)[0]) + 0.5;
    g.moveTo(px, RULER);
    g.lineTo(px, t.major ? 4 : RULER - 4);
    if (t.major) g.fillText(t.label, px + 3, 11);
  }
  for (const t of rulerTicks(wy0, wy1, v.s)) {
    const py = Math.round(toPx(v, 0, t.v)[1]) + 0.5;
    g.moveTo(RULER, py);
    g.lineTo(t.major ? 4 : RULER - 4, py);
    if (t.major) {
      g.save();
      g.translate(11, py - 3);
      g.rotate(-Math.PI / 2);
      g.fillText(t.label, 0, 0);
      g.restore();
    }
  }
  g.stroke();
  g.fillStyle = BG;
  g.fillRect(0, 0, RULER, RULER);
  g.fillStyle = MUTED;
  g.textAlign = 'center';
  g.fillText(t('u.m'), RULER / 2, 12);
  if (cursor) {
    const [cx, cy] = toPx(v, cursor[0], cursor[1]);
    g.strokeStyle = TEAL_LIGHT;
    g.beginPath();
    g.moveTo(cx + 0.5, 0);
    g.lineTo(cx + 0.5, RULER);
    g.moveTo(0, cy + 0.5);
    g.lineTo(RULER, cy + 0.5);
    g.stroke();
  }
}

/** Scale bar (bottom-left) with an automatically chosen nice length, and the cursor coordinates below it. */
export function drawScaleBar(g: CanvasRenderingContext2D, v: View, h: number, left: number, cursor: Pt | null) {
  const { len, px } = niceScaleLength(v.s);
  const x = left + 12;
  const y = h - 30;
  g.strokeStyle = FG;
  g.lineWidth = 2;
  g.lineCap = 'butt';
  g.beginPath();
  g.moveTo(x, y - 4);
  g.lineTo(x, y);
  g.lineTo(x + px, y);
  g.lineTo(x + px, y - 4);
  g.stroke();
  g.font = FONT;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = FG;
  g.fillText(`${fmtMeters(len, len)} ${t('u.m')}`, x, y - 8);
  if (cursor) {
    g.fillStyle = MUTED;
    g.fillText(`x ${cursor[0].toFixed(2)}  y ${cursor[1].toFixed(2)} ${t('u.m')}`, x, h - 10);
  }
}

// ---------------------------------------------------------------- icons
// Both icons are authored at a fixed pixel size (the minimum on screen) and scaled by the factor
// from scale.ts, so they cover their physical size (speaker 0.3 m, head 0.2 m) once zoomed in.

export const speakerExtent = (s: number) => 20 * speakerScale(s); // px from centre to the farthest drawn point

/**
 * Handle of a stereo pair or a directional source (px): the centre knob moves it, the dot at the end of the arrow turns it.
 * The arrow points where it faces.
 */
export function pairHandle(v: View, src: Pick<Source, 'pos' | 'angle'>): { c: Pt; tip: Pt } {
  const [x, y] = toPx(v, src.pos[0], src.pos[1]);
  // well outside the speaker icon and its selection ring, so the dot is visible and easy to grab
  const d = Math.max(40, 2.4 * speakerExtent(v.s));
  return { c: [x, y], tip: [x + d * Math.cos(src.angle), y - d * Math.sin(src.angle)] };
}
export const headExtent = (s: number) => 17 * headScale(s);

/** Speaker icon at `at` (default: the source's position); `label` ("L" / "R") is printed under it. */
/** Speaker icon; `angle` (radians CCW from +x) turns its cone, mono sources keep facing +x. */
export function drawSource(g: CanvasRenderingContext2D, v: View, src: Source, selected: boolean, at: readonly number[] = src.pos, label = '', angle = 0) {
  const [x, y] = toPx(v, at[0], at[1]);
  const k = speakerScale(v.s);
  g.save();
  g.translate(x, y);
  g.scale(k, k);
  g.rotate(-angle); // world CCW, canvas y points down
  g.globalAlpha = src.muted ? 0.4 : 1;
  if (selected) {
    g.beginPath();
    g.arc(2, 0, 19, 0, Math.PI * 2);
    g.strokeStyle = src.color;
    g.lineWidth = 2;
    g.stroke();
  }
  g.fillStyle = src.color;
  g.fillRect(-9, -5, 6, 10);
  g.beginPath();
  g.moveTo(-3, -5); g.lineTo(5, -11); g.lineTo(5, 11); g.lineTo(-3, 5);
  g.closePath();
  g.fill();
  g.strokeStyle = src.color;
  g.lineWidth = 2;
  for (const r of [9, 14]) {
    g.beginPath();
    g.arc(5, 0, r, -0.8, 0.8);
    g.stroke();
  }
  g.restore();
  if (label) {
    g.save();
    g.globalAlpha = src.muted ? 0.4 : 1;
    g.font = FONT;
    g.fillStyle = FG;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillText(label, x, y + 21 * k);
    g.restore();
  }
}

/**
 * Arrow from the source centre to a dot that turns it (`pairHandle`); a pair also gets a centre knob to move it
 * (a single speaker is moved by its icon).
 */
function drawTurnHandle(g: CanvasRenderingContext2D, v: View, src: Source, selected: boolean, knob: boolean) {
  const { c, tip } = pairHandle(v, src);
  g.save();
  g.globalAlpha = src.muted ? 0.4 : 1;
  g.strokeStyle = src.color;
  g.fillStyle = src.color;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(c[0], c[1]);
  g.lineTo(tip[0], tip[1]);
  g.stroke();
  if (knob) {
    g.beginPath();
    g.arc(c[0], c[1], 6, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = selected ? FG : BG;
    g.stroke();
  }
  g.lineWidth = 2;
  g.beginPath();
  g.arc(tip[0], tip[1], 4.5, 0, Math.PI * 2);
  g.fillStyle = BG;
  g.fill();
  g.strokeStyle = src.color;
  g.stroke();
  g.restore();
}

/** A directional mono source: the speaker turned to its facing angle, with the rotation handle of a pair. */
export function drawSourceDirectional(g: CanvasRenderingContext2D, v: View, src: Source, selected: boolean) {
  drawTurnHandle(g, v, src, selected, false);
  drawSource(g, v, src, selected, src.pos, '', src.angle);
}

/**
 * Stereo pair: the two speakers (L / R, turned the way the pair faces) joined by a thin line, and a handle
 * at the centre: a knob to move the pair and an arrow whose end dot turns it.
 */
export function drawSourcePair(g: CanvasRenderingContext2D, v: View, src: Source, selected: boolean) {
  const { l, r } = pairPositions(src);
  const [lx, ly] = toPx(v, l[0], l[1]);
  const [rx, ry] = toPx(v, r[0], r[1]);
  g.save();
  g.globalAlpha = src.muted ? 0.4 : 1;
  g.strokeStyle = src.color;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(lx, ly);
  g.lineTo(rx, ry);
  g.stroke();
  g.restore();
  drawTurnHandle(g, v, src, selected, true);
  drawSource(g, v, src, false, l, 'L', src.angle);
  drawSource(g, v, src, false, r, 'R', src.angle);
}

/** Listener head with nose; yaw is CCW from +x in world, so negate for the y-down canvas. */
export function drawListener(g: CanvasRenderingContext2D, v: View, pos: Pt | [number, number, number], yaw: number) {
  const [x, y] = toPx(v, pos[0], pos[1]);
  const k = headScale(v.s);
  g.save();
  g.translate(x, y);
  g.scale(k, k);
  g.rotate(-yaw);
  g.fillStyle = FG;
  g.beginPath();
  g.arc(0, 0, HEAD_PX / 2, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(9, -4); g.lineTo(17, 0); g.lineTo(9, 4);
  g.closePath();
  g.fill();
  g.fillStyle = BG;
  g.fillRect(-2, -12, 4, 3);
  g.fillRect(-2, 9, 4, 3);
  g.restore();
}

