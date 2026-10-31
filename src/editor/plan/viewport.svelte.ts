import { allVertices, dist } from '../geometry';
import { MAX_ZOOM, MIN_ZOOM, type View } from '../view';
import type { Pt, Scene } from '../../scene';

const PAD = 28;
const clampZoom = (s: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));

/** Pan / zoom / fit state of the plan view (pixels per metre `s`, origin offset). */
export class Viewport {
  view = $state<View>({ s: 40, ox: 0, oy: 300 });
  box = $state({ w: 300, h: 300 });
  /** The user panned or zoomed by hand: stop re-fitting on resize / scene changes. */
  userView = false;
  private panLast: Pt = [0, 0];
  private pinch = { d0: 1, mid0: [0, 0] as Pt, s0: 1, ox0: 0, oy0: 0 };

  fit(scene: Scene) {
    const { box } = this;
    const pts: Pt[] = [...allVertices(scene.walls), ...scene.sources.map((s): Pt => [s.pos[0], s.pos[1]]), [scene.listener[0], scene.listener[1]]];
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of pts) [x0, y0, x1, y1] = [Math.min(x0, p[0]), Math.min(y0, p[1]), Math.max(x1, p[0]), Math.max(y1, p[1])];
    if (!isFinite(x0)) [x0, y0, x1, y1] = [0, 0, 10, 7];
    const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
    const s = Math.min((box.w - 2 * PAD) / w, (box.h - 2 * PAD) / h);
    this.view = { s, ox: (box.w - s * w) / 2 - s * x0, oy: (box.h - s * h) / 2 + s * y1 };
  }
  /** Fit button: forget the manual view. */
  userFit(scene: Scene) {
    this.userView = false;
    this.fit(scene);
  }

  startPan(p: Pt) {
    this.panLast = p;
  }
  pan(p: Pt) {
    this.userView = true;
    this.view = { ...this.view, ox: this.view.ox + p[0] - this.panLast[0], oy: this.view.oy + p[1] - this.panLast[1] };
    this.panLast = p;
  }

  startPinch(a: Pt, b: Pt) {
    const { view } = this;
    this.pinch = { d0: Math.max(1, dist(a, b)), mid0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], s0: view.s, ox0: view.ox, oy0: view.oy };
  }
  pinchTo(a: Pt, b: Pt) {
    const pinch = this.pinch;
    const d = dist(a, b);
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = clampZoom((pinch.s0 * d) / pinch.d0);
    const k = s / pinch.s0;
    this.userView = true;
    this.view = { s, ox: mid[0] - (pinch.mid0[0] - pinch.ox0) * k, oy: mid[1] - (pinch.mid0[1] - pinch.oy0) * k };
  }

  /** Zoom about the canvas point (mx, my) by a wheel delta. */
  zoomAt(mx: number, my: number, deltaY: number, fine: boolean) {
    const { view } = this;
    const k = Math.exp(-deltaY * (fine ? 0.01 : 0.0015));
    const s = clampZoom(view.s * k);
    const kk = s / view.s;
    this.userView = true;
    this.view = { s, ox: mx - (mx - view.ox) * kk, oy: my - (my - view.oy) * kk };
  }
}
