// Wall clipboard: module state (always available) plus a best-effort copy to the system clipboard.
import { TO_CEILING, wallZ, type Pt, type Wall } from '../scene';
import { bboxCenter, cloneWalls, selectionBBox } from './transform';

const CLIP_FORMAT = 'acoustic-ray-tracing/walls';
const PASTE_OFFSET = 0.5;

let clip: Wall[] = [];
let pasteCount = 0;

export const hasClip = () => clip.length > 0;

/** Remember the selected walls (deep copy). Returns how many were copied. */
export function copyWalls(walls: Wall[], ids: number[]): number {
  clip = cloneWalls(ids.filter((i) => walls[i]).map((i) => walls[i]));
  pasteCount = 0;
  return clip.length;
}

export function serializeClip(walls: Wall[] = clip): string {
  return JSON.stringify({ format: CLIP_FORMAT, walls: walls.map((w) => [w.a[0], w.a[1], w.b[0], w.b[1], w.mat, ...(w.z0 !== undefined || w.z1 !== undefined ? [w.z0 ?? 0, w.z1 ?? TO_CEILING] : [])]) });
}

/** Parse text from the system clipboard; null if it is not our JSON. */
export function parseClip(text: string): Wall[] | null {
  try {
    const o = JSON.parse(text);
    if (o?.format !== CLIP_FORMAT || !Array.isArray(o.walls) || o.walls.length < 1 || o.walls.length > 2000) return null;
    const out: Wall[] = [];
    for (const w of o.walls) {
      if (!Array.isArray(w) || (w.length !== 5 && w.length !== 7) || !w.slice(0, 4).every((v: unknown) => typeof v === 'number' && Number.isFinite(v)) || typeof w[4] !== 'string') return null;
      const wall: Wall = { a: [w[0], w[1]], b: [w[2], w[3]], mat: w[4] };
      if (w.length === 7) {
        if (typeof w[5] !== 'number' || typeof w[6] !== 'number' || !(w[5] >= 0 && w[5] < w[6])) return null;
        if (w[5] > 0) wall.z0 = w[5];
        if (w[6] < TO_CEILING) wall.z1 = w[6];
      }
      out.push(wall);
    }
    return out;
  } catch {
    return null;
  }
}

/** Best-effort write to the system clipboard; never required, never throws. */
export async function writeSystemClip(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    /* permission denied or unsupported: the internal clipboard still works */
  }
}

export async function readSystemClip(): Promise<Wall[] | null> {
  try {
    const t = await navigator.clipboard?.readText();
    return t ? parseClip(t) : null;
  } catch {
    return null;
  }
}

/**
 * Copies of `src` with their bounding-box centre at `center`, or (no cursor) shifted by
 * PASTE_OFFSET * n. Materials unknown to the target scene are replaced by `fallbackMat`.
 */
export function placeWalls(src: Wall[], center: Pt | null, offset: number, known: Set<string>, fallbackMat: string): Wall[] {
  const b = selectionBBox(src, src.map((_, i) => i));
  if (!b) return [];
  const c = bboxCenter(b);
  const [dx, dy] = center ? [center[0] - c[0], center[1] - c[1]] : [offset, offset];
  return src.map((w): Wall => ({ a: [w.a[0] + dx, w.a[1] + dy], b: [w.b[0] + dx, w.b[1] + dy], mat: known.has(w.mat) ? w.mat : fallbackMat, ...wallZ(w) }));
}

/** Append the pasted walls; returns the new wall list and the indices of the pasted walls. */
export function pasteInto(target: Wall[], src: Wall[], center: Pt | null, known: Set<string>, fallbackMat: string, offsetCount = 1): { walls: Wall[]; sel: number[] } {
  const add = placeWalls(src, center, PASTE_OFFSET * offsetCount, known, fallbackMat);
  const walls = [...cloneWalls(target), ...add];
  return { walls, sel: add.map((_, i) => target.length + i) };
}

/** Paste the internal clipboard (successive pastes without a cursor stack up diagonally). */
export function pasteClip(target: Wall[], center: Pt | null, known: Set<string>, fallbackMat: string, from: Wall[] = clip) {
  pasteCount++;
  return pasteInto(target, from, center, known, fallbackMat, pasteCount);
}

/** Duplicate the selection in place, offset by PASTE_OFFSET, without touching the clipboard. */
export function duplicateWalls(walls: Wall[], ids: number[]): { walls: Wall[]; sel: number[] } {
  return pasteInto(walls, ids.filter((i) => walls[i]).map((i) => walls[i]), null, new Set(walls.map((w) => w.mat)), walls[ids[0]]?.mat ?? '');
}
