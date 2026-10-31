import { describe, expect, it } from 'vitest';
import { PRESETS } from '../presets';
import { analyzePlan } from '../test-core';
import { locateAt, obstacleInfo } from './obstacles';
import { STAMPS } from './shapes';
import { setFullHeight, setHeight } from './transform';
import { addPolyline } from './geometry';
import type { Wall } from '../scene';

const roomWith = (z0?: number, z1?: number) => {
  const sc = PRESETS[1].make();
  const n = sc.walls.length;
  sc.walls = addPolyline(sc.walls, [[2, 2], [3.2, 2], [3.2, 2.8], [2, 2.8]], true, 'wood').map((w, i): Wall => (i >= n ? { ...w, ...(z0 !== undefined ? { z0 } : {}), ...(z1 !== undefined ? { z1 } : {}) } : w));
  return { sc, ids: [n, n + 1, n + 2, n + 3] };
};

describe('obstacle heights', () => {
  it('a slab and a box are described, a full-height pillar is not', () => {
    const slab = roomWith(0.72, 0.75);
    const [o] = obstacleInfo(analyzePlan(slab.sc.walls), slab.sc.walls, slab.sc.height);
    expect([o.z0, o.z1]).toEqual([0.72, 0.75]);
    expect(o.centroid[0]).toBeCloseTo(2.6, 3);
    const box = roomWith(undefined, 0.85);
    expect(obstacleInfo(analyzePlan(box.sc.walls), box.sc.walls, box.sc.height).map((x) => [x.z0, x.z1])).toEqual([[0, 0.85]]);
    const pillar = roomWith();
    expect(obstacleInfo(analyzePlan(pillar.sc.walls), pillar.sc.walls, pillar.sc.height)).toEqual([]);
  });
  it('a point above the top of a low obstacle is in the room, inside it is not', () => {
    const { sc } = roomWith(undefined, 0.8);
    const plan = analyzePlan(sc.walls);
    const obs = obstacleInfo(plan, sc.walls, sc.height);
    expect(locateAt(plan, obs, [2.6, 2.4], 0.4)).toBe('obstacle');
    expect(locateAt(plan, obs, [2.6, 2.4], 2.3)).toBe('room');
    expect(locateAt(plan, obs, [5, 5], 0.4)).toBe('room');
  });
});

describe('height of a selection', () => {
  it('validates 0 <= z0 < z1 <= room height and keeps defaults unset', () => {
    const { sc, ids } = roomWith();
    const w = sc.walls;
    expect(setHeight(w, ids, 0.72, 0.75, 3)!.slice(-4).every((x) => x.z0 === 0.72 && x.z1 === 0.75)).toBe(true);
    const top = setHeight(w, ids, undefined, 0.9, 3)!;
    expect(top.at(-1)!.z1).toBe(0.9);
    expect('z0' in top.at(-1)!).toBe(false);
    expect(setHeight(w, ids, 0.8, 0.8, 3)).toBeNull();
    expect(setHeight(w, ids, -0.1, 1, 3)).toBeNull();
    expect(setHeight(w, ids, 0, 3.5, 3)).toBeNull();
    expect(setHeight(w, ids, 2, undefined, 3)!.at(-1)!.z0).toBe(2);
    expect(setHeight(w, ids, 0, 3, 3)!.at(-1)).toEqual(w.at(-1));
    expect(setFullHeight(top, ids).at(-1)).toEqual(w.at(-1));
  });
});

describe('stamps', () => {
  it('furniture stamps carry heights; the stage is 0.8 m', () => {
    const by = Object.fromEntries(STAMPS.map((s) => [s.id, s]));
    expect([by.stage.z0, by.stage.z1]).toEqual([undefined, 0.8]);
    expect([by.table.z0, by.table.z1]).toEqual([0.72, 0.75]);
    expect(by.sofa.mat).toBe('upholstery');
    expect(by.bed.z1).toBe(0.55);
    expect([by.column.z0, by.column.z1]).toEqual([undefined, undefined]);
  });
});
