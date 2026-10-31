import { hasClip } from '../clipboard';
import { STAMPS } from '../shapes';
import type { ShapeParams } from '../tools/types';
import type { Pt } from '../../scene';

/** View-local UI state of the plan editor, shared by the canvas, the toolbar and the keyboard routing. */
export class PlanUi {
  /** Bumped by the tools when their private state changed (forces a redraw). */
  tick = $state(0);
  cursorW = $state<Pt | null>(null);
  showHelp = $state(false);
  showRuler = $state(true);
  shiftLock = $state(false);
  /** Non-zero when the in-app clipboard holds walls (enables Paste). */
  clipN = $state(hasClip() ? 1 : 0);
  matMenu = $state(false);
  spaceDown = $state(false);
  params = $state<ShapeParams>({ sides: 6, circleSegs: 0, arcSegs: 0, stamp: STAMPS[0].id });
  /** Heat value under the cursor. */
  heatHover = $state('');
}
