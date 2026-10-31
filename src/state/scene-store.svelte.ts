// The scene being edited, with undo/redo, selection and the editing operations on walls,
// materials and sources. UI-independent apart from the Svelte runes.

import { DEFAULT_MATERIAL_ID, DEFAULT_TL, swatchFor, type Material } from '../materials';
import { matName, t, td } from '../i18n.svelte';
import { carrySources, PRESETS } from '../presets';
import { facing, wrapAngle } from '../stereo';
import { cloneGeometry, makeSource, MAX_SOURCES, parseScene, SOURCE_COLORS, type Geometry, type Pt, type Scene, type Source, type Wall } from '../scene';
import { bbox } from '../editor/geometry';
import { History } from '../editor/history';
import { EMPTY_PLAN, type Plan } from '../editor/rooms';
import { locateAt, obstacleInfo } from '../editor/obstacles';

export const STORAGE_KEY = 'art.scene.v1';

/** Where things stand: source positions and pair angles (by id), the listener and its yaw. Undoable with the geometry. */
interface Placement {
  sources: { id: string; pos: [number, number, number]; angle: number }[];
  listener: [number, number, number];
  yaw: number;
}
/** One undo step: the room and the placement in it. */
interface Snapshot {
  geom: Geometry;
  place: Placement;
}

/** A preset scene named in the current language. */
const makePreset = (i: number): Scene => {
  const sc = PRESETS[i].make();
  sc.name = td('preset', PRESETS[i].id, sc.name);
  return sc;
};

/** Preset the first scene came from (-1: restored from storage, may have been edited). */
let initialPreset = -1;

/** Index of the preset whose room this scene still is (walls, height, floor, ceiling), else -1. */
function matchingPreset(sc: Scene): number {
  const key = (x: Scene) => JSON.stringify([x.walls, x.height, x.floorMat, x.ceilMat]);
  const k = key(sc);
  return PRESETS.findIndex((p) => key(p.make()) === k);
}

function initialScene(): Scene {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const r = parseScene(JSON.parse(raw));
      if (r.scene) {
        initialPreset = matchingPreset(r.scene);
        return r.scene;
      }
    }
  } catch {
    /* storage unavailable or corrupt: fall back to the default preset */
  }
  initialPreset = 0;
  return makePreset(0);
}

export class SceneStore {
  /** Never reassigned: components may keep a reference to it. */
  readonly scene = $state<Scene>(initialScene());
  presetIdx = $state(initialPreset);
  /** Selected walls (indices into `scene.walls`). */
  selection = $state<number[]>([]);
  /** Selected source (drives the IR plot, metrics, rays and heat map). */
  selSrc = $state(0);
  drawMat = $state(DEFAULT_MATERIAL_ID);
  /** Bumped to ask the plan view to fit the scene. */
  fitToken = $state(0);

  private histVer = $state(0);
  private readonly history = new History<Snapshot>();
  private editBase: Snapshot | null = null;

  /** Room analysis of the walls, delivered by the worker (see `RoomPlan`); one round trip behind the edits. */
  plan = $state.raw<Plan>(EMPTY_PLAN);
  /** False until the first analysis arrived (no warnings before). */
  planReady = $state(false);
  /** Low obstacles (table tops, sofas, a stage) of the plan with their heights; recomputed when the walls or the plan change. */
  readonly obstacles = $derived(obstacleInfo(this.plan, this.scene.walls, this.scene.height));
  readonly canUndo = $derived(this.histVer >= 0 && this.history.canUndo);
  readonly canRedo = $derived(this.histVer >= 0 && this.history.canRedo);
  /** Wall count per material id (floor and ceiling included). */
  readonly usage = $derived.by(() => {
    const u = new Map<string, number>();
    for (const w of this.scene.walls) u.set(w.mat, (u.get(w.mat) ?? 0) + 1);
    u.set(this.scene.floorMat, (u.get(this.scene.floorMat) ?? 0) + 1);
    u.set(this.scene.ceilMat, (u.get(this.scene.ceilMat) ?? 0) + 1);
    return u;
  });
  readonly anySolo = $derived(this.scene.sources.some((x) => x.solo));

  // ---- undoable editing (geometry = walls, materials, height, floor, ceiling; placement = where sources and listener stand)

  private curGeom = (): Snapshot => {
    const s = this.scene;
    return {
      geom: cloneGeometry(s),
      place: {
        sources: s.sources.map((x) => ({ id: x.id, pos: [...x.pos] as [number, number, number], angle: x.angle })),
        listener: [...s.listener] as [number, number, number],
        yaw: s.yaw,
      },
    };
  };
  beginEdit = () => {
    if (!this.editBase) this.editBase = this.curGeom();
  };
  endEdit = () => {
    if (!this.editBase) return;
    if (JSON.stringify(this.editBase) !== JSON.stringify(this.curGeom())) {
      this.history.push(this.editBase);
      this.histVer++;
    }
    this.editBase = null;
  };
  edit(fn: () => void) {
    this.beginEdit();
    fn();
    this.endEdit();
  }
  /** Restore a snapshot: the room, and the placement of the sources that still exist (added / removed sources are not undone). */
  private applySnapshot(snap: Snapshot) {
    this.applyGeometry(snap.geom);
    const s = this.scene;
    const byId = new Map(snap.place.sources.map((x) => [x.id, x]));
    s.sources = s.sources.map((x) => {
      const p = byId.get(x.id);
      return p ? { ...x, pos: [...p.pos] as [number, number, number], angle: p.angle } : x;
    });
    s.listener = [...snap.place.listener] as [number, number, number];
    s.yaw = snap.place.yaw;
  }
  private applyGeometry(g: Geometry) {
    const s = this.scene;
    s.height = g.height;
    s.walls = g.walls;
    s.materials = g.materials;
    s.floorMat = g.floorMat;
    s.ceilMat = g.ceilMat;
    s.detail = g.detail;
  }
  undo = () => {
    this.endEdit();
    const prev = this.history.undo(this.curGeom());
    if (prev) {
      this.applySnapshot(prev);
      this.selection = [];
      this.histVer++;
    }
  };
  redo = () => {
    this.endEdit();
    const next = this.history.redo(this.curGeom());
    if (next) {
      this.applySnapshot(next);
      this.selection = [];
      this.histVer++;
    }
  };

  loadScene(s: Scene) {
    this.editBase = null;
    const t = this.scene;
    t.name = s.name;
    this.applyGeometry(s);
    t.sources = s.sources;
    t.listener = s.listener;
    t.yaw = s.yaw;
    this.history.clear();
    this.histVer++;
    this.selection = [];
    this.selSrc = 0;
    this.fitToken++;
  }
  /** A new room keeps the user's sources (signals, levels, EQ, files), placed inside it. */
  loadPreset(i: number) {
    this.presetIdx = i;
    const sc = makePreset(i);
    sc.sources = carrySources($state.snapshot(this.scene.sources), sc);
    const sel = Math.min(this.selSrc, sc.sources.length - 1);
    this.loadScene(sc);
    this.selSrc = sel;
  }

  /** Replace the walls as one undo step (shapes, paste, transforms, delete) and select `sel`. */
  commitWalls = (walls: Wall[], sel: number[]) => {
    this.edit(() => (this.scene.walls = walls));
    this.selection = sel;
  };
  clearWalls() {
    this.selection = [];
    this.edit(() => (this.scene.walls = []));
  }
  setFloor(id: string) {
    this.edit(() => (this.scene.floorMat = id));
  }
  setCeiling(id: string) {
    this.edit(() => (this.scene.ceilMat = id));
  }
  /** Slider drag: the edit is committed by `endEdit`. Sources and the listener stay below the ceiling. */
  setHeight(h: number) {
    this.beginEdit();
    const s = this.scene;
    s.height = h;
    s.sources = s.sources.map((x) => ({ ...x, pos: [x.pos[0], x.pos[1], Math.min(x.pos[2], h - 0.1)] }));
    s.listener = [s.listener[0], s.listener[1], Math.min(s.listener[2], h - 0.1)];
  }
  /** Slider drag like setHeight: begins an undoable edit, committed by endEdit. */
  setDetail(d: number) {
    this.beginEdit();
    this.scene.detail = d;
  }
  setEarHeight(z: number) {
    this.scene.listener = [this.scene.listener[0], this.scene.listener[1], z];
  }

  // ---- materials (always replaced immutably so effects see the change)

  addMaterial = (copyFrom?: string): string => {
    const s = this.scene;
    const src = s.materials.find((m) => m.id === copyFrom);
    const custom = s.materials.filter((m) => !m.builtin).length;
    const id = 'c' + Date.now().toString(36) + custom;
    const m: Material = src
      ? { ...src, alpha: [...src.alpha], s: [...src.s], tl: [...src.tl], id, name: `${matName(src)} ${t('mat.copySuffix')}`, builtin: false }
      : { id, name: t('mat.custom', { n: custom + 1 }), alpha: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2], s: new Array(6).fill(0.1), tl: new Array(6).fill(DEFAULT_TL), color: swatchFor(custom) };
    this.edit(() => (s.materials = [...s.materials, m]));
    return id;
  };
  updateMaterial = (id: string, patch: Partial<Material>) => {
    this.beginEdit(); // committed by `endEdit` (slider release / text change)
    this.scene.materials = this.scene.materials.map((m) => (m.id === id && !m.builtin ? { ...m, ...patch } : m));
  };
  deleteMaterial = (id: string) => {
    const s = this.scene;
    const m = s.materials.find((x) => x.id === id);
    if (!m || m.builtin) return;
    this.edit(() => {
      s.walls = s.walls.map((w) => (w.mat === id ? { ...w, mat: DEFAULT_MATERIAL_ID } : w));
      if (s.floorMat === id) s.floorMat = DEFAULT_MATERIAL_ID;
      if (s.ceilMat === id) s.ceilMat = DEFAULT_MATERIAL_ID;
      if (this.drawMat === id) this.drawMat = DEFAULT_MATERIAL_ID;
      s.materials = s.materials.filter((x) => x.id !== id);
    });
  };

  // ---- sources (up to MAX_SOURCES)

  updateSource = (i: number, patch: Partial<Source>) => {
    this.scene.sources = this.scene.sources.map((s, k) => (k === i ? { ...s, ...patch } : s));
  };
  moveSource = (i: number, p: Pt) => {
    const s = this.scene.sources[i];
    if (s) this.updateSource(i, { pos: [p[0], p[1], s.pos[2]] });
  };
  addSource = () => {
    const s = this.scene;
    if (s.sources.length >= MAX_SOURCES) return;
    const used = new Set(s.sources.map((x) => x.id));
    const b = bbox(s.walls);
    const first = s.sources[0].pos;
    const cands: Pt[] = [[first[0] + 1.2, first[1] + 1], [first[0] - 1.2, first[1] - 1], b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0]];
    const p = cands.find((c) => !b || locateAt(this.plan, this.obstacles, c, first[2]) === 'room') ?? cands[2];
    const idx = SOURCE_COLORS.findIndex((c) => !s.sources.some((x) => x.color === c));
    const src = makeSource(idx < 0 ? s.sources.length : idx, [p[0], p[1], first[2]], used);
    s.sources = [...s.sources, { ...src, angle: wrapAngle(facing(src.pos, s.listener)) }];
    this.selSrc = s.sources.length - 1;
  };
  /** Removes source `i` (never the last one); returns its id, or null. */
  removeSource = (i: number): string | null => {
    const s = this.scene;
    if (s.sources.length <= 1) return null;
    const id = s.sources[i].id;
    s.sources = s.sources.filter((_, k) => k !== i);
    this.selSrc = Math.min(this.selSrc, s.sources.length - 1);
    return id;
  };
  /** Effective linear gain of a source: mute and solo applied. */
  effGain = (s: Source) => (s.muted ? 0 : this.anySolo ? (s.solo ? s.gain : 0) : s.gain);
}
