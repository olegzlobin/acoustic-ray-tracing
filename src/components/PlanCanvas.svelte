<script lang="ts">
  import { untrack } from 'svelte';
  import { SelectionActions } from '../editor/plan/actions';
  import { Gestures } from '../editor/plan/gestures.svelte';
  import { canvasKey, globalKeydown, globalKeyup, typing, type KeyContext } from '../editor/plan/keyboard';
  import { heatImage, renderPlan } from '../editor/plan/render';
  import { parseClip } from '../editor/clipboard';
  import type { PlanProps, ToolId } from '../editor/plan/types';
  import { PlanUi } from '../editor/plan/ui.svelte';
  import { Viewport } from '../editor/plan/viewport.svelte';
  import { addPolyline, allVertices, dist, snapPoint } from '../editor/geometry';
  import { RULER } from '../editor/render';
  import { DrawTool } from '../editor/tools/draw';
  import { MeasureTool } from '../editor/tools/measure';
  import { SelectTool } from '../editor/tools/select';
  import { ShapeTool } from '../editor/tools/shapes';
  import type { Tool, ToolHost } from '../editor/tools/types';
  import { normalizeWallZ, type Pt } from '../scene';
  import { t } from '../i18n.svelte';
  import HeatLegend from './HeatLegend.svelte';
  import PlanToolbar from './PlanToolbar.svelte';
  import SelectionBar from './SelectionBar.svelte';

  // The modules read the props lazily through this object, so they stay reactive.
  const props: PlanProps = $props();

  const ui = new PlanUi();
  const vp = new Viewport();
  let canvas: HTMLCanvasElement;

  const matColor = $derived(new Map(props.scene.materials.map((m) => [m.id, m.color])));
  const selSet = $derived(new Set(props.selection));
  const rulerPad = $derived(ui.showRuler ? RULER : 0);

  // ---- view: re-fit on resize / new scene until the user pans or zooms by hand
  let lastFit = -1;
  $effect(() => {
    void vp.box;
    if (props.fitToken !== lastFit) {
      lastFit = props.fitToken;
      vp.userView = false;
    }
    if (vp.box.w > 20 && !vp.userView) untrack(() => vp.fit(props.scene));
  });
  $effect(() => {
    const ro = new ResizeObserver(([e]) => {
      vp.box = { w: e.contentRect.width, h: e.contentRect.height };
    });
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  });

  // ---- heat layer image
  let heatCanvas = $state<HTMLCanvasElement | null>(null);
  $effect(() => {
    heatCanvas = props.heat ? heatImage(props.heat) : null;
  });

  // ---- tools
  const tools: Record<ToolId, Tool> = {
    select: new SelectTool(),
    draw: new DrawTool(),
    measure: new MeasureTool(),
    rect: new ShapeTool('rect'),
    polygon: new ShapeTool('polygon'),
    circle: new ShapeTool('circle'),
    ellipse: new ShapeTool('ellipse'),
    arc: new ShapeTool('arc'),
    stamp: new ShapeTool('stamp'),
  };
  const T = $derived(tools[props.tool]);

  const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);
  const host: ToolHost = {
    get scene() { return props.scene; },
    get view() { return vp.view; },
    get grid() { return props.grid; },
    get gridStep() { return props.gridStep; },
    get drawMat() { return props.drawMat; },
    get selection() { return props.selection; },
    get params() { return ui.params; },
    snap(w, mods, from, o) {
      const pts: Pt[] = [...allVertices(props.scene.walls), ...(o?.extra ?? [])];
      const keep = o?.exclude ? pts.filter((q) => !o.exclude!.some((x) => dist(q, x) < 1e-6)) : pts;
      return snapPoint(w, { grid: props.grid, step: props.gridStep, points: keep, tol: 12 / vp.view.s, from, angle: mods.shift && !!from && !o?.noAngle });
    },
    setSelection: (ids) => props.onselection(ids),
    commit: (walls, sel) => props.oncommit(walls, sel),
    addShape(pts, closed, select, opts) {
      const n0 = props.scene.walls.length;
      // a stamp may bring its own material (if the scene has it) and height; plain shapes stay full height
      const mat = opts?.mat && props.scene.materials.some((m) => m.id === opts.mat) ? opts.mat : props.drawMat;
      const walls = addPolyline(props.scene.walls, pts, closed, mat);
      if (opts && (opts.z0 !== undefined || opts.z1 !== undefined))
        for (let i = n0; i < walls.length; i++) walls[i] = normalizeWallZ({ ...walls[i], ...(opts.z0 !== undefined ? { z0: opts.z0 } : {}), ...(opts.z1 !== undefined ? { z1: opts.z1 } : {}) }, props.scene.height);
      props.oncommit(walls, select ? range(props.scene.walls.length, walls.length) : props.selection);
    },
    beginEdit: () => props.onbeginedit(),
    liveEdit: (w) => props.onliveedit(w),
    endEdit: () => props.onendedit(),
    invalidate: () => ui.tick++,
  };

  // Leaving a tool aborts (draw: commits) what it had in progress.
  $effect(() => {
    const t = props.tool;
    untrack(() => {
      for (const id of Object.keys(tools) as ToolId[]) if (id !== t && tools[id].active()) tools[id].cancel(host);
    });
  });

  // ---- interaction
  // svelte-ignore state_referenced_locally (`props` is a live object, the modules read it lazily)
  const actions = new SelectionActions(props, ui);
  // svelte-ignore state_referenced_locally
  const gestures = new Gestures({ props, ui, vp, canvas: () => canvas, tool: () => T, host });
  // svelte-ignore state_referenced_locally
  const keys: KeyContext = { props, ui, actions, tool: () => T, host, hoverInfo: () => gestures.lastInfo };

  $effect(() => {
    canvas.addEventListener('wheel', gestures.wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', gestures.wheel);
  });
  $effect(() => {
    const down = (e: KeyboardEvent) => globalKeydown(keys, e, gestures.mode === 'none');
    const up = (e: KeyboardEvent) => globalKeyup(keys, e, gestures.mode === 'none');
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });
  // Pasting the clipboard text of another tab: only our own JSON is accepted, the rest is ignored.
  $effect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (typing(e.target)) return;
      const w = parseClip(e.clipboardData?.getData('text/plain') ?? '');
      if (w && !e.defaultPrevented) {
        e.preventDefault();
        actions.pasteWalls(w);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });
  $effect(() => {
    if (!ui.matMenu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.matpick')) ui.matMenu = false;
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  });

  // ---- drawing
  $effect(() => {
    // Track every reactive input of the drawing code.
    const p = props;
    void [p.scene.walls, p.scene.height, p.obstacles, p.scene.materials, p.scene.sources, p.scene.listener, p.scene.yaw, p.selection, p.selectedSource, heatCanvas, p.heat, p.tool, p.grid, p.gridStep, p.paths, p.rayPaths, p.showRays, p.showOrders, vp.box, vp.view, gestures.mode, ui.tick, ui.cursorW, ui.showRuler, ui.params.sides, ui.params.circleSegs, ui.params.arcSegs, ui.params.stamp, p.drawMat];
    renderPlan(canvas, { props: p, box: vp.box, view: vp.view, host, tool: T, toolId: p.tool, matColor, selSet, heatCanvas, showRuler: ui.showRuler, rulerPad, cursorW: ui.cursorW, interacting: gestures.mode === 'src' || gestures.mode === 'rot' || gestures.mode === 'lis' });
  });
</script>

<div class="wrap">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <canvas
    bind:this={canvas}
    style="cursor:{gestures.mode === 'pan' || ui.spaceDown ? 'grab' : T.cursor}"
    onpointerdown={gestures.down}
    onpointermove={gestures.move}
    onpointerup={gestures.up}
    onpointercancel={gestures.up}
    onpointerleave={gestures.leave}
    onkeydown={(e) => canvasKey(keys, e)}
    tabindex="0"
    aria-label={t('plan.aria')}
    ondblclick={() => props.tool === 'draw' && T.finish?.(host)}
    oncontextmenu={(e) => e.preventDefault()}
  ></canvas>

  <PlanToolbar {props} {ui} {actions} {vp} {matColor} pad={rulerPad} />
  {#if props.heat}<HeatLegend heat={props.heat} metric={props.heatMetric} hover={ui.heatHover} />{/if}
  <SelectionBar {props} {actions} {matColor} pad={rulerPad} />
</div>

<style>
  .wrap { position: absolute; inset: 0; }
  canvas { width: 100%; height: 100%; display: block; touch-action: none; }
  canvas:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
