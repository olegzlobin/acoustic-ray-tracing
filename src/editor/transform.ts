// Group transforms of a wall selection. Only the selected walls change; endpoints they shared with
// non-selected walls are therefore detached, while joints inside the group stay joined (every
// endpoint goes through the same deterministic function of its coordinates).
import { cloneWall, normalizeWallZ, wallRange, wallZ, type Pt, type Wall } from '../scene';

export const cloneWalls = (walls: Wall[]): Wall[] => walls.map(cloneWall);

/** Bounding box [x0, y0, x1, y1] of the selected walls, or null. */
export function selectionBBox(walls: Wall[], ids: number[]): [number, number, number, number] | null {
  let b: [number, number, number, number] | null = null;
  for (const i of ids) {
    const w = walls[i];
    if (!w) continue;
    for (const p of [w.a, w.b]) b = b ? [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])] : [p[0], p[1], p[0], p[1]];
  }
  return b;
}

export const bboxCenter = (b: [number, number, number, number]): Pt => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

function mapSelected(walls: Wall[], ids: number[], f: (p: Pt) => Pt): Wall[] {
  const set = new Set(ids);
  return walls.map((w, i): Wall => (set.has(i) ? { a: f(w.a), b: f(w.b), mat: w.mat, ...wallZ(w) } : cloneWall(w)));
}

export const translateWalls = (walls: Wall[], ids: number[], dx: number, dy: number): Wall[] => mapSelected(walls, ids, (p) => [p[0] + dx, p[1] + dy]);

/** Rotate counter-clockwise by `deg` about `c` (exact for multiples of 90 degrees). */
export function rotateWalls(walls: Wall[], ids: number[], deg: number, c: Pt): Wall[] {
  const r = (((deg % 360) + 360) % 360);
  const quarter = r % 90 === 0;
  const rad = (deg * Math.PI) / 180;
  const cos = quarter ? [1, 0, -1, 0][r / 90] : Math.cos(rad);
  const sin = quarter ? [0, 1, 0, -1][r / 90] : Math.sin(rad);
  return mapSelected(walls, ids, (p) => {
    const x = p[0] - c[0];
    const y = p[1] - c[1];
    return [c[0] + x * cos - y * sin, c[1] + x * sin + y * cos];
  });
}

/** 'h' mirrors left-right (x -> 2cx - x), 'v' mirrors top-bottom, about `c`. */
export function flipWalls(walls: Wall[], ids: number[], axis: 'h' | 'v', c: Pt): Wall[] {
  return mapSelected(walls, ids, (p) => (axis === 'h' ? [2 * c[0] - p[0], p[1]] : [p[0], 2 * c[1] - p[1]]));
}

export const removeWalls = (walls: Wall[], ids: number[]): Wall[] => {
  const set = new Set(ids);
  return cloneWalls(walls).filter((_, i) => !set.has(i));
};

export const setMaterial = (walls: Wall[], ids: number[], mat: string): Wall[] => {
  const set = new Set(ids);
  return walls.map((w, i): Wall => ({ ...cloneWall(w), mat: set.has(i) ? mat : w.mat }));
};

/** Default top of a wall that stops being full height (a low cabinet / sofa). */
export const DEFAULT_LOW_TOP = 0.8;

/**
 * Height of the selected walls with `z0` / `z1` (metres; undefined keeps each wall's own value), or null when some
 * wall would not satisfy 0 <= z0 < z1 <= room height. Full values are stored as "unset" (floor / ceiling).
 */
export const setHeight = (walls: Wall[], ids: number[], z0: number | undefined, z1: number | undefined, h: number): Wall[] | null => {
  const set = new Set(ids);
  const out: Wall[] = [];
  for (const [i, w] of walls.entries()) {
    if (!set.has(i)) {
      out.push(cloneWall(w));
      continue;
    }
    const [a, b] = wallRange(w, h);
    const [lo, hi] = [z0 ?? a, z1 ?? b];
    if (!(lo >= 0 && lo < hi - 1e-6 && hi <= h + 1e-9)) return null;
    out.push(normalizeWallZ({ ...cloneWall(w), z0: lo, z1: hi }, h));
  }
  return out;
};

/** The selected walls span floor to ceiling again. */
export const setFullHeight = (walls: Wall[], ids: number[]): Wall[] => {
  const set = new Set(ids);
  return walls.map((w, i): Wall => (set.has(i) ? { a: [...w.a] as Pt, b: [...w.b] as Pt, mat: w.mat } : cloneWall(w)));
};

export const totalLength = (walls: Wall[], ids: number[]): number => ids.reduce((s, i) => (walls[i] ? s + Math.hypot(walls[i].b[0] - walls[i].a[0], walls[i].b[1] - walls[i].a[1]) : s), 0);
