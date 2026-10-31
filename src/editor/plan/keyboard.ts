import type { Pt } from '../../scene';
import type { Tool, ToolHost, PointerInfo } from '../tools/types';
import type { SelectionActions } from './actions';
import { drawing, isShape, type PlanProps, type ToolId } from './types';
import type { PlanUi } from './ui.svelte';

export const TOOL_KEYS: Record<string, ToolId> = { v: 'select', w: 'draw', m: 'measure', b: 'rect', p: 'polygon', c: 'circle', e: 'ellipse', a: 'arc', t: 'stamp' };

/** Keys typed into a text field must not trigger editor shortcuts. */
export function typing(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range' && (el as HTMLInputElement).type !== 'checkbox' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}
const hasTextSelection = () => !!window.getSelection()?.toString();

/** What the keyboard router needs from the canvas besides the props. */
export interface KeyContext {
  props: PlanProps;
  ui: PlanUi;
  actions: SelectionActions;
  tool(): Tool;
  host: ToolHost;
  /** Last hover info while no gesture runs (to refresh the preview when Shift changes). */
  hoverInfo(): PointerInfo | null;
}

/** Arrow keys on the focused canvas nudge the selected walls (or, with nothing selected, the selected source; Alt: the listener); [ ] rotate the head. */
export function canvasKey(c: KeyContext, e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey) return;
  const { props } = c;
  const { scene, selection, selectedSource, tool } = props;
  const nudge = e.shiftKey ? 0.5 : 0.05;
  const step = e.shiftKey ? props.gridStep * 4 : props.gridStep;
  const arrow = (k: number): Pt | null => (e.key === 'ArrowLeft' ? [-k, 0] : e.key === 'ArrowRight' ? [k, 0] : e.key === 'ArrowUp' ? [0, k] : e.key === 'ArrowDown' ? [0, -k] : null);
  if (arrow(1)) {
    e.preventDefault();
    if (e.altKey) {
      const d = arrow(step)!;
      props.onbeginedit(); // each nudge is one undo step
      props.onlistener([scene.listener[0] + d[0], scene.listener[1] + d[1]]);
      props.onendedit();
      props.onrelease?.();
    } else if (selection.length) {
      const d = arrow(nudge)!;
      props.oncommit(c.actions.translate(d), selection);
    } else {
      const d = arrow(step)!;
      const s = scene.sources[selectedSource];
      props.onbeginedit(); // each nudge is one undo step
      if (s) props.onsource(selectedSource, [s.pos[0] + d[0], s.pos[1] + d[1]]);
      props.onendedit();
      props.onrelease?.();
    }
  } else if ((e.key === '[' || e.key === ']') && !isShape(tool)) {
    props.onbeginedit(); // each nudge is one undo step
    props.onyaw(scene.yaw + (e.key === '[' ? 1 : -1) * (Math.PI / 24));
    props.onendedit();
    props.onrelease?.();
  }
}

/** Re-run the hover preview when Shift / the lock changes without the pointer moving. */
function refreshHover(c: KeyContext, shift: boolean, gestureIdle: boolean) {
  const info = c.hoverInfo();
  if (info && gestureIdle) c.tool().move(c.host, { ...info, mods: { ...info.mods, shift: shift || c.ui.shiftLock } });
}

/** Global shortcuts (window keydown). `gestureIdle`: no pointer gesture is running. */
export function globalKeydown(c: KeyContext, e: KeyboardEvent, gestureIdle: boolean) {
  if (typing(e.target)) return;
  const { props, ui, actions } = c;
  const T = c.tool();
  if (e.key === 'Shift') refreshHover(c, true, gestureIdle);
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'a') actions.selectAll();
    else if (k === 'c' && !hasTextSelection()) actions.copySelection();
    else if (k === 'x' && !hasTextSelection()) actions.cutSelection();
    else if (k === 'v') actions.pasteClipboard();
    else if (k === 'd') actions.duplicateSelection();
    else return;
    e.preventDefault();
    return;
  }
  if (e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.key === ' ') {
    ui.spaceDown = true;
    e.preventDefault();
  } else if (TOOL_KEYS[k]) props.ontool(TOOL_KEYS[k]);
  else if (k === 'g') props.ongrid(!props.grid);
  else if (k === 'r') ui.showRuler = !ui.showRuler;
  else if (e.key >= '1' && e.key <= '9' && drawing(props.tool)) {
    const m = props.scene.materials[+e.key - 1];
    if (m) props.ondrawmat(m.id);
  } else if (e.key === '[' || e.key === ']') {
    if (actions.stepParam(e.key === ']' ? 1 : -1)) e.preventDefault();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (props.selection.length) {
      actions.deleteSelection();
      e.preventDefault();
    } else if (!T.active() && props.scene.sources.length > 1) {
      // nothing selected on the plan: like the arrow keys, act on the selected source
      props.onremovesource(props.selectedSource);
      e.preventDefault();
    }
  } else if (e.key === 'Enter') T.finish?.(c.host);
  else if (e.key === 'Escape') {
    if (ui.matMenu) ui.matMenu = false;
    else if (T.active()) T.cancel(c.host);
    else if (props.selection.length) props.onselection([]);
  }
}

export function globalKeyup(c: KeyContext, e: KeyboardEvent, gestureIdle: boolean) {
  if (e.key === ' ') c.ui.spaceDown = false;
  if (e.key === 'Shift') refreshHover(c, false, gestureIdle);
}
