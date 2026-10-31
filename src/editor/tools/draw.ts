// Polyline wall drawing: click vertices, double-click / Enter / Esc to finish, click the first point to close.
import { FG, WARN } from '../../theme';
import type { Pt } from '../../scene';
import { t } from '../../i18n.svelte';
import { dist } from '../geometry';
import { label } from '../render';
import { toPx } from '../view';
import type { PointerInfo, Tool, ToolHost } from './types';

export class DrawTool implements Tool {
  cursor = 'crosshair';
  pts: Pt[] = [];
  private hover: { p: Pt; onPoint: boolean } | null = null;

  active() {
    return this.pts.length > 0;
  }

  private snap(h: ToolHost, p: PointerInfo) {
    return h.snap(p.w, p.mods, this.pts.length ? this.pts[this.pts.length - 1] : null, { extra: this.pts });
  }

  down(h: ToolHost, p: PointerInfo): boolean {
    const { p: q } = this.snap(h, p);
    const last = this.pts[this.pts.length - 1];
    if (last && dist(q, last) < 0.01) return true; // 2nd click of a double-click
    if (this.pts.length >= 2 && dist(q, this.pts[0]) < 1e-6) {
      h.addShape(this.pts, true, false);
      this.pts = [];
    } else this.pts = [...this.pts, q];
    h.invalidate();
    return true;
  }

  move(h: ToolHost, p: PointerInfo) {
    this.hover = this.snap(h, p);
    h.invalidate();
  }

  up() {}

  finish(h: ToolHost) {
    if (this.pts.length >= 2) h.addShape(this.pts, false, false);
    this.pts = [];
    this.hover = null;
    h.invalidate();
  }

  cancel(h: ToolHost) {
    this.finish(h);
  }

  leave() {
    this.hover = null;
  }

  draw(h: ToolHost, g: CanvasRenderingContext2D) {
    g.strokeStyle = FG;
    g.lineWidth = 2;
    g.setLineDash([6, 4]);
    g.beginPath();
    this.pts.forEach((p, i) => {
      const [x, y] = toPx(h.view, p[0], p[1]);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    if (this.hover && this.pts.length) {
      const [x, y] = toPx(h.view, this.hover.p[0], this.hover.p[1]);
      g.lineTo(x, y);
    }
    g.stroke();
    g.setLineDash([]);
    if (this.hover && this.pts.length) {
      const [x, y] = toPx(h.view, this.hover.p[0], this.hover.p[1]);
      label(g, `${dist(this.pts[this.pts.length - 1], this.hover.p).toFixed(2)} ${t('u.m')}`, x + 10, y - 12);
    }
    if (this.hover) snapMarker(g, h, this.hover.p, this.hover.onPoint);
  }
}

export function snapMarker(g: CanvasRenderingContext2D, h: ToolHost, p: Pt, onPoint: boolean) {
  const [x, y] = toPx(h.view, p[0], p[1]);
  g.beginPath();
  g.arc(x, y, onPoint ? 8 : 4, 0, Math.PI * 2);
  g.strokeStyle = onPoint ? WARN : FG;
  g.lineWidth = 2;
  g.stroke();
}
