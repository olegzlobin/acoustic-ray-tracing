// Shape tools: rectangle, regular polygon, circle, ellipse, 3-click arc, and stamps.
// Drag (or click, move, click) to size; Shift constrains; Esc cancels. The preview is the exact wall set.
import { ERR, FG } from '../../theme';
import type { Pt } from '../../scene';
import { t } from '../../i18n.svelte';
import { dist } from '../geometry';
import { label } from '../render';
import { arcPoints, circleSegments, circumcircle, edgesOk, ellipsePoints, rectPoints, regularPolygon, STAMPS } from '../shapes';
import { toPx } from '../view';
import { snapMarker } from './draw';
import type { PointerInfo, Tool, ToolHost } from './types';

export type ShapeKind = 'rect' | 'polygon' | 'circle' | 'ellipse' | 'arc' | 'stamp';

interface Preview {
  pts: Pt[];
  closed: boolean;
  text: string;
  at: Pt;
}

const DRAG_PX = 6;

export class ShapeTool implements Tool {
  cursor = 'crosshair';
  /** Placed points: anchor (and, for arcs, start + end). */
  private pts: Pt[] = [];
  private cur: Pt | null = null;
  private shift = false;
  private startPx: Pt = [0, 0];
  private pressed = false;
  private moved = false;
  constructor(readonly kind: ShapeKind) {}

  active() {
    return this.pts.length > 0;
  }

  /** The shape for the current anchor and pointer, or null while it is degenerate. */
  private preview(h: ToolHost): Preview | null {
    const c = this.cur;
    if (!c) return null;
    const a = this.pts[0];
    const f = (v: number) => v.toFixed(2);
    switch (this.kind) {
      case 'stamp': {
        const s = STAMPS.find((x) => x.id === h.params.stamp) ?? STAMPS[0];
        return { pts: s.make(c), closed: true, text: s.name, at: c };
      }
      case 'rect': {
        if (!a) return null;
        const pts = rectPoints(a, c, this.shift);
        return { pts, closed: true, text: `${f(Math.abs(pts[2][0] - a[0]))} × ${f(Math.abs(pts[2][1] - a[1]))} ${t('u.m')}`, at: c };
      }
      case 'polygon': {
        if (!a) return null;
        const pts = regularPolygon(a, c, h.params.sides, this.shift ? 15 : 0);
        return { pts, closed: true, text: `r ${f(dist(a, c))} m · ${pts.length} sides`, at: c };
      }
      case 'circle': {
        if (!a) return null;
        const r = dist(a, c);
        const pts = ellipsePoints(a, r, r, circleSegments(r, r, h.params.circleSegs));
        return { pts, closed: true, text: `Ø ${f(2 * r)} m · ${pts.length} seg`, at: c };
      }
      case 'ellipse': {
        if (!a) return null;
        let [dx, dy] = [c[0] - a[0], c[1] - a[1]];
        if (this.shift) {
          const m = Math.max(Math.abs(dx), Math.abs(dy));
          [dx, dy] = [(dx < 0 ? -1 : 1) * m, (dy < 0 ? -1 : 1) * m];
        }
        const [rx, ry] = [Math.abs(dx) / 2, Math.abs(dy) / 2];
        const pts = ellipsePoints([a[0] + dx / 2, a[1] + dy / 2], rx, ry, circleSegments(rx, ry, h.params.circleSegs));
        return { pts, closed: true, text: `${f(2 * rx)} × ${f(2 * ry)} m · ${pts.length} seg`, at: c };
      }
      case 'arc': {
        if (!a) return null;
        if (this.pts.length === 1) return { pts: [a, c], closed: false, text: `${f(dist(a, c))} ${t('u.m')}`, at: c };
        const pts = arcPoints(a, this.pts[1], c, h.params.arcSegs);
        const cc = circumcircle(a, this.pts[1], c);
        return { pts, closed: false, text: cc ? `R ${f(cc.r)} ${t('u.m')} · ${pts.length - 1} ${t('u.seg')}` : `${f(dist(a, this.pts[1]))} ${t('u.m')}`, at: c };
      }
    }
  }

  private commit(h: ToolHost) {
    const pv = this.preview(h);
    this.reset(h);
    if (pv && edgesOk(pv.pts, pv.closed)) {
      const s = this.kind === 'stamp' ? STAMPS.find((x) => x.id === h.params.stamp) ?? STAMPS[0] : null;
      h.addShape(pv.pts, pv.closed, true, s ? { mat: s.mat, z0: s.z0, z1: s.z1 } : undefined);
    }
  }

  private reset(h: ToolHost) {
    this.pts = [];
    this.pressed = false;
    this.moved = false;
    this.cur = null;
    h.invalidate();
  }

  private snap(h: ToolHost, p: PointerInfo) {
    return h.snap(p.w, p.mods, null, { extra: this.pts, noAngle: true });
  }

  down(h: ToolHost, p: PointerInfo): boolean {
    const { p: q } = this.snap(h, p);
    this.cur = q;
    this.shift = p.mods.shift;
    if (this.kind === 'stamp') {
      this.commit(h);
      return true;
    }
    if (this.kind === 'arc') {
      if (this.pts.length === 2) {
        this.commit(h);
        return true;
      }
      if (this.pts.length === 0 || dist(q, this.pts[this.pts.length - 1]) > 0.01) this.pts = [...this.pts, q];
    } else if (this.pts.length === 0) {
      this.pts = [q];
      this.startPx = p.px;
      this.pressed = true;
      this.moved = false;
    } else {
      this.commit(h); // second click of click-move-click
      return true;
    }
    h.invalidate();
    return true;
  }

  move(h: ToolHost, p: PointerInfo) {
    this.cur = this.snap(h, p).p;
    this.shift = p.mods.shift;
    if (this.pressed && Math.hypot(p.px[0] - this.startPx[0], p.px[1] - this.startPx[1]) > DRAG_PX) this.moved = true;
    h.invalidate();
  }

  up(h: ToolHost, p: PointerInfo) {
    if (this.pressed && this.moved) {
      this.cur = this.snap(h, p).p;
      this.commit(h);
    }
    this.pressed = false;
  }

  cancel(h: ToolHost) {
    this.reset(h);
  }

  leave() {
    if (!this.pts.length) this.cur = null;
  }

  draw(h: ToolHost, g: CanvasRenderingContext2D) {
    const pv = this.preview(h);
    if (pv) {
      const ok = edgesOk(pv.pts, pv.closed);
      g.strokeStyle = ok ? FG : ERR;
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.beginPath();
      pv.pts.forEach((p, i) => {
        const [x, y] = toPx(h.view, p[0], p[1]);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      if (pv.closed) g.closePath();
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = FG;
      for (const p of pv.pts) {
        const [x, y] = toPx(h.view, p[0], p[1]);
        g.beginPath();
        g.arc(x, y, 2, 0, Math.PI * 2);
        g.fill();
      }
      const [tx, ty] = toPx(h.view, pv.at[0], pv.at[1]);
      if (this.kind !== 'stamp') label(g, pv.text, tx + 12, ty - 14);
    }
    if (this.cur) snapMarker(g, h, this.cur, false);
  }
}
