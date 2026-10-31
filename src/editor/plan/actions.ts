import { copyWalls, duplicateWalls, hasClip, pasteClip, readSystemClip, serializeClip, writeSystemClip } from '../clipboard';
import { allIndices } from '../selection';
import { MAX_CIRCLE_SEGS, MAX_SIDES, MIN_SIDES } from '../shapes';
import { bboxCenter, DEFAULT_LOW_TOP, flipWalls, removeWalls, rotateWalls, selectionBBox, setFullHeight, setHeight, setMaterial } from '../transform';
import { wallZ, type Pt, type Wall } from '../../scene';
import type { PlanProps } from './types';
import type { PlanUi } from './ui.svelte';

export const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v) || lo));

/** Selection and clipboard commands of the plan editor (each is one undo step). */
export class SelectionActions {
  constructor(private props: PlanProps, private ui: PlanUi) {}

  private knownMats = () => new Set(this.props.scene.materials.map((m) => m.id));

  deleteSelection = () => {
    const { scene, selection, oncommit } = this.props;
    if (!selection.length) return;
    oncommit(removeWalls(scene.walls, selection), []);
  };
  copySelection = (): boolean => {
    const { scene, selection } = this.props;
    if (!selection.length) return false;
    copyWalls(scene.walls, selection);
    this.ui.clipN = selection.length;
    void writeSystemClip(serializeClip());
    return true;
  };
  cutSelection = () => {
    if (this.copySelection()) this.deleteSelection();
  };
  /** Commit pasted / duplicated walls; they are selected and can be dragged straight away. */
  pasted = (r: { walls: Wall[]; sel: number[] }) => {
    this.props.oncommit(r.walls, r.sel);
    this.props.ontool('select');
  };
  /** Paste centred on the cursor, or offset by 0.5 m when the cursor is not over the plan. */
  pasteClipboard = () => {
    const { scene, drawMat } = this.props;
    if (hasClip()) this.pasted(pasteClip(scene.walls, this.ui.cursorW, this.knownMats(), drawMat));
    else
      void readSystemClip().then((w) => {
        if (w) this.pasted(pasteClip(scene.walls, this.ui.cursorW, this.knownMats(), drawMat, w));
      });
  };
  /** Paste walls parsed from a clipboard event (text of another tab). */
  pasteWalls = (w: Parameters<typeof pasteClip>[4]) => this.pasted(pasteClip(this.props.scene.walls, this.ui.cursorW, this.knownMats(), this.props.drawMat, w));
  duplicateSelection = () => {
    const { scene, selection } = this.props;
    if (selection.length) this.pasted(duplicateWalls(scene.walls, selection));
  };
  selectAll = () => this.props.onselection(allIndices(this.props.scene.walls));

  private transform(f: (c: Pt) => Wall[]) {
    const { scene, selection, oncommit } = this.props;
    const b = selectionBBox(scene.walls, selection);
    if (b) oncommit(f(bboxCenter(b)), selection);
  }
  rotateSelection = (deg: number) => this.transform((c) => rotateWalls(this.props.scene.walls, this.props.selection, deg, c));
  flipSelection = (axis: 'h' | 'v') => this.transform((c) => flipWalls(this.props.scene.walls, this.props.selection, axis, c));
  setSelectionMat = (id: string) => this.props.oncommit(setMaterial(this.props.scene.walls, this.props.selection, id), this.props.selection);

  /** Full height (floor to ceiling) for all selected walls, or a low default (0 to 0.8 m) when `full` is false. One undo step. */
  setSelectionFull = (full: boolean) => {
    const { scene, selection, oncommit } = this.props;
    if (!selection.length) return;
    const walls = full ? setFullHeight(scene.walls, selection) : setHeight(scene.walls, selection, 0, Math.min(DEFAULT_LOW_TOP, scene.height * 0.5), scene.height);
    if (walls) oncommit(walls, selection);
  };
  /** Bottom and / or top of the selected walls in metres (undefined keeps each wall's own); false when invalid (nothing changes). */
  setSelectionHeight = (z0: number | undefined, z1: number | undefined): boolean => {
    const { scene, selection, oncommit } = this.props;
    if (!selection.length) return false;
    const walls = setHeight(scene.walls, selection, z0, z1, scene.height);
    if (walls) oncommit(walls, selection);
    return walls !== null;
  };

  translate(d: Pt): Wall[] {
    const set = new Set(this.props.selection);
    return this.props.scene.walls.map((w, i): Wall => (set.has(i) ? { a: [w.a[0] + d[0], w.a[1] + d[1]], b: [w.b[0] + d[0], w.b[1] + d[1]], mat: w.mat, ...wallZ(w) } : w));
  }

  /** Step a shape parameter with [ and ] (sides for polygons, segments for circles/ellipses/arcs). */
  stepParam(dir: number): boolean {
    const { tool } = this.props;
    const params = this.ui.params;
    if (tool === 'polygon') params.sides = clampInt(params.sides + dir, MIN_SIDES, MAX_SIDES);
    else if (tool === 'circle' || tool === 'ellipse') {
      const n = params.circleSegs + dir * 4;
      params.circleSegs = n < 12 ? (dir < 0 ? 0 : 16) : Math.min(MAX_CIRCLE_SEGS, n);
    } else if (tool === 'arc') {
      const n = params.arcSegs + dir * 2;
      params.arcSegs = n < 2 ? (dir < 0 ? 0 : 8) : Math.min(MAX_CIRCLE_SEGS, n);
    } else return false;
    this.ui.tick++;
    return true;
  }
}
