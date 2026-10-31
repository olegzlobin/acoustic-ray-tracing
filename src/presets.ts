import { BUILTIN_MATERIALS, cloneMaterial } from './materials';
import { facing, wrapAngle } from './stereo';
import { DEFAULT_DETAIL, makeSource, normalizeWallZ, type Pt, type Scene, type Source, type Wall } from './scene';

interface RoomSpec {
  name: string;
  height: number;
  poly: Pt[];
  walls: string | ((i: number) => string);
  floor: string;
  ceiling: string;
  source: [number, number, number];
  listener: [number, number, number];
  yaw: number;
}

function room(r: RoomSpec): Scene {
  const n = r.poly.length;
  return {
    name: r.name,
    height: r.height,
    walls: r.poly.map((a, i) => ({
      a: [...a] as Pt,
      b: [...r.poly[(i + 1) % n]] as Pt,
      mat: typeof r.walls === 'string' ? r.walls : r.walls(i),
    })),
    materials: BUILTIN_MATERIALS.map(cloneMaterial),
    floorMat: r.floor,
    ceilMat: r.ceiling,
    detail: DEFAULT_DETAIL,
    sources: [{ ...makeSource(0, r.source), angle: wrapAngle(facing(r.source, r.listener)) }],
    listener: r.listener,
    yaw: r.yaw,
  };
}

const rect = (w: number, d: number): Pt[] => [[0, 0], [w, 0], [w, d], [0, d]];

/**
 * A rectangular shell plus partitions (chains of wall segments). Partitions may end anywhere on the
 * outer walls (T-junctions are handled by the planar room analysis, see editor/rooms.ts).
 */
function partitioned(r: RoomSpec, partitions: [Pt, Pt, string][]): Scene {
  const sc = room(r);
  for (const [a, b, mat] of partitions) sc.walls.push({ a: [...a] as Pt, b: [...b] as Pt, mat });
  return sc;
}

/**
 * Free-standing piece of furniture: a closed w×d box at (x, y), an obstacle on the plan. `z0` / `z1` (m above
 * the floor) make it a low piece: a box from the floor (`z1` only) or a slab on legs (a table top).
 */
type Box = [x: number, y: number, w: number, d: number, mat: string, z0?: number, z1?: number];
const boxWalls = ([x, y, w, d, mat, z0, z1]: Box, h: number): Wall[] => {
  const mm = (v: number) => Math.round(v * 1000) / 1000; // exact in share links (1 mm grid)
  const c: Pt[] = [[mm(x), mm(y)], [mm(x + w), mm(y)], [mm(x + w), mm(y + d)], [mm(x), mm(y + d)]];
  return c.map((p, i) => normalizeWallZ({ a: [...p] as Pt, b: [...c[(i + 1) % 4]] as Pt, mat, ...(z0 !== undefined ? { z0 } : {}), ...(z1 !== undefined ? { z1 } : {}) }, h));
};
/** Adds furniture boxes; they stand 5 cm off the walls so each stays a separate obstacle. */
function furnished(sc: Scene, boxes: Box[]): Scene {
  for (const b of boxes) sc.walls.push(...boxWalls(b, sc.height));
  return sc;
}
/** A box from the floor up to `h` (sofa, cabinet, stage, pew). */
const low = (x: number, y: number, w: number, d: number, mat: string, h: number): Box => [x, y, w, d, mat, 0, h];
/** A table top: a thin slab `z0`..`z1` on legs, sound passes underneath. */
const slab = (x: number, y: number, w: number, d: number, z0 = 0.72, z1 = 0.75, mat = 'wood'): Box => [x, y, w, d, mat, z0, z1];
const sofa = (x: number, y: number, w = 2.2, d = 0.9): Box => low(x, y, w, d, 'upholstery', 0.85);
/** Square columns of side `s` centred on the given points. */
const columns = (pts: Pt[], s: number, mat: string): Box[] => pts.map(([x, y]) => [x - s / 2, y - s / 2, s, s, mat]);

export interface Preset {
  /** Stable key of the localized name (`preset.<id>` in src/locales). */
  id: string;
  /** English name (the localized one is shown in the UI). */
  name: string;
  make: () => Scene;
}

export const PRESETS: Preset[] = [
  {
    id: 'living',
    name: 'Living room 10×7 m',
    make: () =>
      furnished(
        room({ name: 'Living room 10×7 m', height: 3, poly: rect(10, 7), walls: 'plaster', floor: 'wood', ceiling: 'plaster', source: [2.5, 3.5, 1.5], listener: [7, 3.5, 1.2], yaw: Math.PI }),
        [
          low(0.5, 6.55, 3, 0.4, 'books', 2), // bookshelf, north wall
          low(7.5, 6.35, 2, 0.6, 'wood', 2.2), // wardrobe
          low(4, 0.05, 2.5, 0.35, 'books', 2), // bookshelf, south wall
          low(0.05, 0.6, 0.45, 1.2, 'wood', 1.2), // cabinet behind the speaker
          low(7, 0.05, 2.2, 0.45, 'wood', 0.6), // TV unit
          low(4.5, 6.5, 1, 0.45, 'glass', 1.8), // glass display cabinet
          sofa(8.55, 2.4, 0.9, 2.2), // sofa behind the listener
          low(6, 5.2, 0.9, 0.9, 'upholstery', 0.85), // armchair
          slab(5.2, 3.2, 1.1, 0.6, 0.4, 0.45), // coffee table, below the line of sight
          [9.85, 1, 0.1, 2, 'drape'], // curtains, east windows
          [9.85, 4, 0.1, 2, 'drape'],
        ],
      ),
  },
  {
    id: 'shoebox',
    name: 'Empty shoebox 10×7 m (reference)',
    make: () => room({ name: 'Empty shoebox 10×7 m', height: 3, poly: rect(10, 7), walls: 'plaster', floor: 'wood', ceiling: 'plaster', source: [2.5, 3.5, 1.5], listener: [7, 3.5, 1.2], yaw: Math.PI }),
  },
  {
    id: 'lshape',
    name: 'L-shaped room',
    make: () =>
      furnished(
        room({
          name: 'L-shaped room',
          height: 3,
          poly: [[0, 0], [12, 0], [12, 5], [5, 5], [5, 12], [0, 12]],
          walls: 'plaster',
          floor: 'wood',
          ceiling: 'plaster',
          source: [9.5, 2.5, 1.5],
          listener: [2.5, 9.5, 1.2],
          yaw: 0,
        }),
        [
          [0.05, 2, 0.4, 3, 'books'],
          [8, 4.35, 2.5, 0.6, 'wood'],
          [4.55, 8, 0.4, 2.5, 'books'],
          [0.05, 6, 0.4, 2, 'books'],
          [0.6, 11.35, 1.8, 0.6, 'wood'], // wardrobe
          [11.35, 0.6, 0.6, 2, 'wood'], // kitchen cabinets
          [6, 0.05, 2.5, 0.1, 'drape'], // curtains
          sofa(1.2, 0.6),
          slab(1.6, 2, 1.1, 0.5, 0.4, 0.45), // coffee table
          slab(1.8, 6.3, 1.4, 0.9), // dining table
        ],
      ),
  },
  {
    id: 'corridor',
    name: 'Long corridor',
    make: () =>
      furnished(
        room({ name: 'Long corridor', height: 2.8, poly: rect(24, 2.5), walls: 'plaster', floor: 'wood', ceiling: 'plaster', source: [3, 1.25, 1.5], listener: [20, 1.25, 1.2], yaw: Math.PI }),
        [
          [9, 0.05, 1.2, 0.4, 'wood'], // shoe cabinet
          [14, 2.05, 2, 0.4, 'books'],
          [0.6, 2, 1.5, 0.45, 'wood'], // coat wardrobe by the door
          [11.5, 2.1, 0.8, 0.35, 'glass'], // mirror cabinet
          [18, 0.05, 1, 0.35, 'wood'],
        ],
      ),
  },
  {
    id: 'bathroom',
    name: 'Tiled bathroom',
    make: () =>
      furnished(
        room({ name: 'Tiled bathroom', height: 2.4, poly: rect(3, 2.2), walls: 'tiles', floor: 'tiles', ceiling: 'plaster', source: [0.7, 0.7, 1.3], listener: [2.3, 1.5, 1.5], yaw: Math.PI }),
        [
          [2.2, 0.05, 0.75, 0.4, 'wood'], // cabinet
          [0.05, 1.5, 0.9, 0.65, 'glass'], // shower enclosure
          [1.4, 2.05, 0.6, 0.1, 'drape'], // towels
        ],
      ),
  },
  {
    id: 'studio',
    name: 'Recording studio (treated)',
    make: () =>
      furnished(
        room({
          name: 'Recording studio (treated)',
          height: 2.8,
          poly: rect(6, 4.5),
          // edges: south, east, north, west
          walls: (i) => ['panel', 'drape', 'panel', 'wood'][i],
          floor: 'carpet',
          ceiling: 'panel',
          source: [1.5, 2.25, 1.4],
          listener: [4.2, 2.25, 1.2],
          yaw: Math.PI,
        }),
        [
          [5.6, 1.25, 0.35, 2, 'diffuser'], // rear wall diffuser
          ...columns([[0.3, 0.3], [5.7, 0.3], [0.3, 4.2], [5.7, 4.2]], 0.45, 'panel'), // corner bass traps
          [0.05, 1.5, 0.3, 1.5, 'diffuser'], // front wall diffuser
          [2.5, 4.05, 1.2, 0.4, 'wood'], // equipment rack
          slab(3.2, 1.35, 0.8, 1.8, 0.75, 0.8), // mixing desk in front of the listener, below ear height
        ],
      ),
  },
  {
    id: 'classroom',
    name: 'Classroom',
    make: () =>
      furnished(
        room({
          name: 'Classroom',
          height: 3.2,
          poly: rect(9, 7),
          walls: (i) => (i === 0 ? 'glass' : 'plaster'),
          floor: 'tiles',
          ceiling: 'plaster',
          source: [1.5, 3.5, 1.6],
          listener: [6.5, 3.5, 1.1],
          yaw: Math.PI,
        }),
        [
          [8.5, 0.8, 0.45, 2.2, 'wood'], // cabinets, back wall
          [8.55, 4.2, 0.4, 2.2, 'books'],
          [3, 6.55, 2.5, 0.4, 'books'],
          low(0.05, 5.5, 0.5, 1.2, 'wood', 1.8), // teacher's cabinet
          ...[3, 4.6, 6.2].flatMap((x) => [1, 2, 4.4, 5.4].map((y) => slab(x, y, 1.2, 0.6))), // 3 columns × 4 rows of desks; the aisle (y = 2.6 .. 4.4) stays free
          slab(0.6, 4.6, 1.4, 0.7), // teacher's desk
          [1, 0.05, 1.5, 0.1, 'drape'], // curtains on the window wall
          [4, 0.05, 1.5, 0.1, 'drape'],
          [6.5, 0.05, 1.5, 0.1, 'drape'],
        ],
      ),
  },
  {
    id: 'concert',
    name: 'Concert hall 40×25×18 m',
    make: () =>
      furnished(
        room({
          name: 'Concert hall 40×25×18 m',
          height: 18,
          poly: rect(40, 25),
          walls: (i) => (i === 3 ? 'wood' : 'plaster'),
          floor: 'seats',
          ceiling: 'plaster',
          source: [5, 12.5, 0.8 + 1.5],
          listener: [25, 12.5, 1.2],
          yaw: Math.PI,
        }),
        // pilasters along the side walls scatter the lateral reflections
        [
          ...columns([10, 16, 22, 28, 34].flatMap((x): Pt[] => [[x, 0.5], [x, 24.5]]), 0.6, 'plaster'),
          low(0.1, 8, 8.5, 9, 'wood', 0.8), // stage; the source stands on it
          // stage-shell side reflectors
          [2, 4, 0.4, 3, 'wood'],
          [2, 18, 0.4, 3, 'wood'],
        ],
      ),
  },
  {
    id: 'cathedral',
    name: 'Cathedral (cruciform, stone)',
    make: () =>
      furnished(
        room({
          name: 'Cathedral (cruciform, stone)',
          height: 25,
          poly: [[0, 9], [40, 9], [40, 0], [52, 0], [52, 9], [70, 9], [70, 21], [52, 21], [52, 30], [40, 30], [40, 21], [0, 21]],
          walls: 'stone',
          floor: 'marble',
          ceiling: 'stone',
          source: [6, 15, 1.6],
          listener: [30, 15, 1.6],
          yaw: Math.PI,
        }),
        // nave arcades
        [
          ...columns([8, 14, 20, 26, 32].flatMap((x): Pt[] => [[x, 12], [x, 18]]), 1.2, 'stone'),
          [0.05, 12, 1.5, 6, 'wood'], // organ case
          [10, 9.05, 2, 1.2, 'wood'], // confessionals in the aisles
          [10, 19.8, 2, 1.15, 'wood'],
          // pews: two blocks of rows either side of the central aisle (y = 14 .. 16 stays free)
          ...Array.from({ length: 14 }, (_, k) => 11 + 1.9 * k).flatMap((x) => [low(x, 12.7, 0.5, 1.3, 'wood', 0.9), low(x, 16, 0.5, 1.3, 'wood', 0.9)]),
        ],
      ),
  },
  {
    id: 'irregular',
    name: 'Irregular non-convex room',
    make: () =>
      furnished(
        room({
          name: 'Irregular non-convex room',
          height: 3,
          poly: [[0, 0], [8, 0], [8, 3], [11, 3], [11, 8], [6, 8], [6, 5], [3, 5], [3, 9], [0, 9]],
          walls: (i) => (i % 3 === 0 ? 'brick' : 'plaster'),
          floor: 'carpet',
          ceiling: 'plaster',
          source: [1.5, 1.5, 1.5],
          listener: [9, 6, 1.2],
          yaw: Math.PI,
        }),
        [
          [0.05, 5.5, 0.6, 2.5, 'wood'], // wardrobe
          [4, 0.05, 3, 0.4, 'books'],
          [10.55, 4, 0.4, 2.5, 'books'],
          [0.05, 3, 0.6, 1.2, 'wood'],
          [3.5, 4.55, 2, 0.4, 'wood'], // cabinet in the notch
          [7, 7.85, 2.5, 0.1, 'drape'], // curtains
          sofa(4, 1.2),
          slab(6.8, 4, 1.2, 0.8),
        ],
      ),
  },
  {
    id: 'tworooms',
    name: 'Two rooms + doorway',
    make: () =>
      furnished(
        partitioned(
          { name: 'Two rooms + doorway', height: 2.8, poly: rect(10, 5), walls: 'brick', floor: 'furnished', ceiling: 'plaster', source: [2.5, 3.5, 1.5], listener: [7.5, 3.5, 1.2], yaw: Math.PI },
          // drywall partition at x = 5 with a 1 m doorway gap at y = 1..2
          [[[5, 0], [5, 1], 'drywall'], [[5, 2], [5, 5], 'drywall']],
        ),
        [
          [0.5, 4.55, 2.5, 0.4, 'books'],
          [7, 4.35, 2.5, 0.6, 'wood'],
          [1, 0.05, 2, 0.45, 'wood'],
          [6, 0.05, 2.5, 0.4, 'books'],
          [0.05, 1, 0.1, 2, 'drape'], // curtains
          sofa(1.2, 0.7),
          slab(7, 1, 1.2, 0.8),
        ],
      ),
  },
  {
    id: 'apartment',
    name: 'Apartment (3 rooms, doors)',
    make: () =>
      furnished(
        partitioned(
          { name: 'Apartment (3 rooms, doors)', height: 2.6, poly: rect(10, 7), walls: 'brick', floor: 'wood', ceiling: 'plaster', source: [2.5, 3.5, 1.5], listener: [8, 5.9, 1.2], yaw: Math.PI },
          [
            // living room (x < 6) | kitchen (x > 6, y < 4.5) and bedroom (x > 6, y > 4.5); closed doors are wood segments
            [[6, 0], [6, 1.2], 'drywall'],
            [[6, 1.2], [6, 2.1], 'door'],
            [[6, 2.1], [6, 7], 'drywall'],
            [[6, 4.5], [7.3, 4.5], 'drywall'],
            [[7.3, 4.5], [8.2, 4.5], 'door'],
            [[8.2, 4.5], [10, 4.5], 'drywall'],
          ],
        ),
        [
          low(0.5, 6.55, 3, 0.4, 'books', 2), // living room bookshelf
          low(7, 0.05, 2.9, 0.6, 'wood', 0.9), // kitchen cabinets
          low(8.5, 6.35, 1.4, 0.6, 'wood', 2.2), // bedroom wardrobe
          low(0.05, 2.5, 0.45, 2, 'wood', 0.6), // TV wall unit
          [1, 0.05, 3, 0.1, 'drape'], // living room curtains
          low(9.3, 1.5, 0.65, 0.7, 'wood', 1.8), // fridge
          sofa(2, 0.6), // living room sofa
          slab(2.6, 1.9, 1, 0.5, 0.4, 0.45), // coffee table
          slab(7.2, 2.4, 1.2, 0.8), // kitchen table
          low(6.15, 4.9, 1.6, 2, 'upholstery', 0.55), // bed
          [9.85, 4.8, 0.1, 1.2, 'drape'], // bedroom curtains
        ],
      ),
  },
  {
    id: 'curtain',
    name: 'Curtain-divided room',
    make: () =>
      furnished(
        partitioned(
          { name: 'Curtain-divided room', height: 3, poly: rect(8, 5), walls: 'plaster', floor: 'carpet', ceiling: 'plaster', source: [2, 2, 1.5], listener: [6.5, 2, 1.2], yaw: Math.PI },
          // heavy drape across the room at x = 4.5, open at the far end (y = 3.8..5)
          [[[4.5, 0], [4.5, 3.8], 'drape']],
        ),
        [
          [0.5, 4.55, 3, 0.4, 'books'],
          [6, 4.35, 1.8, 0.6, 'wood'], // wardrobe
          [0.05, 0.5, 0.45, 1.2, 'wood'],
          [5.5, 0.05, 2, 0.4, 'books'],
          sofa(1, 3.4),
          slab(5.2, 2.9, 1.2, 0.8),
        ],
      ),
  },
];

// ---------------------------------------------------------------- keeping the sources on a room change

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
/** Proper intersection of segments pq and ab (touching counts, so a path along a wall is blocked). */
function segmentsMeet(p: Pt, q: Pt, a: Pt, b: Pt): boolean {
  const d1 = cross(a, b, p), d2 = cross(a, b, q), d3 = cross(p, q, a), d4 = cross(p, q, b);
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0);
}
function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * The user's sources moved into a freshly loaded room: same ids (so audio files and channels stay),
 * names, signals, levels, EQ and facing angle. The first one takes the preset's source position; the others stand
 * around it, at the first free spot that is in sight of it (no wall in between, so not behind a
 * partition or inside furniture), 0.5 m from walls (0.3 m in cramped rooms), the listener and each other.
 */
export function carrySources(old: Source[], sc: Scene): Source[] {
  const home = sc.sources[0].pos;
  const lis: Pt = [sc.listener[0], sc.listener[1]];
  const zOf = (z: number) => Math.min(Math.max(z, 0.05), sc.height - 0.1);
  const placed: Pt[] = [[home[0], home[1]]];
  const free = (p: Pt, clear: number) =>
    sc.walls.every((w) => distToSegment(p, w.a, w.b) >= clear && !segmentsMeet(placed[0], p, w.a, w.b)) &&
    Math.hypot(p[0] - lis[0], p[1] - lis[1]) >= 0.5 &&
    placed.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.5);
  return old.map((s, i) => {
    let p: Pt = placed[0];
    if (i > 0) {
      // small rooms (a bathroom with a shower) get a second, tighter pass
      search: for (const clear of [0.5, 0.3])
        for (const r of [1, 1.5, 0.7, 2, 0.5]) {
          for (let k = 0; k < 8; k++) {
            const a = (k * Math.PI) / 4 + Math.PI / 2; // above, then around
            const c: Pt = [home[0] + r * Math.cos(a), home[1] + r * Math.sin(a)];
            if (free(c, clear)) {
              p = c;
              break search;
            }
          }
        }
      placed.push(p);
    }
    return { ...s, eq: { ...s.eq }, pos: [p[0], p[1], zOf(s.pos[2])] };
  });
}
