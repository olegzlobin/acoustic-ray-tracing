// Select tool: click / shift-click walls, rubber-band (window or crossing), group move, vertex drag.
import { BG, FG, TEAL_LIGHT, WARN } from '../../theme';
import type { Pt, Wall } from '../../scene';
import { dist, hitWall, moveVertex, moveWall, nearestVertex } from '../geometry';
import { normRect, selectInRect, toggleIn, unionSel } from '../selection';
import { translateWalls } from '../transform';
import { toPx } from '../view';
import type { PointerInfo, Tool, ToolHost } from './types';

type Mode = 'none' | 'vertex' | 'wall' | 'group' | 'band';

const same = (a: Pt, b: Pt) => dist(a, b) < 1e-6;

export class SelectTool implements Tool {
  cursor = 'default';
  private mode: Mode = 'none';
  /** The walls as they were when the gesture started (drags are computed from here). */
  private base: Wall[] = [];
  private started = false;
  private vertex: Pt = [0, 0];
  private vertexNow: Pt = [0, 0];
  private ids: number[] = [];
  private anchor: Pt = [0, 0];
  private grab: Pt = [0, 0];
  private band: { a: Pt; b: Pt; crossing: boolean; additive: boolean; startPx: Pt; moved: boolean } | null = null;

  active() {
    return this.mode !== 'none';
  }

  down(h: ToolHost, p: PointerInfo): boolean {
    const walls = h.scene.walls;
    const tol = (p.touch ? 16 : 9) / h.view.s;
    const additive = p.mods.shift || p.mods.ctrl;
    this.started = false;
    const v = additive ? null : nearestVertex(walls, p.w, tol);
    if (v) {
      this.vertex = v;
      this.vertexNow = v;
      this.base = walls;
      if (!h.selection.some((k) => walls[k] && (same(walls[k].a, v) || same(walls[k].b, v)))) {
        const i = walls.findIndex((x) => same(x.a, v) || same(x.b, v));
        h.setSelection(i >= 0 ? [i] : []);
      }
      this.mode = 'vertex';
      return true;
    }
    const i = hitWall(walls, p.w, tol);
    if (i >= 0) {
      let sel = h.selection;
      if (additive) sel = toggleIn(sel, i);
      else if (!sel.includes(i)) sel = [i];
      h.setSelection(sel);
      if (!sel.includes(i)) return true; // toggled off: nothing to drag
      this.ids = sel;
      this.base = walls;
      this.grab = p.w;
      // The group's anchor is its endpoint nearest to the grab point: it is the one that snaps.
      let best = Infinity;
      for (const k of sel)
        for (const e of [walls[k].a, walls[k].b]) {
          const d = dist(e, p.w);
          if (d < best) {
            best = d;
            this.anchor = [e[0], e[1]];
          }
        }
      this.mode = sel.length === 1 ? 'wall' : 'group';
      return true;
    }
    this.band = { a: p.w, b: p.w, crossing: false, additive, startPx: p.px, moved: false };
    this.mode = 'band';
    return true;
  }

  private begin(h: ToolHost) {
    if (!this.started) {
      this.started = true;
      h.beginEdit();
    }
  }

  move(h: ToolHost, p: PointerInfo) {
    if (this.mode === 'band' && this.band) {
      const b = this.band;
      b.b = p.w;
      b.crossing = p.mods.alt || p.px[0] < b.startPx[0];
      if (Math.hypot(p.px[0] - b.startPx[0], p.px[1] - b.startPx[1]) > 4) b.moved = true;
      h.invalidate();
    } else if (this.mode === 'vertex') {
      const { p: q } = h.snap(p.w, p.mods, null, { exclude: [this.vertexNow], noAngle: true });
      const out = moveVertex(this.base, this.vertex, q);
      if (out) {
        this.begin(h);
        h.liveEdit(out);
        this.vertexNow = q;
      }
    } else if (this.mode === 'wall' || this.mode === 'group') {
      const target = h.snap([this.anchor[0] + p.w[0] - this.grab[0], this.anchor[1] + p.w[1] - this.grab[1]], p.mods, null, {
        exclude: this.ids.flatMap((k) => (h.scene.walls[k] ? [h.scene.walls[k].a, h.scene.walls[k].b] : [])),
        noAngle: true,
      }).p;
      const [dx, dy] = [target[0] - this.anchor[0], target[1] - this.anchor[1]];
      // One wall drags its joined neighbours along; a group detaches from walls outside it.
      const out = this.mode === 'wall' ? moveWall(this.base, this.ids[0], dx, dy) : translateWalls(this.base, this.ids, dx, dy);
      if (out) {
        this.begin(h);
        h.liveEdit(out);
      }
    }
  }

  up(h: ToolHost, _p: PointerInfo) {
    if (this.mode === 'band' && this.band) {
      const b = this.band;
      if (!b.moved) {
        if (!b.additive) h.setSelection([]);
      } else {
        const hit = selectInRect(h.scene.walls, normRect(b.a, b.b), b.crossing);
        h.setSelection(b.additive ? unionSel(h.selection, hit) : hit);
      }
      this.band = null;
    } else if (this.started) {
      h.endEdit();
    }
    this.mode = 'none';
    this.started = false;
    h.invalidate();
  }

  cancel(h: ToolHost) {
    if (this.started) {
      h.liveEdit(this.base);
      h.endEdit();
    }
    this.band = null;
    this.mode = 'none';
    this.started = false;
    h.invalidate();
  }

  draw(h: ToolHost, g: CanvasRenderingContext2D) {
    // Vertex handles of the selection
    const sel = h.selection.map((k) => h.scene.walls[k]).filter(Boolean);
    g.fillStyle = FG;
    g.strokeStyle = BG;
    g.lineWidth = 2;
    for (const w of sel)
      for (const q of [w.a, w.b]) {
        const [x, y] = toPx(h.view, q[0], q[1]);
        g.beginPath();
        g.arc(x, y, 6, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    if (this.mode === 'band' && this.band?.moved) {
      const [x0, y0] = toPx(h.view, this.band.a[0], this.band.a[1]);
      const [x1, y1] = toPx(h.view, this.band.b[0], this.band.b[1]);
      const crossing = this.band.crossing;
      g.fillStyle = crossing ? 'rgba(232,191,58,.10)' : 'rgba(88,203,214,.12)';
      g.strokeStyle = crossing ? WARN : TEAL_LIGHT;
      g.lineWidth = 1.5;
      g.setLineDash(crossing ? [6, 4] : []);
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.setLineDash([]);
    }
  }
}
