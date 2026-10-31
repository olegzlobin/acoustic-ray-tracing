import { isDirectional } from '../../directivity';
import { cellAt, formatHeat } from '../../heatmap';
import type { Pt } from '../../scene';
import { pairPositions } from '../../stereo';
import { headExtent, pairHandle, speakerExtent } from '../render';
import type { Mods, PointerInfo, Tool, ToolHost } from '../tools/types';
import { toPx, toWorld } from '../view';
import type { PlanProps } from './types';
import type { PlanUi } from './ui.svelte';
import type { Viewport } from './viewport.svelte';

type Mode = 'none' | 'src' | 'rot' | 'lis' | 'tool' | 'pan' | 'pinch';

export interface GestureContext {
  props: PlanProps;
  ui: PlanUi;
  vp: Viewport;
  canvas(): HTMLCanvasElement;
  tool(): Tool;
  host: ToolHost;
}

/** Pointer interaction of the plan (mouse, touch, pen): icon drag, pan, pinch, wheel zoom/yaw, tool dispatch. */
export class Gestures {
  mode = $state<Mode>('none');
  /** Last hover info while the pointer is over the canvas and no gesture runs. */
  lastInfo: PointerInfo | null = null;
  private dragSrc = 0;
  /** Grab offset (world) from the pointer to the source centre: dragging a speaker of a pair moves the centre. */
  private dragOff: Pt = [0, 0];
  private pointers = new Map<number, Pt>();
  /** A run of wheel turns (head or pair) is one undo step, closed after a short pause. */
  private wheelEdit = 0;
  private wheelTurn() {
    const { props } = this.c;
    if (!this.wheelEdit) props.onbeginedit();
    clearTimeout(this.wheelEdit);
    this.wheelEdit = window.setTimeout(() => {
      this.wheelEdit = 0;
      this.c.props.onendedit();
    }, 400);
  }

  constructor(private c: GestureContext) {}

  private local(e: { clientX: number; clientY: number }): Pt {
    const r = this.c.canvas().getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  private nearPx(e: { clientX: number; clientY: number }, p: [number, number, number] | Pt) {
    const [px, py] = this.local(e);
    const [x, y] = toPx(this.c.vp.view, p[0], p[1]);
    return Math.hypot(px - x, py - y);
  }
  private mods(e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Mods {
    return { shift: e.shiftKey || this.c.ui.shiftLock, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
  }
  private info(e: PointerEvent | MouseEvent): PointerInfo {
    const px = this.local(e);
    return { w: toWorld(this.c.vp.view, px[0], px[1]), px, mods: this.mods(e), touch: (e as PointerEvent).pointerType === 'touch' };
  }

  down = (e: PointerEvent) => {
    const { props, ui, vp, host } = this.c;
    const T = this.c.tool();
    const canvas = this.c.canvas();
    canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 2) {
      if (this.mode === 'tool' && T.active() && props.tool !== 'draw') T.cancel(host);
      const [a, b] = [...this.pointers.values()];
      vp.startPinch(a, b);
      this.mode = 'pinch';
      return;
    }
    if (this.pointers.size > 2) return;
    if (e.button === 1 || (e.button === 0 && ui.spaceDown)) {
      this.mode = 'pan';
      vp.startPan(this.local(e));
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    ui.matMenu = false;
    // Source / listener icons are grabbed in any tool; their hit area is the drawn size (at least a finger/mouse target).
    const R = e.pointerType === 'touch' ? 34 : 22;
    const s = vp.view.s;
    let best = Infinity;
    let hitSrc = -1;
    let hitAt: Pt = [0, 0];
    // The rotation dot of a stereo pair or a directional source wins over everything else under the pointer.
    const [px, py] = this.local(e);
    const rot = props.scene.sources.findIndex((src, i) => {
      if (!(props.pairActive[i] || isDirectional(src))) return false;
      const { tip } = pairHandle(vp.view, src);
      return Math.hypot(px - tip[0], py - tip[1]) <= (e.pointerType === 'touch' ? 22 : 10);
    });
    if (rot >= 0) {
      props.onbeginedit(); // one undo step per drag (committed on release)
      this.mode = 'rot';
      this.dragSrc = rot;
      props.onselectsource(rot);
      e.preventDefault();
      return;
    }
    props.scene.sources.forEach((src, i) => {
      // A pair is grabbed by its centre knob or by either speaker; all of them move the pair.
      const pp = props.pairActive[i] ? pairPositions(src) : null;
      for (const p of pp ? [src.pos, pp.l, pp.r] : [src.pos]) {
        const d = this.nearPx(e, p);
        if (d <= Math.max(R, speakerExtent(s)) && d < best) {
          best = d;
          hitSrc = i;
          hitAt = [p[0], p[1]];
        }
      }
    });
    const dl = this.nearPx(e, props.scene.listener);
    const hitLis = dl <= Math.max(R, headExtent(s)) && dl <= best;
    if (hitLis || hitSrc >= 0) {
      props.onbeginedit(); // one undo step per drag (committed on release)
      if (hitLis) this.mode = 'lis';
      else {
        this.mode = 'src';
        this.dragSrc = hitSrc;
        // Dragging a speaker of a pair keeps the grab point under the pointer (the centre follows with this offset; 0 for a single speaker).
        const c = props.scene.sources[hitSrc].pos;
        this.dragOff = [c[0] - hitAt[0], c[1] - hitAt[1]];
        props.onselectsource(hitSrc);
      }
      e.preventDefault();
      return;
    }
    if (T.down(host, this.info(e))) this.mode = 'tool';
  };

  move = (e: PointerEvent) => {
    const { props, ui, vp, host } = this.c;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, this.local(e));
    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      vp.pinchTo(a, b);
      return;
    }
    if (this.mode === 'pan') {
      vp.pan(this.local(e));
      return;
    }
    const pi = this.info(e);
    this.lastInfo = pi;
    ui.cursorW = pi.w;
    const w = pi.w;
    if (this.mode === 'src') return props.onsource(this.dragSrc, [w[0] + this.dragOff[0], w[1] + this.dragOff[1]]);
    if (this.mode === 'rot') {
      const c = props.scene.sources[this.dragSrc].pos;
      return props.onrotatesource(this.dragSrc, Math.atan2(w[1] - c[1], w[0] - c[0]));
    }
    if (this.mode === 'lis') return props.onlistener([w[0], w[1]]);
    this.c.tool().move(host, pi);
    this.updateHeatHover(w);
  };

  private updateHeatHover(w: Pt) {
    const { heat, heatMetric } = this.c.props;
    if (!heat) {
      this.c.ui.heatHover = '';
      return;
    }
    const cell = cellAt(heat, w[0], w[1]);
    this.c.ui.heatHover = cell >= 0 && heat.mask[cell] ? `${heat.label}: ${formatHeat(heat.values[cell], heatMetric)}` : '';
  }

  up = (e: PointerEvent) => {
    const canvas = this.c.canvas();
    this.pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (this.mode === 'pinch') {
      if (this.pointers.size < 2) this.mode = 'none';
      return;
    }
    const was = this.mode;
    this.mode = 'none';
    if (was === 'tool') this.c.tool().up(this.c.host, this.info(e));
    if (was === 'src' || was === 'rot' || was === 'lis') {
      this.c.props.onendedit();
      this.c.props.onrelease?.();
    }
  };

  leave = () => {
    const { ui } = this.c;
    if (this.mode === 'none') {
      ui.cursorW = null;
      this.lastInfo = null;
      this.c.tool().leave?.();
      ui.tick++;
    }
    ui.heatHover = '';
  };

  /** Wheel over the head (or a stereo pair / directional source) turns it, elsewhere zooms about the cursor. Registered non-passive by the canvas. */
  wheel = (e: WheelEvent) => {
    const { props, vp } = this.c;
    e.preventDefault();
    if (this.nearPx(e, props.scene.listener) <= Math.max(30, headExtent(vp.view.s) + 4)) {
      this.wheelTurn();
      props.onyaw(props.scene.yaw - Math.sign(e.deltaY) * (Math.PI / 24));
      return;
    }
    // Wheel over a speaker of a stereo pair (or over a directional source) turns it, like the head.
    const hit = props.scene.sources.findIndex((src, i) => {
      const pair = props.pairActive[i];
      if (!(pair || isDirectional(src))) return false;
      const { l, r } = pair ? pairPositions(src) : { l: src.pos, r: src.pos };
      return [src.pos, l, r].some((p) => this.nearPx(e, p) <= Math.max(30, speakerExtent(vp.view.s) + 4));
    });
    if (hit >= 0) {
      const src = props.scene.sources[hit];
      this.wheelTurn();
      props.onrotatesource(hit, src.angle - Math.sign(e.deltaY) * (Math.PI / 24));
      return;
    }
    const [mx, my] = this.local(e);
    vp.zoomAt(mx, my, e.deltaY, e.ctrlKey);
  };
}
