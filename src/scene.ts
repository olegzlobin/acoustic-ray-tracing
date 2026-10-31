// Scene model. WORLD COORDINATES: x right, y UP on the plan (canvas flips y when drawing), z up,
// metres. Angles (yaw) are counter-clockwise seen from above, 0 = facing +x.
// This matches the Rust core (see core/src/ism.rs): Ambisonic X(front)=+x, Y(left)=+y, Z=+z.

import { MATERIAL_STRIDE, WALL_STRIDE } from './layout';
import { EQ_BANDS, EQ_MAX_DB, EQ_MIN_DB, FLAT_EQ, type Eq } from './audio/eq';
import { DIRECTIVITIES, type Directivity } from './directivity';
import { BUILTIN_MATERIALS, DEFAULT_MATERIAL_ID, DEFAULT_TL, builtinById, cloneMaterial, type Material } from './materials';

export type Pt = [number, number];
export type P3 = [number, number, number];

export interface Wall {
  a: Pt;
  b: Pt;
  /** Material id (into `materials`). */
  mat: string;
  /** Vertical extent in metres above the floor: `z0` undefined = the floor, `z1` undefined = the ceiling. */
  z0?: number;
  z1?: number;
}

/** Tolerance (m) of the "spans the whole room height" test. */
const Z_EPS = 1e-6;
/** `z1` sent to the core for "up to the ceiling" (the core clamps it to the room height). */
export const TO_CEILING = 1e9;

/** The wall's own `z0` / `z1` fields (only the ones that are set), for rebuilding a wall without losing its height. */
export const wallZ = (w: Wall): Pick<Wall, 'z0' | 'z1'> => ({ ...(w.z0 !== undefined ? { z0: w.z0 } : {}), ...(w.z1 !== undefined ? { z1: w.z1 } : {}) });

/** Deep copy of a wall (endpoints, material and height). */
export const cloneWall = (w: Wall): Wall => ({ a: [...w.a] as Pt, b: [...w.b] as Pt, mat: w.mat, ...wallZ(w) });

/** Bottom and top of a wall in a room of height `h` (clamped to [0, h]). */
export const wallRange = (w: Wall, h: number): [number, number] => {
  const z1 = Math.min(w.z1 ?? h, h);
  return [Math.min(Math.max(w.z0 ?? 0, 0), z1), z1];
};

/** The wall does not span the whole room height (it is an obstacle part, not a full wall). */
export const isPartialWall = (w: Wall, h: number): boolean => {
  const [z0, z1] = wallRange(w, h);
  return z0 > Z_EPS || z1 < h - Z_EPS;
};

/** The wall with its height clamped to the room and the defaults (floor / ceiling) left unset. */
export const normalizeWallZ = (w: Wall, h: number): Wall => {
  const [z0, z1] = wallRange(w, h);
  const { z0: _z0, z1: _z1, ...rest } = w;
  return { ...rest, ...(z0 > Z_EPS ? { z0 } : {}), ...(z1 < h - Z_EPS ? { z1 } : {}) };
};

/** The undoable part of a scene. */
export interface Geometry {
  height: number;
  walls: Wall[];
  materials: Material[];
  floorMat: string;
  ceilMat: string;
  /**
   * Extra absorption of every surface for the small details real surfaces have (joints, trim,
   * fixtures, openings): alpha' = 1 - (1 - alpha)(1 - detail), applied when packing for the core.
   */
  detail: number;
}

/** Default surface detail: real rooms absorb more than the smooth library surfaces alone. */
export const DEFAULT_DETAIL = 0.05;
export const MAX_DETAIL = 0.3;
/** Absorption with the surface detail added (never above 1). */
export const withDetail = (alpha: number, detail: number) => 1 - (1 - alpha) * (1 - detail);

export type SignalKind = 'guitar' | 'marimba' | 'drums' | 'clap' | 'noise' | 'file' | 'mic';
const SIGNAL_KINDS: SignalKind[] = ['guitar', 'marimba', 'drums', 'clap', 'noise', 'file', 'mic'];
export const MAX_SOURCES = 4;
export const SOURCE_COLORS = ['#E15151', '#E8BF3A', '#0A9BA6', '#5882EF'];
/** Stereo base (m) between the two speakers of a stereo pair. */
export const DEFAULT_WIDTH = 2;
export const MIN_WIDTH = 0.5;
export const MAX_WIDTH = 6;

/** A sound source. Audio files and the microphone are not stored in the scene (only the kind). */
export interface Source {
  id: string;
  name: string;
  pos: P3;
  color: string;
  /** Linear gain 0..2. */
  gain: number;
  muted: boolean;
  solo: boolean;
  signal: SignalKind;
  /** Per-band gain in dB (flat = all 0). Applied to the source signal before the dry/wet split. */
  eq: Eq;
  /** A stereo file plays as a pair of speakers (true) or is summed to mono (false). Mono files and generated signals ignore it. */
  stereo: boolean;
  /** Distance between the two speakers of a pair, metres. */
  width: number;
  /** Direction a stereo pair faces, radians CCW from +x (L / R placement, see stereo.ts). */
  /** Facing direction, radians CCW from +x: a stereo pair's orientation, or where a directional mono source points. */
  angle: number;
  /** Radiation pattern around `angle` (see directivity.ts). */
  directivity: Directivity;
}

export function makeSource(index: number, pos: P3, used: Set<string> = new Set()): Source {
  let n = index + 1;
  while (used.has('s' + n)) n++;
  return { id: 's' + n, name: `Source ${n}`, pos, color: SOURCE_COLORS[index % SOURCE_COLORS.length], gain: 1, muted: false, solo: false, signal: index === 1 ? 'drums' : index === 0 ? 'guitar' : 'marimba', eq: { ...FLAT_EQ }, stereo: true, width: DEFAULT_WIDTH, angle: 0, directivity: 'speaker' };
}

export interface Scene extends Geometry {
  name: string;
  sources: Source[];
  listener: P3;
  /** Listener yaw, radians CCW from +x. */
  yaw: number;
}

const FORMAT = 'acoustic-ray-tracing';
const VERSION = 3;

export const cloneGeometry = (g: Geometry): Geometry => ({
  height: g.height,
  walls: g.walls.map(cloneWall),
  materials: g.materials.map(cloneMaterial),
  floorMat: g.floorMat,
  ceilMat: g.ceilMat,
  detail: g.detail,
});

export const geometryEqual = (a: Geometry, b: Geometry) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- worker packing

export interface WorkerScene {
  height: number;
  walls: Float32Array; // [x1,y1,x2,y2,materialIndex,z0,z1] rows
  materials: Float32Array; // [a x6, s x6, TL x6] rows
  floorMat: number;
  ceilMat: number;
  /** false: the core treats every wall as opaque (A/B comparison). */
  transmission: boolean;
}

/** One packed wall row: [x1, y1, x2, y2, material index, z0, z1]. */
const wallRow = (w: Wall, mat: number) => [w.a[0], w.a[1], w.b[0], w.b[1], mat, w.z0 ?? 0, w.z1 ?? TO_CEILING];

/** Wall geometry only (material column 0), for the room analysis (which ignores the heights). */
export function packWalls(walls: Wall[]): Float32Array {
  const out = new Float32Array(walls.length * WALL_STRIDE);
  walls.forEach((w, i) => out.set(wallRow(w, 0), i * WALL_STRIDE));
  return out;
}

/** Pack for the Rust core. Unknown material ids fall back to index 0. */
export function toWorkerScene(g: Geometry, transmission = true): WorkerScene {
  const index = new Map(g.materials.map((m, i) => [m.id, i]));
  const idx = (id: string) => index.get(id) ?? 0;
  const walls = new Float32Array(g.walls.length * WALL_STRIDE);
  g.walls.forEach((w, i) => walls.set(wallRow(w, idx(w.mat)), i * WALL_STRIDE));
  const materials = new Float32Array(g.materials.length * MATERIAL_STRIDE);
  g.materials.forEach((m, i) => materials.set([...m.alpha.map((a) => withDetail(a, g.detail)), ...m.s, ...m.tl], i * MATERIAL_STRIDE));
  return { height: g.height, walls, materials, floorMat: idx(g.floorMat), ceilMat: idx(g.ceilMat), transmission };
}

// ---------------------------------------------------------------- serialization

const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** EQ gains are stored to 0.5 dB, like the slider step. */
const r05 = (v: number) => Math.round(v * 2) / 2;
const eqOut = (eq: Eq): Eq => ({ low: r05(eq.low), lowMid: r05(eq.lowMid), highMid: r05(eq.highMid), high: r05(eq.high) });

/** Stereo fields; share links omit the defaults. */
const stereoOut = (x: Source, compact: boolean): { stereo?: boolean; width?: number; angle?: number } =>
  compact && x.stereo && r3(x.width) === DEFAULT_WIDTH && r3(x.angle) === 0
    ? {}
    : { stereo: x.stereo, width: compact ? r3(x.width) : x.width, angle: compact ? r3(x.angle) : x.angle };

/** Directivity; share links omit the default (omni, which a missing field means). */
const directivityOut = (x: Source, compact: boolean): { directivity?: Directivity } => (compact && x.directivity === 'omni' ? {} : { directivity: x.directivity });

interface SerializedScene {
  format: string;
  version: number;
  name: string;
  height: number;
  /** [x1, y1, x2, y2, material] or, for a wall that does not span the room height, [x1, y1, x2, y2, material, z0, z1]. */
  walls: ([number, number, number, number, string] | [number, number, number, number, string, number, number])[];
  materials: { id: string; name: string; alpha: number[]; s: number | number[]; tl: number[]; color: string }[];
  floor: string;
  ceiling: string;
  detail: number;
  sources: { id: string; name: string; pos: P3; color: string; gain: number; muted: boolean; solo: boolean; signal: SignalKind; eq: Eq; stereo?: boolean; width?: number; angle?: number; directivity?: Directivity }[];
  listener: P3;
  yaw: number;
}

/**
 * Plain-object form of a scene. `compact` rounds to 1 mm and omits library materials (resolved by
 * id when loading) so share links stay short; files use the full self-contained form.
 */
export function serializeScene(s: Scene, compact = false): SerializedScene {
  const used = new Set([...s.walls.map((w) => w.mat), s.floorMat, s.ceilMat]);
  const mats = s.materials.filter((m) => (compact ? !m.builtin && !builtinById(m.id) : used.has(m.id)));
  const q = compact ? r3 : (v: number) => v;
  return {
    format: FORMAT,
    version: VERSION,
    name: s.name,
    height: q(s.height),
    walls: s.walls.map((w) => {
      const row: [number, number, number, number, string] = [q(w.a[0]), q(w.a[1]), q(w.b[0]), q(w.b[1]), w.mat];
      if (!isPartialWall(w, s.height)) return row;
      const [z0, z1] = wallRange(w, s.height);
      return [...row, q(z0), q(z1)];
    }),
    materials: mats.map((m) => ({ id: m.id, name: m.name, alpha: [...m.alpha], s: m.s.every((x) => x === m.s[0]) ? m.s[0] : [...m.s], tl: [...m.tl], color: m.color })),
    floor: s.floorMat,
    ceiling: s.ceilMat,
    detail: r3(s.detail),
    sources: s.sources.map((x) => ({ id: x.id, name: x.name, pos: x.pos.map(q) as P3, color: x.color, gain: x.gain, muted: x.muted, solo: x.solo, signal: x.signal, eq: eqOut(x.eq), ...stereoOut(x, compact), ...directivityOut(x, compact) })),
    listener: s.listener.map(q) as P3,
    yaw: q(s.yaw),
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 80;

interface ParseResult {
  scene: Scene | null;
  errors: string[];
}

/** Validate untrusted JSON and build a Scene. Library materials are resolved by id. */
export function parseScene(raw: unknown): ParseResult {
  const errors: string[] = [];
  const err = (m: string) => errors.push(m);
  if (typeof raw !== 'object' || raw === null) return { scene: null, errors: ['Not a JSON object'] };
  const o = raw as Record<string, unknown>;
  if (o.format !== FORMAT) err(`Unknown format (expected "${FORMAT}")`);
  // Version 1 had a single `source` (migrated to `sources[0]`); versions 1 and 2 have no transmission
  // loss `tl` (migrated: library materials by id, custom ones get DEFAULT_TL dB flat).
  if (o.version !== VERSION && o.version !== 2 && o.version !== 1) err(`Unsupported version ${String(o.version)} (expected 1, 2 or ${VERSION})`);
  const height = o.height;
  if (!isNum(height) || height < 0.5 || height > 100) err('height must be a number between 0.5 and 100 m');

  const materials: Material[] = [];
  if (o.materials !== undefined) {
    if (!Array.isArray(o.materials)) err('materials must be an array');
    else
      o.materials.forEach((mm: unknown, i: number) => {
        const m = mm as Record<string, unknown>;
        if (typeof m !== 'object' || m === null || !isStr(m.id) || !isStr(m.name)) return err(`materials[${i}]: needs id and name`);
        const alpha = m.alpha;
        if (!Array.isArray(alpha) || alpha.length !== 6 || !alpha.every((a) => isNum(a) && a > 0 && a <= 1))
          return err(`materials[${i}]: alpha must be 6 numbers in (0, 1]`);
        // `s`: one number in [0, 1] (older files and links: every band) or 6 per-band numbers
        let s: number[];
        if (isNum(m.s) && m.s >= 0 && m.s <= 1) s = new Array(6).fill(m.s);
        else if (Array.isArray(m.s) && m.s.length === 6 && m.s.every((x) => isNum(x) && x >= 0 && x <= 1)) s = [...(m.s as number[])];
        else return err(`materials[${i}]: s must be a number or 6 numbers in [0, 1]`);
        if (materials.some((x) => x.id === m.id)) return err(`materials[${i}]: duplicate id "${m.id}"`);
        let tl: number[];
        if (m.tl === undefined) tl = builtinById(m.id)?.tl.slice() ?? new Array(6).fill(DEFAULT_TL);
        else if (Array.isArray(m.tl) && m.tl.length === 6 && m.tl.every((t) => isNum(t) && t >= 0 && t <= 120)) tl = [...(m.tl as number[])];
        else return err(`materials[${i}]: tl must be 6 numbers in [0, 120] dB`);
        // library ids stay library materials (read-only, localized names) even when the file carries their values
        materials.push({ id: m.id, name: m.name, alpha: [...(alpha as number[])], s, tl, color: isStr(m.color) ? m.color : '#aaaaaa', ...(builtinById(m.id) ? { builtin: true } : {}) });
      });
  }
  // Library materials not overridden by the file.
  for (const b of BUILTIN_MATERIALS) if (!materials.some((x) => x.id === b.id)) materials.push(cloneMaterial(b));
  const known = new Set(materials.map((m) => m.id));

  const walls: Wall[] = [];
  if (!Array.isArray(o.walls) || o.walls.length < 1) err('walls must be a non-empty array');
  else if (o.walls.length > 2000) err('too many walls (max 2000)');
  else
    o.walls.forEach((w: unknown, i: number) => {
      // [x1, y1, x2, y2, materialId] or, with a vertical extent, [x1, y1, x2, y2, materialId, z0, z1].
      if (!Array.isArray(w) || (w.length !== 5 && w.length !== 7) || !w.slice(0, 4).every((v) => isNum(v) && Math.abs(v) <= 1000) || !isStr(w[4]))
        return err(`walls[${i}] must be [x1, y1, x2, y2, materialId] or [x1, y1, x2, y2, materialId, z0, z1] with |coordinates| <= 1000`);
      if (!known.has(w[4])) return err(`walls[${i}]: unknown material "${w[4]}"`);
      const wall: Wall = { a: [w[0], w[1]], b: [w[2], w[3]], mat: w[4] };
      if (w.length === 7) {
        const [z0, z1] = [w[5], w[6]];
        if (!isNum(z0) || !isNum(z1) || z0 < 0 || z0 >= z1) return err(`walls[${i}]: heights must be numbers with 0 <= z0 < z1`);
        if (isNum(height) && z0 >= height) return err(`walls[${i}]: z0 must be below the room height`);
        // Clamped to the room; a wall that spans it all is a plain wall again.
        walls.push(isNum(height) ? normalizeWallZ({ ...wall, z0, z1 }, height) : wall);
        return;
      }
      walls.push(wall);
    });

  const mat = (v: unknown, what: string) => {
    if (!isStr(v) || !known.has(v)) {
      err(`${what}: unknown material ${String(v)}`);
      return DEFAULT_MATERIAL_ID;
    }
    return v;
  };
  const floorMat = mat(o.floor, 'floor');
  const ceilMat = mat(o.ceiling, 'ceiling');
  const p3 = (v: unknown, what: string): P3 => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) {
      err(`${what} must be [x, y, z]`);
      return [0, 0, 1];
    }
    return [v[0], v[1], v[2]];
  };
  const listener = p3(o.listener, 'listener');
  const sources: Source[] = [];
  if (o.version === 1) {
    sources.push({ ...makeSource(0, p3(o.source, 'source')), directivity: 'omni' });
  } else if (!Array.isArray(o.sources) || o.sources.length < 1 || o.sources.length > MAX_SOURCES) {
    err(`sources must be an array of 1 to ${MAX_SOURCES} entries`);
  } else {
    o.sources.forEach((raw: unknown, i: number) => {
      const x = raw as Record<string, unknown>;
      if (typeof x !== 'object' || x === null || !isStr(x.id)) return err(`sources[${i}]: needs an id`);
      if (sources.some((q) => q.id === x.id)) return err(`sources[${i}]: duplicate id "${x.id}"`);
      if (!SIGNAL_KINDS.includes(x.signal as SignalKind)) return err(`sources[${i}]: unknown signal "${String(x.signal)}"`);
      if (!isNum(x.gain) || x.gain < 0 || x.gain > 4) return err(`sources[${i}]: gain must be in [0, 4]`);
      // `eq` is optional (scenes saved before the equalizer existed are flat); out-of-range values are clamped.
      const eq: Eq = { ...FLAT_EQ };
      if (x.eq !== undefined) {
        const e = x.eq as Record<string, unknown>;
        if (typeof e !== 'object' || e === null) return err(`sources[${i}]: eq must be an object`);
        for (const b of EQ_BANDS) {
          const v = e[b.id];
          if (v === undefined) continue;
          if (!isNum(v) || v < -24 || v > 24) return err(`sources[${i}]: eq.${b.id} must be in [-24, 24] dB`);
          eq[b.id] = Math.min(Math.max(v, EQ_MIN_DB), EQ_MAX_DB);
        }
      }
      // `stereo` / `width` / `angle` are optional (older files: pair on, 2 m, facing +x).
      if (x.stereo !== undefined && typeof x.stereo !== 'boolean') return err(`sources[${i}]: stereo must be true or false`);
      if (x.width !== undefined && (!isNum(x.width) || x.width < MIN_WIDTH || x.width > MAX_WIDTH)) return err(`sources[${i}]: width must be in [${MIN_WIDTH}, ${MAX_WIDTH}] m`);
      if (x.angle !== undefined && !isNum(x.angle)) return err(`sources[${i}]: angle must be a number`);
      // `directivity` is optional: older files had omnidirectional sources.
      if (x.directivity !== undefined && !DIRECTIVITIES.includes(x.directivity as Directivity)) return err(`sources[${i}]: unknown directivity "${String(x.directivity)}"`);
      sources.push({
        id: x.id,
        name: typeof x.name === 'string' ? x.name.slice(0, 40) : `Source ${i + 1}`,
        pos: p3(x.pos, `sources[${i}].pos`),
        color: isStr(x.color) ? x.color : SOURCE_COLORS[i % SOURCE_COLORS.length],
        gain: x.gain,
        muted: x.muted === true,
        solo: x.solo === true,
        signal: x.signal as SignalKind,
        eq,
        stereo: x.stereo !== false,
        width: x.width === undefined ? DEFAULT_WIDTH : (x.width as number),
        angle: x.angle === undefined ? 0 : (x.angle as number),
        directivity: x.directivity === undefined ? 'omni' : (x.directivity as Directivity),
      });
    });
  }
  // Older files have no surface detail: they get the default, like new scenes.
  const detail = o.detail === undefined ? DEFAULT_DETAIL : o.detail;
  if (!isNum(detail) || detail < 0 || detail > MAX_DETAIL) err(`detail must be a number in [0, ${MAX_DETAIL}]`);
  if (!isNum(o.yaw)) err('yaw must be a number');
  if (errors.length) return { scene: null, errors };
  const h = height as number;
  const clampZ = (p: P3): P3 => [p[0], p[1], Math.min(Math.max(p[2], 0.05), h - 0.05)];
  return {
    scene: {
      name: typeof o.name === 'string' ? o.name.slice(0, 80) : 'Untitled',
      height: h,
      walls,
      materials,
      floorMat,
      ceilMat,
      detail: detail as number,
      sources: sources.map((x) => ({ ...x, pos: clampZ(x.pos) })),
      listener: clampZ(listener),
      yaw: o.yaw as number,
    },
    errors,
  };
}

// ---------------------------------------------------------------- share links (URL hash)

export const MAX_HASH_CHARS = 8000;

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string) => {
  const t = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(t, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const w = stream.writable.getWriter();
  void w.write(bytes as BufferSource);
  void w.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** `z.<deflate-raw base64url>` when CompressionStream exists, else `p.<plain base64url>`. */
export async function encodeSceneHash(s: Scene): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(serializeScene(s, true)));
  if (typeof CompressionStream !== 'undefined') return 'z.' + b64url(await pipe(json, new CompressionStream('deflate-raw')));
  return 'p.' + b64url(json);
}

export async function decodeSceneHash(h: string): Promise<ParseResult> {
  try {
    const [kind, body] = [h.slice(0, 1), h.slice(2)];
    let bytes: Uint8Array = unb64url(body);
    if (kind === 'z') {
      if (typeof DecompressionStream === 'undefined') return { scene: null, errors: ['This browser cannot decompress share links'] };
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    } else if (kind !== 'p') return { scene: null, errors: ['Unknown share-link encoding'] };
    return parseScene(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (e) {
    return { scene: null, errors: ['Corrupt share link: ' + String(e)] };
  }
}

// ---------------------------------------------------------------- Omnitone

/**
 * Omnitone rotation matrix (3x3 column-major, applied to the sound field in GL axes
 * x right / y up / z back) for a listener whose head is rotated by `yaw` CCW from above.
 * The sound field must be rotated by the inverse head rotation: M = Ry(-yaw).
 * Check: a source at world-left with yaw = +90 deg (head turned left) ends up in front.
 */
export function yawToRotation(yaw: number): number[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
