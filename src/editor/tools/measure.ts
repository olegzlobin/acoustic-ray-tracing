// Measure tool: drag to read distance and angle; the dimension line stays until Esc or the next drag.
import { TEAL_LIGHT } from '../../theme';
import type { Pt } from '../../scene';
import { t } from '../../i18n.svelte';
import { dist } from '../geometry';
import { label } from '../render';
import { toPx } from '../view';
import { snapMarker } from './draw';
import type { PointerInfo, Tool, ToolHost } from './types';

const angleDeg = (a: Pt, b: Pt) => ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 360;

export class MeasureTool implements Tool {
  cursor = 'crosshair';
  private a: Pt | null = null;
  private b: Pt | null = null;
  private dragging = false;
  private hover: Pt | null = null;

  active() {
    return this.a !== null;
  }

  down(h: ToolHost, p: PointerInfo): boolean {
    const q = h.snap(p.w, p.mods, null).p;
    this.a = q;
    this.b = q;
    this.dragging = true;
    h.invalidate();
    return true;
  }

  move(h: ToolHost, p: PointerInfo) {
    this.hover = h.snap(p.w, p.mods, this.dragging ? this.a : null).p;
    if (this.dragging) this.b = this.hover;
    h.invalidate();
  }

  up(h: ToolHost, _p: PointerInfo) {
    this.dragging = false;
    if (this.a && this.b && dist(this.a, this.b) < 0.01) this.a = this.b = null; // a plain click clears
    h.invalidate();
  }

  leave() {
    this.hover = null;
  }

  cancel(h: ToolHost) {
    this.a = this.b = null;
    this.dragging = false;
    h.invalidate();
  }

  draw(h: ToolHost, g: CanvasRenderingContext2D) {
    if (this.a && this.b && dist(this.a, this.b) >= 0.005) {
      const [x0, y0] = toPx(h.view, this.a[0], this.a[1]);
      const [x1, y1] = toPx(h.view, this.b[0], this.b[1]);
      const len = Math.hypot(x1 - x0, y1 - y0);
      const [ux, uy] = [(x1 - x0) / len, (y1 - y0) / len];
      const [nx, ny] = [-uy, ux];
      g.strokeStyle = TEAL_LIGHT;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      for (const [x, y] of [[x0, y0], [x1, y1]]) {
        g.moveTo(x + nx * 6, y + ny * 6);
        g.lineTo(x - nx * 6, y - ny * 6);
      }
      g.stroke();
      const d = dist(this.a, this.b);
      const text = `${d.toFixed(2)} ${t('u.m')} · ${angleDeg(this.a, this.b).toFixed(1)}°`;
      const side = ny > 0 || (ny === 0 && nx > 0) ? -1 : 1; // keep the label above the line
      label(g, text, (x0 + x1) / 2 + nx * 14 * side, (y0 + y1) / 2 + ny * 14 * side, 'center');
    }
    if (this.hover) snapMarker(g, h, this.hover, false);
  }
}
