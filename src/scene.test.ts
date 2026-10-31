import { describe, expect, it } from 'vitest';
import { MATERIAL_STRIDE, WALL_STRIDE } from './layout';
import { PRESETS } from './presets';
import { BUILTIN_MATERIALS, DEFAULT_TL, alphaRaised, builtinById, tlToTau } from './materials';
import { DEFAULT_DETAIL, makeSource } from './scene';
import { decodeSceneHash, encodeSceneHash, MAX_HASH_CHARS, parseScene, serializeScene, toWorkerScene, yawToRotation } from './scene';
import { isFlat } from './audio/eq';
import { splitIR } from './audio/split';
import { rotateFoaToListener } from './audio/foa';

const scene = () => PRESETS[1].make();

describe('scene serialization', () => {
  it('round-trips through JSON (full form)', () => {
    const s = scene();
    const r = parseScene(JSON.parse(JSON.stringify(serializeScene(s))));
    expect(r.errors).toEqual([]);
    expect(r.scene!.walls).toEqual(s.walls);
    expect(r.scene!.floorMat).toBe(s.floorMat);
    expect(r.scene!.sources).toEqual(s.sources);
    expect(r.scene!.materials.find((m) => m.id === 'wood')!.alpha).toEqual(s.materials.find((m) => m.id === 'wood')!.alpha);
  });
  it('keeps custom materials and omits library ones in compact form', () => {
    const s = scene();
    s.materials.push({ id: 'c1', name: 'Mine', alpha: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], s: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2], tl: [10, 20, 30, 40, 50, 60], color: '#123456' });
    s.walls[0].mat = 'c1';
    const c = serializeScene(s, true);
    expect(c.materials.map((m) => m.id)).toEqual(['c1']);
    const r = parseScene(c);
    expect(r.errors).toEqual([]);
    expect(r.scene!.walls[0].mat).toBe('c1');
    expect(r.scene!.materials.find((m) => m.id === 'c1')!.tl).toEqual([10, 20, 30, 40, 50, 60]);
    expect(r.scene!.materials.some((m) => m.id === 'concrete')).toBe(true);
  });
  it('rejects invalid files with readable errors', () => {
    expect(parseScene(null).scene).toBeNull();
    const base = JSON.parse(JSON.stringify(serializeScene(scene())));
    const bad = (mut: (o: Record<string, unknown>) => void) => {
      const o = JSON.parse(JSON.stringify(base));
      mut(o);
      return parseScene(o);
    };
    expect(bad((o) => (o.format = 'x')).errors.join()).toMatch(/format/);
    expect(bad((o) => (o.version = 99)).errors.join()).toMatch(/version/);
    expect(bad((o) => (o.height = -1)).errors.join()).toMatch(/height/);
    expect(bad((o) => (o.walls = [[0, 0, 1]])).errors.join()).toMatch(/walls\[0\]/);
    expect(bad((o) => ((o.walls as unknown[][])[0][4] = 'nope')).errors.join()).toMatch(/unknown material/);
    expect(bad((o) => (o.materials = [{ id: 'z', name: 'z', alpha: [0, 1, 1, 1, 1, 1], s: 0 }])).errors.join()).toMatch(/alpha/);
    expect(bad((o) => (o.yaw = 'a')).errors.join()).toMatch(/yaw/);
    expect(bad((o) => (o.materials = [{ id: 'z', name: 'z', alpha: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1], s: 0, tl: [1, 2, 3] }])).errors.join()).toMatch(/tl/);
    expect(bad((o) => ((o.sources as unknown[]).length = 0)).errors.join()).toMatch(/sources/);
    expect(bad((o) => ((o.sources as { signal: string }[])[0].signal = 'x')).errors.join()).toMatch(/signal/);
  });
  it('round-trips a share-link hash and stays small', async () => {
    const s = scene();
    const h = await encodeSceneHash(s);
    expect(h.length).toBeLessThan(MAX_HASH_CHARS);
    const r = await decodeSceneHash(h);
    expect(r.errors).toEqual([]);
    expect(r.scene!.walls).toEqual(s.walls);
    expect(r.scene!.listener).toEqual(s.listener);
    expect(r.scene!.sources).toEqual(s.sources);
    expect((await decodeSceneHash('z.@@@')).scene).toBeNull();
    expect((await decodeSceneHash('q.AAAA')).scene).toBeNull();
  });
  it('packs for the worker with material indices', () => {
    const s = scene();
    s.walls[2].mat = 'carpet';
    const w = toWorkerScene(s);
    const carpetIdx = s.materials.findIndex((m) => m.id === 'carpet');
    expect(w.walls[2 * WALL_STRIDE + 4]).toBe(carpetIdx);
    expect(w.walls).toHaveLength(s.walls.length * WALL_STRIDE);
    expect(w.materials).toHaveLength(s.materials.length * MATERIAL_STRIDE);
    expect(w.transmission).toBe(true);
    expect(toWorkerScene(s, false).transmission).toBe(false);
    const i = s.materials.findIndex((m) => m.id === 'drywall');
    expect([...w.materials.slice((i + 1) * MATERIAL_STRIDE - 6, (i + 1) * MATERIAL_STRIDE)]).toEqual(builtinById('drywall')!.tl);
    expect(w.floorMat).toBe(s.materials.findIndex((m) => m.id === s.floorMat));
  });
  it('all presets are valid scenes', () => {
    for (const p of PRESETS) expect(parseScene(serializeScene(p.make())).errors).toEqual([]);
  });
});

describe('surface detail', () => {
  it('adds absorption to every surface when packing, never above 1', () => {
    const s = PRESETS[0].make();
    s.detail = 0.1;
    const m = toWorkerScene(s).materials;
    const a0 = s.materials[0].alpha[0];
    expect(m[0]).toBeCloseTo(1 - (1 - a0) * 0.9, 5);
    s.materials[0].alpha[0] = 1;
    expect(toWorkerScene(s).materials[0]).toBeCloseTo(1, 6);
  });
  it('round-trips and defaults for files without it', () => {
    const s = PRESETS[0].make();
    s.detail = 0.12;
    expect(parseScene(JSON.parse(JSON.stringify(serializeScene(s)))).scene!.detail).toBeCloseTo(0.12);
    const old = JSON.parse(JSON.stringify(serializeScene(s)));
    delete old.detail;
    expect(parseScene(old).scene!.detail).toBe(DEFAULT_DETAIL);
    expect(parseScene({ ...old, detail: 0.9 }).errors.join()).toMatch(/detail/);
  });
});

describe('sources and migration', () => {
  it('round-trips several sources with their settings', () => {
    const s = scene();
    s.sources.push({ ...makeSource(1, [3, 3, 1.2], new Set(['s1'])), gain: 0.5, muted: true, solo: false });
    const r = parseScene(JSON.parse(JSON.stringify(serializeScene(s))));
    expect(r.errors).toEqual([]);
    expect(r.scene!.sources).toHaveLength(2);
    expect(r.scene!.sources[1]).toMatchObject({ gain: 0.5, muted: true, signal: 'drums' });
    expect(s.sources[1].id).toBe('s2');
  });
  it('round-trips a non-flat eq', () => {
    const s = scene();
    s.sources[0].eq = { low: 3, lowMid: -4.5, highMid: 0, high: 12 };
    const r = parseScene(JSON.parse(JSON.stringify(serializeScene(s))));
    expect(r.errors).toEqual([]);
    expect(r.scene!.sources[0].eq).toEqual({ low: 3, lowMid: -4.5, highMid: 0, high: 12 });
  });
  it('parses an older scene without eq as flat', () => {
    const j = JSON.parse(JSON.stringify(serializeScene(scene())));
    for (const x of j.sources) delete x.eq;
    const r = parseScene(j);
    expect(r.errors).toEqual([]);
    expect(r.scene!.sources.every((x) => isFlat(x.eq))).toBe(true);
  });
  it('rejects an out-of-range eq and clamps values within +-24 dB to +-12', () => {
    const j = JSON.parse(JSON.stringify(serializeScene(scene())));
    j.sources[0].eq = { low: 30, lowMid: 0, highMid: 0, high: 0 };
    const bad = parseScene(j);
    expect(bad.scene).toBeNull();
    expect(bad.errors.join()).toContain('eq.low');
    j.sources[0].eq = { low: 18, lowMid: -20, highMid: 0, high: 0 };
    const r = parseScene(j);
    expect(r.errors).toEqual([]);
    expect(r.scene!.sources[0].eq).toMatchObject({ low: 12, lowMid: -12 });
  });
  it('round-trips stereo and width (file and compact forms)', () => {
    const s = scene();
    s.sources[0].stereo = false;
    s.sources[0].width = 3.5;
    s.sources[0].angle = 1.25;
    for (const compact of [false, true]) {
      const r = parseScene(JSON.parse(JSON.stringify(serializeScene(s, compact))));
      expect(r.errors).toEqual([]);
      expect(r.scene!.sources[0]).toMatchObject({ stereo: false, width: 3.5, angle: 1.25 });
    }
  });
  it('omits default stereo fields in the compact form and defaults them for older files', () => {
    const s = scene();
    expect(serializeScene(s, true).sources[0]).not.toHaveProperty('stereo');
    expect(serializeScene(s, false).sources[0]).toMatchObject({ stereo: true, width: 2 });
    const j = JSON.parse(JSON.stringify(serializeScene(s)));
    for (const x of j.sources) {
      delete x.stereo;
      delete x.width;
    }
    const r = parseScene(j);
    expect(r.errors).toEqual([]);
    expect(r.scene!.sources.every((x) => x.stereo === true && x.width === 2 && x.angle === 0)).toBe(true);
  });
  it('round-trips directivity (file and compact forms); share links omit omni', () => {
    const s = scene();
    s.sources[0].directivity = 'voice';
    s.sources[0].angle = 2.5;
    for (const compact of [false, true]) {
      const r = parseScene(JSON.parse(JSON.stringify(serializeScene(s, compact))));
      expect(r.errors).toEqual([]);
      expect(r.scene!.sources[0]).toMatchObject({ directivity: 'voice', angle: 2.5 });
    }
    s.sources[0].directivity = 'omni';
    expect(serializeScene(s, true).sources[0]).not.toHaveProperty('directivity');
    expect(serializeScene(s, false).sources[0]).toMatchObject({ directivity: 'omni' });
  });
  it('older files without directivity are omnidirectional', () => {
    const j = JSON.parse(JSON.stringify(serializeScene(scene())));
    for (const x of j.sources) delete x.directivity;
    const r = parseScene(j);
    expect(r.errors).toEqual([]);
    expect(r.scene!.sources.every((x) => x.directivity === 'omni')).toBe(true);
  });
  it('rejects an unknown directivity', () => {
    const j = JSON.parse(JSON.stringify(serializeScene(scene())));
    for (const v of ['cardioid', 3, null]) {
      j.sources[0].directivity = v;
      const r = parseScene(j);
      expect(r.scene).toBeNull();
      expect(r.errors.join()).toContain('directivity');
    }
  });
  it('rejects an out-of-range width and a non-boolean stereo', () => {
    const j = JSON.parse(JSON.stringify(serializeScene(scene())));
    for (const w of [0.4, 6.1, NaN, '2']) {
      j.sources[0].width = w;
      const r = parseScene(j);
      expect(r.scene).toBeNull();
      expect(r.errors.join()).toContain('width');
    }
    j.sources[0].width = 2;
    j.sources[0].stereo = 'yes';
    expect(parseScene(j).errors.join()).toContain('stereo');
  });
  it('migrates a version 1 single-source scene', () => {
    const v2 = JSON.parse(JSON.stringify(serializeScene(scene())));
    const v1 = { ...v2, version: 1, source: [2.5, 3.5, 1.5], sources: undefined };
    const r = parseScene(v1);
    expect(r.errors).toEqual([]);
    expect(r.scene!.sources).toHaveLength(1);
    expect(r.scene!.sources[0].pos).toEqual([2.5, 3.5, 1.5]);
  });
  it('limits the source count', () => {
    const o = JSON.parse(JSON.stringify(serializeScene(scene())));
    o.sources = Array.from({ length: 5 }, (_, i) => ({ ...o.sources[0], id: 's' + i }));
    expect(parseScene(o).errors.join()).toMatch(/sources/);
  });
});

describe('transmission loss data and migration v2 -> v3', () => {
  it('every library material has 6 sane TL values; new partition materials exist', () => {
    for (const m of BUILTIN_MATERIALS) {
      expect(m.tl, m.id).toHaveLength(6);
      expect(m.tl.every((t) => Number.isFinite(t) && t >= 0 && t <= 70), m.id).toBe(true);
    }
    expect(builtinById('drywall')!.tl).toEqual([15, 24, 33, 40, 44, 38]);
    expect(builtinById('concrete')!.tl).toEqual([40, 45, 52, 58, 63, 67]);
    expect(builtinById('door')).toBeDefined();
    expect(builtinById('drape')!.tl[0]).toBe(1);
    // tau = 10^(-TL/10); a drape's tau exceeds its alpha at 125 Hz, which the editor flags
    expect(tlToTau(20)).toBeCloseTo(0.01, 12);
    expect(alphaRaised(builtinById('drape')!)[0]).toBe(true);
    expect(alphaRaised(builtinById('concrete')!).some(Boolean)).toBe(false);
  });
  it('writes version 3 with tl and round-trips every library material', () => {
    const s = scene();
    s.walls.forEach((w, i) => (w.mat = BUILTIN_MATERIALS[i % BUILTIN_MATERIALS.length].id));
    const o = JSON.parse(JSON.stringify(serializeScene(s)));
    expect(o.version).toBe(3);
    expect(o.materials.every((m: { tl: number[] }) => m.tl.length === 6)).toBe(true);
    const r = parseScene(o);
    expect(r.errors).toEqual([]);
    for (const m of s.materials) expect(r.scene!.materials.find((x) => x.id === m.id)!.tl).toEqual(m.tl);
    expect(r.scene!.walls).toEqual(s.walls);
  });
  it('migrates a v2 file: library materials by id, custom ones get a flat default', () => {
    const o = JSON.parse(JSON.stringify(serializeScene(scene())));
    o.version = 2;
    o.materials = [
      { id: 'concrete', name: 'Concrete', alpha: [0.01, 0.01, 0.02, 0.02, 0.02, 0.03], s: 0.05, color: '#9aa0a6' },
      { id: 'mine', name: 'Mine', alpha: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2], s: 0.1, color: '#123456' },
    ];
    o.walls[0][4] = 'mine';
    const r = parseScene(o);
    expect(r.errors).toEqual([]);
    expect(r.scene!.materials.find((m) => m.id === 'concrete')!.tl).toEqual([40, 45, 52, 58, 63, 67]);
    expect(r.scene!.materials.find((m) => m.id === 'mine')!.tl).toEqual(new Array(6).fill(DEFAULT_TL));
    expect(DEFAULT_TL).toBe(50);
    // a v1 file (no tl either) also loads, and unlisted library materials arrive with their TL
    const v1 = { ...o, version: 1, source: [2.5, 3.5, 1.5], sources: undefined };
    expect(parseScene(v1).errors).toEqual([]);
    expect(r.scene!.materials.find((m) => m.id === 'door')!.tl).toEqual(builtinById('door')!.tl);
  });
  describe('per-band scattering', () => {
    const withS = (sv: unknown) => {
      const o = JSON.parse(JSON.stringify(serializeScene(scene())));
      o.materials = [{ id: 'mine', name: 'Mine', alpha: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2], s: sv, tl: [10, 10, 10, 10, 10, 10], color: '#123456' }];
      o.walls[0][4] = 'mine';
      return parseScene(o);
    };
    const mine = (r: ReturnType<typeof parseScene>) => r.scene!.materials.find((m) => m.id === 'mine')!;
    it('a scalar s (old files and links) becomes 6 equal bands', () => {
      const r = withS(0.3);
      expect(r.errors).toEqual([]);
      expect(mine(r).s).toEqual([0.3, 0.3, 0.3, 0.3, 0.3, 0.3]);
    });
    it('an array of 6 round-trips and a uniform one serializes as a number', () => {
      const s = scene();
      const base = { alpha: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2], tl: [10, 10, 10, 10, 10, 10], color: '#123456' };
      s.materials.push({ id: 'c1', name: 'Band', ...base, s: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] }, { id: 'c2', name: 'Flat', ...base, s: [0.25, 0.25, 0.25, 0.25, 0.25, 0.25] });
      const o = serializeScene(s, true);
      expect(o.materials.find((m) => m.id === 'c1')!.s).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
      expect(o.materials.find((m) => m.id === 'c2')!.s).toBe(0.25);
      const r = parseScene(JSON.parse(JSON.stringify(o)));
      expect(r.errors).toEqual([]);
      expect(r.scene!.materials.find((m) => m.id === 'c1')!.s).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
      expect(r.scene!.materials.find((m) => m.id === 'c2')!.s).toEqual(new Array(6).fill(0.25));
    });
    it('rejects a wrong length or out-of-range values', () => {
      for (const bad of [[0.1, 0.2], [0.1, 0.2, 0.3, 0.4, 0.5, 1.5], [0.1, 0.2, 0.3, 0.4, 0.5, -0.1], 1.2, -0.1, 'x']) {
        const r = withS(bad);
        expect(r.errors.join(), JSON.stringify(bad)).toMatch(/s must be/);
      }
    });
    it('is packed per band for the core: [alpha x6, s x6, TL x6]', () => {
      const s = scene();
      s.materials.push({ id: 'c1', name: 'Band', alpha: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2], tl: [1, 2, 3, 4, 5, 6], color: '#123456', s: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] });
      const w = toWorkerScene(s, true);
      const i = w.materials.length / MATERIAL_STRIDE - 1;
      expect(Array.from(w.materials.slice(i * MATERIAL_STRIDE + 6, i * MATERIAL_STRIDE + 12)).map((x) => +x.toFixed(2))).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
      expect(Array.from(w.materials.slice(i * MATERIAL_STRIDE + 12, i * MATERIAL_STRIDE + 18))).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });
  it('a preset scene survives the share-link round trip with TL intact', async () => {
    const s = PRESETS.find((p) => p.name.startsWith('Two rooms'))!.make();
    s.materials.push({ id: 'c9', name: 'Mine', alpha: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3], s: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1], tl: [5, 10, 15, 20, 25, 30], color: '#abcdef' });
    s.walls[0].mat = 'c9';
    const r = await decodeSceneHash(await encodeSceneHash(s));
    expect(r.errors).toEqual([]);
    expect(r.scene!.materials.find((m) => m.id === 'c9')!.tl).toEqual([5, 10, 15, 20, 25, 30]);
    expect(r.scene!.walls).toEqual(s.walls);
  });
  it('new presets use partition walls and valid materials', () => {
    for (const name of ['Two rooms', 'Apartment', 'Curtain']) {
      const p = PRESETS.find((x) => x.name.startsWith(name))!;
      const s = p.make();
      expect(s.walls.length).toBeGreaterThan(4);
      expect(s.walls.some((w) => ['drywall', 'door', 'drape'].includes(w.mat))).toBe(true);
    }
  });
});

describe('yawToRotation', () => {
  // Omnitone: v' = M v for GL axes (x right, y up, z back), M column-major.
  const apply = (m: number[], v: number[]) => [0, 1, 2].map((r) => m[r] * v[0] + m[3 + r] * v[1] + m[6 + r] * v[2]);
  it('is identity at yaw 0 and orthonormal', () => {
    expect(yawToRotation(0).map((v) => v + 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const r = apply(yawToRotation(0.7), [0.3, 0.4, 0.5]);
    expect(Math.hypot(...r)).toBeCloseTo(Math.hypot(0.3, 0.4, 0.5), 9);
  });
  it('turning the head left by 90 deg moves a left source to the front', () => {
    const left = [-1, 0, 0]; // GL: left = -x
    const r = apply(yawToRotation(Math.PI / 2), left);
    expect(r[0]).toBeCloseTo(0, 9);
    expect(r[2]).toBeCloseTo(-1, 9); // front = -z in GL
  });
});

describe('splitIR', () => {
  it('early + late reproduces the full IR exactly, late starts as zeros', () => {
    const fs = 48000;
    const n = 30000;
    const ir = [0, 1, 2, 3].map((c) => Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.013 * (c + 1)) + 0.2));
    const { early, late } = splitIR(ir, fs, 0.12, true);
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < n; i++) {
        const e = i < early[c].length ? early[c][i] : 0;
        expect(Math.abs(e + late![c][i] - ir[c][i])).toBeLessThan(1e-6);
      }
    }
    expect(late![0].subarray(0, Math.round(0.105 * fs)).every((v) => v === 0)).toBe(true);
    expect(early[0].length).toBe(Math.ceil(0.12 * fs));
    expect(splitIR(ir, fs, 0.12, false).late).toBeNull();
  });
});

describe('rotateFoaToListener', () => {
  it('a world-left source ends up in front for a head turned 90 deg left', () => {
    // one plane wave from world +y (left): W=1, Y=1, Z=0, X=0
    const ir = [1, 1, 0, 0].map((v) => Float32Array.from([v]));
    const [w, y, z, x] = rotateFoaToListener(ir, Math.PI / 2);
    expect(w[0]).toBe(1);
    expect(z[0]).toBe(0);
    expect(x[0]).toBeCloseTo(1, 6);
    expect(y[0]).toBeCloseTo(0, 6);
  });
  it('is the identity at yaw 0', () => {
    const ir = [0.3, 0.2, 0.1, 0.5].map((v) => Float32Array.from([v]));
    const r = rotateFoaToListener(ir, 0);
    r.forEach((ch, i) => expect(ch[0]).toBeCloseTo(ir[i][0], 6));
  });
});
